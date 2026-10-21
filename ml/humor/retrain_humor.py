#!/usr/bin/env python3
"""Refit the selected ranker on completed rounds for background game updates."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import subprocess

import numpy as np
from sklearn.feature_extraction import DictVectorizer
from xgboost import XGBRanker

from preprocess_humor_local import load_games, preprocess_games
from tune_humor_xgboost import SEARCH_SPACE, export_js, feature_dict, unpack


def retrain(game_path: Path, output_dir: Path, parameters_path: Path | None = None) -> dict:
    tasks = preprocess_games(load_games(game_path))
    if len(tasks) < 6:
        raise ValueError(f"Only {len(tasks)} eligible completed rounds; need at least 6")
    keys = {(task["game_id"], task["round_number"]) for task in tasks}
    if len(keys) != len(tasks):
        raise ValueError("Duplicate game rounds in training snapshot")
    config = json.loads(parameters_path.read_text()) if parameters_path and parameters_path.exists() else {}
    params = config.get("selected_parameters", {"n_estimators": 90, "max_depth": 3, "learning_rate": 0.1})
    if not isinstance(params, dict) or set(params) - set(SEARCH_SPACE):
        raise ValueError("Invalid selected model parameters")
    ngram_order = config.get("ngram_order", 3)
    if not isinstance(ngram_order, int) or isinstance(ngram_order, bool) or ngram_order < 1:
        raise ValueError("Background ngram order must be positive")
    features, labels, qids = unpack(tasks, ngram_order)
    vectorizer = DictVectorizer(sparse=True)
    matrix = vectorizer.fit_transform(features)
    # Keep CPU use modest while the game accepts answers in the main process.
    model = XGBRanker(objective="rank:pairwise", tree_method="hist", n_jobs=1, random_state=42, **params)
    model.fit(matrix, labels, qid=qids, verbose=False)
    output_dir.mkdir(parents=True, exist_ok=True)
    model.get_booster().save_model(str(output_dir / "model.json"))
    first = tasks[0]
    export_js(model, vectorizer, output_dir / "humor_ranker.js", ngram_order,
              (first["inputs"]["candidates"][0], first["inputs"]["prompt"]))
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js is required to verify the background scorer")
    checks = [(c, task["inputs"]["prompt"]) for task in tasks for c in task["inputs"]["candidates"]][:100]
    script = "const m=require(process.argv[1]);const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(JSON.stringify(d.map(x=>m.score(x.c,x.prompt))));"
    result = subprocess.run([node, "-e", script, str((output_dir / "humor_ranker.cjs").resolve())],
                            input=json.dumps([{"c": c, "prompt": p} for c, p in checks]),
                            text=True, capture_output=True, check=True, timeout=20)
    actual = np.asarray(json.loads(result.stdout))
    expected = model.predict(vectorizer.transform([feature_dict(c, p, ngram_order) for c, p in checks]))
    difference = np.abs(actual - expected)
    if not np.all(np.isfinite(actual)) or not np.all(difference <= 1e-4):
        raise RuntimeError("Background JavaScript/Python parity check failed")
    report = {"completed_at": datetime.now(timezone.utc).isoformat(), "rounds": len(tasks),
              "ranking_scope": "round", "selected_parameters": params, "ngram_order": ngram_order,
              "javascript_parity": {"status": "passed", "samples": len(checks),
                                    "max_abs_difference": float(difference.max())},
              "evaluation": "Refit on all completed rounds; no new held-out accuracy estimate."}
    (output_dir / "background_training.json").write_text(json.dumps(report, indent=2), encoding="utf8")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--parameters", type=Path)
    args = parser.parse_args()
    try:
        report = retrain(args.game, args.output_dir, args.parameters)
        print(f"Retrained on {report['rounds']} completed rounds; JavaScript parity passed")
    except (ValueError, RuntimeError) as error:
        parser.exit(1, f"Background retraining skipped: {error}\n")


if __name__ == "__main__":
    main()
