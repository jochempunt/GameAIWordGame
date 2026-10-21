"""Synthetic fixtures exercise the pipeline; their metrics are not humor evidence."""
from copy import deepcopy
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from preprocess_humor_local import load_games, preprocess_games, save_jsonl
from tune_humor_xgboost import evaluate, feature_dict, read_tasks, run, unpack
from retrain_humor import retrain


def fixture_game(rounds=8, players=3):
    """Mirror gameRepository.ts's saved-game schema without using participant data."""
    ids = [f"player-{i}" for i in range(players)]
    result = []
    for r in range(rounds):
        answers = [{"answerId": f"answer-{r}-{i}", "playerId": pid,
                    "words": [["funny", "cat"], ["sleepy"], ["cat"]][i % 3],
                    "receivedAt": "2026-10-21T10:00:00Z"}
                   for i, pid in enumerate(ids)]
        result.append({
            "roundNumber": r + 1, "status": "completed",
            "prompt": "A funny cat’s secret 123!", "playerIds": ids,
            "wordsAvailable": [{"playerId": pid, "words": ["funny", "cat", "sleepy"]}
                               for pid in ids],
            "answers": answers,
            "rankings": [{"playerId": pid,
                          "answerIds": [a["answerId"] for a in answers if a["playerId"] != pid]}
                         for pid in ids],
            "scores": [{"answerId": a["answerId"], "score": sum(players - 1 - [other for other in answers if other["playerId"] != voter].index(a)
                                       for voter in ids if voter != a["playerId"])} for a in answers],
        })
    return {"_id": "synthetic-test-only", "roomId": "AAAA", "state": {
        "players": [{"playerId": pid, "name": f"Test {i}"} for i, pid in enumerate(ids)],
        "rounds": result, "totals": []}}


class PreprocessTests(unittest.TestCase):
    def test_variable_lobby_includes_all_answers_once_per_round(self):
        for count in (3, 4, 5, 7):
            tasks = preprocess_games([fixture_game(1, count)], strict_ballots=True)
            self.assertEqual(len(tasks), 1)
            for task in tasks:
                self.assertEqual(task["num_to_rank"], count)
                candidates = task["inputs"]["candidates"]
                self.assertNotIn("voter_id", task)
                self.assertEqual(task["ranking_scope"], "round")
                self.assertEqual(len(candidates), count)
                self.assertEqual(len(task["labels"]["ordered_answer_ids"]), count)
                self.assertEqual(candidates[0]["masked_prompt_tokens"],
                                 ["<UNK>", "funny", "<UNK>", "<UNK>", "<UNK>"])

    def test_predictions_do_not_read_votes_or_scores(self):
        game = fixture_game(1)
        expected = preprocess_games([game], mode="predict")
        round_ = game["state"]["rounds"][0]
        round_["rankings"] = "must never be read"
        round_["scores"] = "must never be read"
        self.assertEqual(preprocess_games([game], mode="predict"), expected)
        self.assertTrue(all("labels" not in t for t in expected))

    def test_incomplete_rounds_and_small_lobbies_are_skipped(self):
        self.assertEqual(preprocess_games([fixture_game(1, 2)]), [])
        game = fixture_game(1)
        game["state"]["rounds"][0]["answers"].pop()
        self.assertEqual(preprocess_games([game]), [])

    def test_invalid_tiles_and_ballots_are_rejected(self):
        game = fixture_game(1)
        game["state"]["rounds"][0]["answers"][0]["words"] = ["cat", "cat"]
        with self.assertRaisesRegex(ValueError, "exhausted word tiles"):
            preprocess_games([game])
        game = fixture_game(1)
        game["state"]["rounds"][0]["rankings"][0]["answerIds"] = []
        with self.assertRaisesRegex(ValueError, "Invalid/incomplete ballot"):
            preprocess_games([game], strict_ballots=True)

    def test_three_answers_use_final_aggregate_ranking_as_y(self):
        task = preprocess_games([fixture_game(1)])[0]
        labels = task["labels"]
        self.assertEqual(labels["final_scores"], {"answer-0-0": 4, "answer-0-1": 3, "answer-0-2": 2})
        self.assertEqual(labels["final_ranks"], {"answer-0-0": 1, "answer-0-1": 2, "answer-0-2": 3})
        features, y, qid = unpack([task], 3)
        self.assertEqual(len(features), 3)
        np.testing.assert_array_equal(y, [2, 1, 0])
        np.testing.assert_array_equal(qid, [0, 0, 0])
        self.assertTrue(all(not any("score" in key or "rank" in key for key in row) for row in features))

    def test_final_ties_remain_tied_in_target_and_metrics(self):
        game = fixture_game(1)
        scores = game["state"]["rounds"][0]["scores"]
        for entry, score in zip(scores, [4, 4, 2]):
            entry["score"] = score
        task = preprocess_games([game])[0]
        self.assertEqual(list(task["labels"]["final_ranks"].values()), [1, 1, 3])
        _, y, qid = unpack([task], 3)
        np.testing.assert_array_equal(y, [1, 1, 0])
        metrics = evaluate(y, np.array([0.8, 0.9, 0.1]), qid)
        self.assertEqual(metrics["pairwise_accuracy"], 1.0)
        self.assertEqual(metrics["top1_accuracy"], 1.0)
        self.assertEqual(metrics["ndcg_at_3"], 1.0)

    def test_legacy_ballots_reproduce_final_scores_and_missing_voter_penalty(self):
        game = fixture_game(1)
        expected = preprocess_games([game])
        round_ = game["state"]["rounds"][0]
        del round_["scores"]
        self.assertEqual(preprocess_games([game]), expected)
        round_["rankings"] = round_["rankings"][:2]
        labels = preprocess_games([game])[0]["labels"]
        self.assertEqual(labels["final_scores"], {"answer-0-0": 2, "answer-0-1": 2, "answer-0-2": 0})

    def test_mongo_shell_export_loading(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "mongo.json"
            path.write_text("{_id: 'game', state: {rounds: [], n: NumberInt(4), "
                            "time: ISODate('2026-10-21T10:00:00Z')}}", encoding="utf8")
            self.assertEqual(load_games(path)[0]["state"]["n"], 4)

    def test_out_of_bag_prompt_is_masked_in_features(self):
        candidate = {"answer_tokens": ["cat"], "available_words": ["cat"]}
        self.assertEqual(feature_dict(candidate, "cat secret"),
                         feature_dict(candidate, "cat hidden"))

    def test_too_few_independent_rounds_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "tasks.jsonl"
            save_jsonl(preprocess_games([fixture_game(5)]), path)
            with self.assertRaisesRegex(ValueError, "Need at least 6"):
                read_tasks(path)


@unittest.skipUnless(shutil.which("node"), "Node.js required for exported runtime verification")
class TrainingTests(unittest.TestCase):
    def test_background_refit_uses_selected_parameters_and_completed_rounds_only(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            game = fixture_game(8)
            game["state"]["rounds"][-1]["status"] = "in_progress"
            source = root / "games.json"
            source.write_text(json.dumps([game]), encoding="utf8")
            parameters = root / "parameters.json"
            parameters.write_text(json.dumps({"selected_parameters": {"n_estimators": 5, "max_depth": 2},
                                              "ngram_order": 2}), encoding="utf8")
            report = retrain(source, root / "model", parameters)
            self.assertEqual(report["rounds"], 7)
            self.assertEqual(report["selected_parameters"]["n_estimators"], 5)
            self.assertEqual(report["ngram_order"], 2)
            self.assertEqual(report["javascript_parity"]["status"], "passed")

    def test_train_export_and_predict_in_module_repository(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            # Reproduce this repository's ESM boundary for the CommonJS export.
            (root / "package.json").write_text('{"type":"module"}', encoding="utf8")
            game = fixture_game(20)
            source = root / "synthetic-test-tasks.jsonl"
            save_jsonl(preprocess_games([game], strict_ballots=True), source)
            report = run(source, root / "model", trials=1, bootstraps=1,
                         top_k=1, folds=2, verify_js=True)
            self.assertEqual(report["independent_rounds"], 20)
            self.assertEqual(report["javascript_parity"]["status"], "passed")
            for name in ("model.json", "humor_ranker.js", "humor_ranker.cjs",
                         "experiment_report.json", "tuning_results.csv", "bootstrap_results.csv"):
                self.assertTrue((root / "model" / name).is_file(), name)
            # Check raw-game inference and browser-style loading too, without votes.
            unlabeled = deepcopy(game)
            for round_ in unlabeled["state"]["rounds"]:
                del round_["rankings"]
                del round_["scores"]
            script = """
const fs = require('node:fs'), vm = require('node:vm');
const model = require(process.argv[1]);
const game = JSON.parse(fs.readFileSync(0, 'utf8'));
const predicted = model.predictGame(game);
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(process.argv[2], 'utf8'), context);
const browser = context.HumorRanker.predictGame(game);
if (JSON.stringify(predicted) !== JSON.stringify(browser)) throw Error('Browser mismatch');
console.log(JSON.stringify(predicted));
"""
            proc = subprocess.run(["node", "-e", script,
                                   str(root / "model" / "humor_ranker.cjs"),
                                   str(root / "model" / "humor_ranker.js")],
                                  input=json.dumps(unlabeled), text=True, capture_output=True, check=True)
            predictions = json.loads(proc.stdout)
            self.assertEqual(len(predictions), 20)
            for prediction in predictions:
                self.assertEqual(prediction["num_to_rank"], 3)
                self.assertNotIn("voter_id", prediction)
                self.assertEqual(len(prediction["ranked_answers"]), 3)


if __name__ == "__main__":
    unittest.main()
