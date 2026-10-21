#!/usr/bin/env python3
"""Prepare variable-lobby humor ranking examples for local XGBoost/JavaScript.

Inputs are playable word bags, ordered answer TOKENS and prompt tokens masked to
<UNK> when missing from the corresponding author's bag. Output is one JSONL
ranking task per round with all lobby_size candidates (minimum 3).
The target is the final round ranking from aggregated game scores, including ties.

Only training mode contains human ranking labels. An inference record never
contains votes or scores. All feature transforms have a matching implementation
embedded by tune_humor_xgboost.py into the exported JavaScript runtime.

Usage:
  pip install json5                    # only needed for Mongo shell-style exports
  python preprocess_humor_local.py --game games.json --output rankings.jsonl
  python preprocess_humor_local.py --game games.json --mode predict --output unvoted.jsonl
"""
from __future__ import annotations

import argparse
from collections import Counter
import json
from pathlib import Path
import re
from typing import Iterable

# Token convention mirrored in generated JS: Unicode letters/digits, with an
# optional INTERNAL apostrophe. Punctuation/whitespace is not a model token.
PROMPT_RE = re.compile(r"[^\W_]+(?:['’][^\W_]+)?", flags=re.UNICODE)
MIN_RANK_ITEMS = 3


def prompt_tokens(text: str) -> list[str]:
    return PROMPT_RE.findall(text.lower())


def bag_tokens(words: Iterable[str]) -> list[str]:
    normalized: list[str] = []
    for word in words:
        if not isinstance(word, str) or not word or any(c.isspace() for c in word):
            raise ValueError(f"Invalid playable word: {word!r}")
        normalized.append(word.lower())
    return normalized


def mask_prompt(prompt: str, available: Iterable[str]) -> list[str]:
    bag = set(bag_tokens(available))
    return [token if token in bag else "<UNK>" for token in prompt_tokens(prompt)]


def validate_answer(answer: Iterable[str], available: Iterable[str]) -> list[str]:
    words = bag_tokens(answer)
    remaining = Counter(bag_tokens(available))
    invalid = Counter(words) - remaining
    if invalid:
        raise ValueError(f"Answer used unavailable/exhausted word tiles: {dict(invalid)}")
    return words


def ngrams(tokens: list[str], max_order: int = 3) -> dict[str, list[list[str]]]:
    if max_order < 1:
        raise ValueError("ngram_order must be positive")
    return {str(n): [tokens[i:i+n] for i in range(len(tokens)-n+1)]
            for n in range(1, max_order+1)}


def _mongo_scalar_normalize(source: str) -> str:
    """Convert simple MongoDB scalar constructors, outside quoted strings.

    Never eval shell objects. JSON5 handles the remaining unquoted keys/single
    quoted strings after safe, limited wrapper conversion.
    """
    pat = re.compile(r"(NumberInt|NumberLong|ISODate)\s*\(")
    out: list[str] = []
    i = 0
    while i < len(source):
        if source[i] in "\"'":
            quote, start = source[i], i
            i += 1
            while i < len(source):
                if source[i] == "\\":
                    i += 2
                elif source[i] == quote:
                    i += 1
                    break
                else:
                    i += 1
            else:
                raise ValueError("Unterminated quote")
            out.append(source[start:i]); continue
        match = pat.match(source, i)
        if match and (i == 0 or not (source[i-1].isalnum() or source[i-1] == "_")):
            end = source.find(")", match.end())
            if end < 0:
                raise ValueError("Unclosed Mongo scalar constructor")
            import json5
            value = json5.loads(source[match.end():end].strip())
            if match.group(1) == "ISODate":
                if not isinstance(value, str):
                    raise ValueError("ISODate expects string")
                out.append(json.dumps(value))
            else:
                if isinstance(value, bool) or not isinstance(value, (str, int)):
                    raise ValueError("NumberInt/NumberLong expects integer")
                out.append(str(int(value)))
            i = end + 1
        else:
            out.append(source[i]); i += 1
    return "".join(out)


def load_games(path: str | Path) -> list[dict]:
    src = Path(path).read_text(encoding="utf-8-sig")
    try:
        data = json.loads(src)
    except json.JSONDecodeError:
        try:
            import json5
        except ImportError as exc:
            raise RuntimeError("Install json5 for Mongo-style game dumps: pip install json5") from exc
        data = json5.loads(_mongo_scalar_normalize(src))
    games = data if isinstance(data, list) else [data]
    if not games or not all(isinstance(g, dict) for g in games):
        raise ValueError("Game file must contain one game or a list of games")
    return games


def candidate_features_for_round(game_round: dict, names: dict[str, str | None],
                                 ngram_order: int = 3) -> tuple[list[str], list[dict]]:
    """Build inference-only candidate records; never consult ballots/scores."""
    prompt = game_round.get("prompt")
    if not isinstance(prompt, str):
        raise ValueError("Round prompt must be a string")
    participants = game_round.get("playerIds") or [p["playerId"] for p in game_round.get("wordsAvailable", [])]
    if len(participants) != len(set(participants)):
        raise ValueError("Duplicate playerIds in round")
    raw_pools = game_round.get("wordsAvailable", [])
    pools = {p["playerId"]: bag_tokens(p["words"]) for p in raw_pools}
    if len(pools) != len(raw_pools):
        raise ValueError("Duplicate player word pools")
    raw_answers = game_round.get("answers", [])
    authors = [a["playerId"] for a in raw_answers]
    if len(set(authors)) != len(authors):
        raise ValueError("Multiple answers by same player")
    if set(participants) != set(pools) or set(participants) != set(authors):
        return participants, []  # incomplete round: skip, do not fabricate missing answers
    candidates = []
    for entry in raw_answers:
        player = entry["playerId"]
        answer = validate_answer(entry["words"], pools[player])
        aid = str(entry["answerId"])
        candidates.append({
            "answer_id": aid,
            "player_id": player,
            "player_name": names.get(player),
            "available_words": pools[player],
            "answer_tokens": answer,
            "masked_prompt_tokens": mask_prompt(prompt, pools[player]),
            "answer_ngrams_by_order": ngrams(answer, ngram_order),
        })
    if len({c["answer_id"] for c in candidates}) != len(candidates):
        raise ValueError("Duplicate answer IDs")
    return participants, candidates


def final_round_scores(game_round: dict, participants: list[str], candidates: list[dict],
                       strict_ballots: bool = False) -> dict[str, int] | None:
    """Use final game scores, or reproduce Game.calculateScores for older exports."""
    ids = {c["answer_id"] for c in candidates}
    own = {c["player_id"]: c["answer_id"] for c in candidates}
    stored = game_round.get("scores")
    if stored is not None:
        scores = {str(s["answerId"]): s["score"] for s in stored}
        if len(scores) != len(stored) or set(scores) != ids:
            raise ValueError("Final scores must cover every answer exactly once")
        if any(isinstance(s, bool) or not isinstance(s, int) or s < 0 for s in scores.values()):
            raise ValueError("Final scores must be nonnegative integers")
        if not strict_ballots:
            return scores

    votes = game_round.get("rankings", [])
    if not votes:
        if strict_ballots:
            raise ValueError("Incomplete voter set")
        return None
    ballots = {v["playerId"]: v.get("answerIds", []) for v in votes}
    if len(ballots) != len(votes):
        raise ValueError("Duplicate ballots by same voter")
    if not set(ballots) <= set(participants):
        raise ValueError("Unknown voter")
    if strict_ballots and set(ballots) != set(participants):
        raise ValueError("Incomplete voter set")
    computed = {c["answer_id"]: 0 for c in candidates}
    for voter, ordered in ballots.items():
        expected = ids - {own[voter]}
        if len(ordered) != len(expected) or set(ordered) != expected:
            if strict_ballots:
                raise ValueError(f"Invalid/incomplete ballot for {voter}")
            return None
        for index, aid in enumerate(ordered):
            computed[aid] += len(ordered) - index
    # The game gives zero points to authors who did not submit a ballot.
    for player in participants:
        if player not in ballots:
            computed[own[player]] = 0
    if stored is not None:
        if scores != computed:
            raise ValueError("Final scores disagree with ballots")
        return scores
    return computed


def preprocess_games(games: list[dict], *, mode: str = "train", min_rank_items: int = 3,
                     ngram_order: int = 3, strict_ballots: bool = False) -> list[dict]:
    if min_rank_items < MIN_RANK_ITEMS:
        raise ValueError("Minimum ranked candidates cannot be below 3")
    if mode not in {"train", "predict"}:
        raise ValueError("mode must be train or predict")
    records: list[dict] = []
    for game_idx, game in enumerate(games):
        state = game.get("state", game)
        game_id = str(game.get("_id", game.get("id", f"game-{game_idx}")))
        names = {p["playerId"]: p.get("name") for p in state.get("players", [])}
        for ridx, round_ in enumerate(state.get("rounds", [])):
            if mode == "train" and round_.get("status") != "completed":
                continue
            participants, candidates = candidate_features_for_round(round_, names, ngram_order)
            if len(participants) < min_rank_items or len(candidates) != len(participants):
                continue
            record = {
                "task": "humor_ranking", "ranking_scope": "round", "game_id": game_id,
                "round_number": round_.get("roundNumber", ridx + 1),
                "lobby_size": len(participants), "num_to_rank": len(candidates),
                "inputs": {"prompt": round_["prompt"], "candidates": candidates},
            }
            if mode == "train":
                scores = final_round_scores(round_, participants, candidates, strict_ballots)
                if scores is None:
                    continue
                # Dense relevance preserves final order and ties; higher is better for XGBoost.
                levels = {score: rank for rank, score in enumerate(sorted(set(scores.values())))}
                record["labels"] = {
                    "final_scores": scores,
                    "final_ranks": {aid: 1 + sum(s > score for s in scores.values())
                                    for aid, score in scores.items()},
                    "relevance_by_answer_id": {aid: levels[score] for aid, score in scores.items()},
                    "ordered_answer_ids": sorted(scores, key=lambda aid: -scores[aid]),
                }
            records.append(record)
    return records


def save_jsonl(records: list[dict], output: str | Path) -> None:
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8") as fd:
        for rec in records:
            fd.write(json.dumps(rec, ensure_ascii=False) + "\n")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--game", type=Path, required=True, help="Game JSON or Mongo-shell export")
    ap.add_argument("--output", type=Path, required=True, help="Destination JSONL")
    ap.add_argument("--mode", choices=["train", "predict"], default="train")
    ap.add_argument("--min-rank-items", type=int, default=3)
    ap.add_argument("--ngram-order", type=int, default=3)
    ap.add_argument("--strict-ballots", action="store_true")
    args = ap.parse_args()
    records = preprocess_games(load_games(args.game), mode=args.mode,
                               min_rank_items=args.min_rank_items,
                               ngram_order=args.ngram_order, strict_ballots=args.strict_ballots)
    save_jsonl(records, args.output)
    print(f"Saved {len(records)} {args.mode} round-ranking tasks to {args.output.resolve()}")
    if not records:
        print("No eligible tasks. Minimum lobby size is 3, with complete submissions and final scores (training mode).")


if __name__ == "__main__":
    main()
