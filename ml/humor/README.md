# Local humor ranking pipeline

These scripts train an XGBoost ranker from final round rankings and export a
standalone JavaScript scorer. The game loads
`ml/humor/artifacts/model/humor_ranker.cjs` at startup (or the path in
`HUMOR_MODEL_PATH`) and automatically retrains after each completed round.

Background training starts after the round's final human scores are saved. It
reads all eligible completed rounds across games, reuses the parameters from
`experiment_report.json` (or defaults if no tuned report exists), and refits in a
separate Python process using one CPU thread. It requires six eligible rounds.
Rounds still accepting answers are excluded. Manual `pnpm humor:pipeline`
remains available for the full tuning and held-out evaluation workflow.

The previous model stays available throughout training. A new scorer replaces
it only after JavaScript/Python parity checks pass, without restarting the
server. Already computed round predictions stay fixed. Failed training or a
worker exceeding two minutes leaves the previous model in use. Only one job
runs at a time; rounds completed while it runs queue one fresh pass over the
latest saved data. Shutdown cancels the worker.

Local development automatically uses `.venv/bin/python` when present; otherwise
it uses `python3`. Set `HUMOR_PYTHON` to override this. Python dependencies below
must be installed once. Docker installs them during image build.
The latest background refit's native model and execution metadata are saved as
`background_model.json` and `background_training.json` next to the active scorer.
These are not new held-out evaluation results. The manual tuning report remains
unchanged. Temporary snapshots and candidate files are removed after each run.

After all active players submit answers, each player sees only their own
predicted position. Other players' predictions are not sent to their browser.
After five seconds, the server automatically opens human voting for everyone.
Human votes determine round points, followed by results and the next round.
Predictions are stored separately from human scores and never used as training
targets. If a prediction is unavailable, a brief message appears before voting
opens automatically on the same schedule.

The default trained CommonJS runtime and background training scripts are included
in Docker builds; raw exports and other training artifacts remain excluded.
Background updates live in the running container. To keep them across container
replacement, copy the active scorer out before rebuilding or mount its artifact
directory as persistent storage.

From the repository root, set up Python 3.11+ and activate its environment:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r ml/humor/requirements.txt
```

With MongoDB running (`pnpm db`), `MONGODB_URI` configured in `.env`, and the
Python environment active, run the full export, preprocess, and train sequence:

```bash
pnpm humor:pipeline
```

Each step runs only if the previous step succeeds. Results are written to
`ml/humor/artifacts/model/`. The six eligible rounds can span multiple games.

To run export and preprocessing separately:

```bash
pnpm humor:export
pnpm humor:preprocess --game ml/humor/data/games.json --output ml/humor/data/rankings.jsonl
```

The export command only reads MongoDB. It accepts an optional destination path:
`pnpm humor:export ml/humor/data/another-export.json`.
Alternatively, pass an existing JSON array or Mongo shell-style game export to
`--game`. Data and model artifacts in the default directories are ignored by Git.

Each task contains **all submitted answers in one round**, with at least three
players, all word bags, and all submitted answers. A three-player round therefore
has three candidate sentences and three target ranks. The target is the final
round ranking from the game's aggregated scores, not an individual ballot or the
cumulative leaderboard across rounds. Equal final scores remain tied.

Training uses completed rounds and the stored final scores. For older exports
without scores, preprocessing reproduces the game's ballot points and its
zero-score penalty for authors who did not vote. `--strict-ballots` additionally
requires complete valid ballots and verifies stored scores against their totals.
Labels contain final scores, final ranks, and dense relevance levels (higher is
better) used as XGBoost's `y`. These labels never enter the input features.

At least six independent `(game, round)` groups are required for the full training,
grouped cross-validation, and held-out evaluation workflow. Three-player rounds
qualify. Existing JSONL files from the voter-based format must be regenerated.

Run a small training check before the full experiment:

```bash
pnpm humor:train --input ml/humor/data/rankings.jsonl --output-dir ml/humor/artifacts/smoke --trials 1 --bootstrap 1 --top-k 1 --cv-folds 2
pnpm humor:train --input ml/humor/data/rankings.jsonl --output-dir ml/humor/artifacts/model --trials 12 --bootstrap 100 --top-k 5
```

The trainer holds out entire rounds, uses grouped cross-validation, and performs
paired round bootstrap comparisons. The report includes held-out NDCG@3,
pairwise accuracy (excluding tied target pairs), top-1 accuracy (accepting tied
final winners), selected parameters, and Python/JavaScript
score parity. Those metrics describe final round ranking prediction only when the
input is real human data. A successful technical test does not establish useful
humor prediction quality.

Outputs include `model.json`, `experiment_report.json`, tuning/bootstrap CSVs,
`humor_ranker.js` for a browser script, and `humor_ranker.cjs` for Node. In this
repository's ES modules, load the Node scorer with:

```js
import ranker from './ml/humor/artifacts/model/humor_ranker.cjs';
const predictions = ranker.predictGame(savedGame);
```

For browser script loading, use `globalThis.HumorRanker.predictGame(savedGame)`.
Scores determine relative order; they are not probabilities. Inference needs
the prompt, each player's word bag, and submitted answer tokens. It ignores
votes and scores, ranks every submitted answer together, and masks prompt words missing
from each author's bag. To create unlabeled JSONL instead:

```bash
pnpm humor:preprocess --game ml/humor/data/games.json --mode predict --output ml/humor/data/unvoted.jsonl
```

Run the automated checks with the Python environment active:

```bash
pnpm humor:test
pnpm test:game
```

Tests use explicitly synthetic fixtures to check preprocessing, validation,
leakage boundaries, training, and exported Node/browser inference. Test metrics
are not an evaluation of humor quality.
