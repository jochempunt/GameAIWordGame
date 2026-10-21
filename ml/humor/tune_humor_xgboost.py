#!/usr/bin/env python3
"""Tune an XGBoost humor ranker on REAL final round rankings.

This file never creates synthetic data. Run preprocess_humor_local.py first:

  pip install numpy scikit-learn xgboost json5
  python preprocess_humor_local.py --game real_games.json --output real_rankings.jsonl
  python tune_humor_xgboost.py --input real_rankings.jsonl --output-dir ./local_humor_model \
      --trials 12 --bootstrap 100 --top-k 5

Requires >= 3 submitted answers per round and >= 6 independent labeled rounds.
All answers in a round are ranked together against the final aggregated result.

The output folder contains:
  model.json            XGBoost native model (for archival/Python)
  humor_ranker.js       Standalone vanilla JavaScript scorer for browsers, iPhone, Node
  humor_ranker.cjs      CommonJS copy for Node in repositories using type: module
  experiment_report.json  CV/bootstrapping/held-out metrics and configuration
  tuning_results.csv   Results for sampled hyperparameter configurations
  bootstrap_results.csv  Paired round-level out-of-bag evaluations

No inference server or external JS library is needed. Include humor_ranker.js
in your bundled web app/iOS WebView and use:

  const output = HumorRanker.predictTask(preprocessedVoterTask);
  // Or from a raw, completed game export (no ballots needed):
  const predictions = HumorRanker.predictGame(gameJsonObject);

The runtime stores the feature vocabulary and the tree ensemble inside its JS
file. Tokens outside each candidate's word bag are never exposed to features. It NEVER reads
labels, rankings, or scores during prediction. The JS format is deliberately
separate from native XGBoost model JSON: XGBoost's native JSON is not directly
executable in JavaScript.
"""
from __future__ import annotations

import argparse
from collections import Counter
import csv
import json
import math
from pathlib import Path
import random
import shutil
import subprocess
from typing import Any

import numpy as np
from sklearn.feature_extraction import DictVectorizer
from sklearn.model_selection import GroupKFold, GroupShuffleSplit, ParameterSampler
from xgboost import XGBRanker

from preprocess_humor_local import prompt_tokens

METRICS = ('ndcg_at_3', 'pairwise_accuracy', 'top1_accuracy')
SEARCH_SPACE = {
    'n_estimators': [40, 60, 90, 130, 180],
    'max_depth': [2, 3, 4, 5],
    'learning_rate': [0.025, 0.05, 0.1, 0.2],
    'subsample': [0.7, 0.85, 1.0],
    'colsample_bytree': [0.7, 0.85, 1.0],
    'min_child_weight': [1, 3, 5],
    'reg_lambda': [1.0, 3.0, 8.0],
}


def feature_dict(candidate: dict, prompt: str, max_ngram: int = 3) -> dict[str, float]:
    """Exact numeric and sparse input transformation replicated in the JS export.

    For actual answers n-gram features are constructed from the original tokens,
    not a string of BPE pieces. Out-of-bag *prompt* tokens are masked to <UNK>
    using this candidate author's bag, before prompt n-gram construction.
    Raw out-of-bag prompt words are NOT included elsewhere in the model features.
    """
    answer = [w.lower() for w in candidate['answer_tokens']]
    bag = [w.lower() for w in candidate['available_words']]
    prompt_raw = prompt_tokens(prompt)
    available = set(bag)
    masked = [w if w in available else '<UNK>' for w in prompt_raw]
    result = {
        'numeric:answer_length': float(len(answer)),
        'numeric:bag_size': float(len(bag)),
        'numeric:prompt_overlap': float(len(set(answer) & set(masked))),
        'numeric:prompt_mask_ratio': float(sum(w == '<UNK>' for w in masked) / max(1, len(masked))),
        'numeric:unique_fraction': float(len(set(answer)) / max(1, len(answer))),
    }
    for n in range(1, max_ngram + 1):
        for i in range(len(answer) - n + 1):
            key = f'answer:{n}:' + '_'.join(answer[i:i+n])
            result[key] = result.get(key, 0.0) + 1.0
        for i in range(len(masked) - n + 1):
            key = f'masked_ngram:{n}:' + '_'.join(masked[i:i+n])
            result[key] = result.get(key, 0.0) + 1.0
    for w in set(masked):
        result[f'masked_prompt:{w}'] = 1.0
    for w in available:
        result[f'bag:{w}'] = 1.0
    return result


def read_tasks(path: Path) -> list[dict]:
    if not path.is_file():
        raise ValueError(f'Preprocessed file not found: {path}')
    tasks = []
    with path.open(encoding='utf-8-sig') as f:
        for line_number, line in enumerate(f, 1):
            if not line.strip():
                continue
            try:
                t = json.loads(line)
                candidates = t['inputs']['candidates']
                relevance = t['labels']['relevance_by_answer_id']
                aid = [c['answer_id'] for c in candidates]
                assert t['ranking_scope'] == 'round', 'Regenerate JSONL using round-level preprocessing'
                assert len(aid) >= 3 and len(aid) == int(t['lobby_size'])
                assert len(aid) == len(set(aid))
                assert set(relevance) == set(aid)
                assert all(isinstance(v, int) and not isinstance(v, bool) and 0 <= v < len(aid)
                           for v in relevance.values())
                assert all(isinstance(c['answer_tokens'], list) and
                           isinstance(c['available_words'], list) for c in candidates)
                tasks.append(t)
            except (AssertionError, KeyError, TypeError, ValueError) as e:
                raise ValueError(f'Invalid ranking task on line {line_number}: {e}') from e
    if not tasks:
        raise ValueError('No eligible final round rankings in input. A round needs '
                         'at least three submitted answers and final scores.')
    groups = {round_key(t) for t in tasks}
    if len(groups) != len(tasks):
        raise ValueError('Expected exactly one ranking task per game round')
    if len(groups) < 6:
        raise ValueError(f'Only {len(groups)} distinct game rounds. Need at least 6 '
                         'independent labeled rounds for a grouped holdout and CV. '
                         'Collect additional human-ranking data.')
    return tasks


def round_key(task: dict) -> str:
    return json.dumps([task['game_id'], task['round_number']], ensure_ascii=False)


def unpack(tasks: list[dict], max_ngram: int) -> tuple[list[dict], np.ndarray, np.ndarray]:
    features: list[dict] = []
    labels: list[float] = []
    qids: list[int] = []
    for q, task in enumerate(tasks):
        rank = task['labels']['relevance_by_answer_id']
        for cand in task['inputs']['candidates']:
            features.append(feature_dict(cand, task['inputs']['prompt'], max_ngram))
            labels.append(float(rank[cand['answer_id']]))
            qids.append(q)
    return features, np.asarray(labels, dtype=np.float32), np.asarray(qids, dtype=np.int32)


def ndcg_at_k(actual: np.ndarray, predicted: np.ndarray, k: int) -> float:
    indexes = np.argsort(-predicted, kind='stable')[:k]
    ideal = np.argsort(-actual, kind='stable')[:k]
    discounts = np.log2(np.arange(len(indexes)) + 2)
    num = np.sum((2 ** actual[indexes] - 1) / discounts)
    den = np.sum((2 ** actual[ideal] - 1) / discounts)
    return float(num / den) if den else 1.0


def evaluate(y: np.ndarray, pred: np.ndarray, qid: np.ndarray) -> dict[str, float]:
    ndcg, top, pair_correct, pair_total = [], [], 0, 0
    for q in np.unique(qid):
        loc = np.flatnonzero(qid == q)
        a, p = y[loc], pred[loc]
        ndcg.append(ndcg_at_k(a, p, 3))
        # Any tied final winner is correct; average over tied predicted winners.
        top.append(float(np.mean(a[p == np.max(p)] == np.max(a))))
        for i in range(len(loc)):
            for j in range(i + 1, len(loc)):
                if a[i] == a[j]:
                    continue  # final ties have no preferred order
                pair_total += 1
                pair_correct += 0.5 if p[i] == p[j] else int((a[i]-a[j]) * (p[i]-p[j]) > 0)
    return {'ndcg_at_3': float(np.mean(ndcg)),
            'pairwise_accuracy': pair_correct / pair_total if pair_total else 1.0,
            'top1_accuracy': float(np.mean(top)), 'n_tasks': len(ndcg)}


def fit_predict(train: list[dict], validate: list[dict], p: dict,
                seed: int, max_ngram: int) -> tuple[XGBRanker, DictVectorizer, dict]:
    tr_x, tr_y, tr_q = unpack(train, max_ngram)
    va_x, va_y, va_q = unpack(validate, max_ngram)
    vec = DictVectorizer(sparse=True)
    x_tr = vec.fit_transform(tr_x)
    x_va = vec.transform(va_x)
    model = XGBRanker(objective='rank:pairwise', tree_method='hist',
                      random_state=seed, n_jobs=2, **p)
    model.fit(x_tr, tr_y, qid=tr_q, verbose=False)
    pred = model.predict(x_va)
    return model, vec, evaluate(va_y, pred, va_q)


def rank_all(rows: list[dict], columns: tuple[str, ...]) -> list[dict]:
    """Equal-rank Borda across three metrics; no manually weighted selection."""
    output = [dict(x) for x in rows]
    for key in columns:
        values = [float(r[key]) for r in output]
        for i, row in enumerate(output):
            better = sum(v > values[i] for v in values)
            tied = sum(v == values[i] for v in values)
            row['rank_' + key] = 1 + better + (tied-1) / 2
    for r in output:
        r['rank_sum'] = sum(r['rank_'+c] for c in columns)
    return sorted(output, key=lambda r: (r['rank_sum'], -r[columns[0]], r['trial']))


def grouped_folds(tasks: list[dict], n_folds: int):
    groups = np.asarray([round_key(t) for t in tasks])
    splitter = GroupKFold(n_splits=n_folds)
    dummy = np.zeros(len(tasks))
    for tr, va in splitter.split(dummy, groups=groups):
        yield [tasks[i] for i in tr], [tasks[i] for i in va]


def bootstrap_plans(groups: list[str], n_boot: int, seed: int) -> list[tuple[list[str], list[str]]]:
    rng = np.random.default_rng(seed)
    unique = list(sorted(set(groups)))
    if len(unique) < 3:
        raise ValueError('At least 3 training rounds needed for bootstrap OOB checks')
    plans = []
    for _ in range(n_boot):
        for attempt in range(10000):
            draws = [unique[int(x)] for x in rng.integers(len(unique), size=len(unique))]
            oob = [g for g in unique if g not in draws]
            if len(oob) >= 1 and len(set(draws)) >= 2:
                plans.append((draws, oob))
                break
        else:
            raise RuntimeError('Could not draw bootstrap training/OOB rounds')
    return plans


def write_csv(path: Path, rows: list[dict]):
    if not rows:
        return
    keys = list(dict.fromkeys(k for row in rows for k in row))
    with path.open('w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=keys)
        w.writeheader()
        w.writerows(rows)


def export_js(model: XGBRanker, vec: DictVectorizer, dest: Path, max_ngram: int,
              verify_vector: tuple[dict, str] | None = None):
    """Create standalone browser/Node scorer; no JS imports and no runtime fetch.

    The XGBoost dump is an interpretation format, so we flatten its supported
    numerical split trees and verify exported decisions against native Python.
    """
    booster = model.get_booster()
    dumps = [json.loads(s) for s in booster.get_dump(dump_format='json')]
    feature_names = list(vec.get_feature_names_out())
    def convert(node):
        if 'leaf' in node:
            return ['L', float(node['leaf'])]
        if 'split' not in node or 'yes' not in node:
            raise ValueError('Unsupported XGBoost tree node format')
        split = str(node['split'])
        if not split.startswith('f') or not split[1:].isdigit():
            raise ValueError('Only indexed, numeric XGBoost splits are supported')
        if node.get('split_condition') is None:
            raise ValueError('Missing split condition')
        if 'split_category' in node:
            raise ValueError('Categorical splits are not supported by JS exporter')
        kids = {k['nodeid']: k for k in node['children']}
        return ['S', int(split[1:]), float(node['split_condition']),
                convert(kids[node['yes']]), convert(kids[node['no']]),
                int(node['missing'] == node['yes'])]
    trees = [convert(root) for root in dumps]
    # Calibrate constant offset on an actual model row. Doing this with the
    # fitted model avoids relying on XGBoost version-specific base_score rules.
    # Prediction outputs for rank:pairwise are additive tree margins.
    f, prompt = verify_vector if verify_vector else ({}, '')
    raw_feat = feature_dict(f, prompt, max_ngram) if f else {}
    x = vec.transform([raw_feat])
    native = float(model.predict(x)[0])
    def raw_tree_score(node, sparse_values):
        while node[0] == 'S':
            _, idx, threshold, yes, no, missing_is_yes = node
            if idx not in sparse_values or not np.isfinite(sparse_values[idx]):
                node = yes if missing_is_yes else no
            else:
                node = yes if sparse_values[idx] < threshold else no
        return node[1]
    sparse_vals = {int(idx): float(v) for idx, v in zip(x.indices, x.data)}
    trees_score = sum(raw_tree_score(t, sparse_vals) for t in trees)
    baseline = native - trees_score
    payload = json.dumps({'features': feature_names, 'trees': trees,
                          'baseline': baseline, 'ngramOrder': max_ngram},
                         ensure_ascii=False, separators=(',', ':'))
    js = r'''/* Automatically generated from XGBoost; all inference is on-device.
   Load as a local bundled asset in browser/iPhone WebView or require in Node.
   API: HumorRanker.predictTask(task), HumorRanker.predictGame(game).
   Scores are relative ranking scores, not probabilities. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.HumorRanker=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const MODEL=__PAYLOAD__;
  const dict=Object.create(null);
  MODEL.features.forEach((s,i)=>{dict[s]=i;});
  const has=(a,x)=>Object.prototype.hasOwnProperty.call(a,x);
  function tokens(s){return String(s).toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?/gu)||[];}
  function add(o,k,v){o[k]=(o[k]||0)+v;}
  function features(c,prompt){
    const a=c.answer_tokens.map(w=>String(w).toLowerCase());
    const bag=c.available_words.map(w=>String(w).toLowerCase());
    const pool=new Set(bag), pt=tokens(prompt);
    const masked=pt.map(w=>pool.has(w)?w:'<UNK>');
    const unknown=masked.reduce((n,w)=>n+(w==='<UNK>'?1:0),0);
    const unique=new Set(a);
    const maskedSet=new Set(masked);
    const ansOverlap=[...unique].filter(w=>maskedSet.has(w)).length;
    const d={'numeric:answer_length':a.length, 'numeric:bag_size':bag.length,
      'numeric:prompt_overlap':ansOverlap,'numeric:prompt_mask_ratio':unknown/Math.max(1,masked.length),
      'numeric:unique_fraction':unique.size/Math.max(1,a.length)};
    for(let n=1;n<=MODEL.ngramOrder;n++){
      for(let i=0;i+n<=a.length;i++) add(d,'answer:'+n+':'+a.slice(i,i+n).join('_'),1);
      for(let i=0;i+n<=masked.length;i++) add(d,'masked_ngram:'+n+':'+masked.slice(i,i+n).join('_'),1);
    }
    for(const w of new Set(masked))d['masked_prompt:'+w]=1;
    for(const w of pool)d['bag:'+w]=1;
    return d;
  }
  function score(c,prompt){
    const f=features(c,prompt), values=Object.create(null);
    for(const [key,value] of Object.entries(f)) if(has(dict,key))values[dict[key]]=value;
    let sum=MODEL.baseline;
    for(const root of MODEL.trees){
      let n=root;
      while(n[0]==='S'){
        const idx=n[1],v=values[idx];
        n=!has(values,idx)||!Number.isFinite(v) ? (n[5]?n[3]:n[4]) : (v<n[2]?n[3]:n[4]);
      }
      sum+=n[1];
    }
    return sum;
  }
  function predictTask(task){
    if(!task||!task.inputs||!Array.isArray(task.inputs.candidates))throw Error('Invalid task');
    const prompt=task.inputs.prompt;
    return task.inputs.candidates.map((c,i)=>({answer_id:c.answer_id,
      player_id:c.player_id,score:score(c,prompt),original_index:i}))
      .sort((a,b)=>b.score-a.score||a.original_index-b.original_index)
      .map((r,i)=>({answer_id:r.answer_id,player_id:r.player_id,score:r.score,rank:i+1}));
  }
  function predictGame(game){
    const state=game.state||game;
    const result=[];
    for(const round of state.rounds||[]){
      const participants=round.playerIds||(round.wordsAvailable||[]).map(p=>p.playerId);
      if(participants.length<3||new Set(participants).size!==participants.length)continue;
      const bags=Object.create(null), answers=Object.create(null);
      for(const p of round.wordsAvailable||[])bags[p.playerId]=p.words;
      for(const a of round.answers||[])answers[a.playerId]=a;
      if(Object.keys(bags).length!==participants.length||
         Object.keys(answers).length!==participants.length)continue;
      const candidates=participants.map(id=>{
        const a=answers[id],bag=bags[id];
        if(!a||!bag||!Array.isArray(a.words))throw Error('Invalid submitted answer');
        const counts=Object.create(null);
        for(const w of bag){const key=String(w).toLowerCase();counts[key]=(counts[key]||0)+1;}
        for(const w of a.words){const key=String(w).toLowerCase();counts[key]=(counts[key]||0)-1;
          if(counts[key]<0)throw Error('Submitted answer exceeds word bag');}
        return {answer_id:a.answerId,player_id:id,answer_tokens:a.words,available_words:bag};
      });
      const task={inputs:{prompt:round.prompt,candidates}};
      result.push({round_number:round.roundNumber,ranking_scope:'round',
        num_to_rank:candidates.length,ranked_answers:predictTask(task)});
    }
    return result;
  }
  return Object.freeze({score,predictTask,predictGame});
});
'''
    dest.write_text(js.replace('__PAYLOAD__', payload), encoding='utf-8')
    dest.with_suffix('.cjs').write_text(js.replace('__PAYLOAD__', payload), encoding='utf-8')
    return trees, baseline


def run(input_path: Path, output_dir: Path, *, trials: int = 12,
        bootstraps: int = 100, top_k: int = 5,
        folds: int = 3, test_size: float = .25,
        seed: int = 42, ngram_order: int = 3,
        verify_js: bool = True) -> dict:
    if trials < 1 or bootstraps < 1 or top_k < 1 or folds < 2:
        raise ValueError('trials, bootstraps, top_k >=1 and folds>=2 required')
    if ngram_order < 1:
        raise ValueError('ngram_order must be positive')
    if not (0 < test_size < 0.5):
        raise ValueError('test_size must be between 0 and 0.5')
    tasks = read_tasks(input_path)
    all_groups = np.asarray([round_key(t) for t in tasks])
    train_idx, test_idx = next(GroupShuffleSplit(n_splits=1, test_size=test_size,
                                                 random_state=seed).split(tasks, groups=all_groups))
    training = [tasks[i] for i in train_idx]
    testing = [tasks[i] for i in test_idx]
    tr_groups = [round_key(t) for t in training]
    independent = len(set(tr_groups))
    if independent < max(folds, 3):
        raise ValueError(f'Training split has only {independent} independent rounds; '
                         'need at least 3. Collect more data or adjust test-size/folds.')
    output_dir.mkdir(parents=True, exist_ok=True)
    choices = list(ParameterSampler(SEARCH_SPACE, n_iter=trials, random_state=seed))
    cv_folds = list(grouped_folds(training, folds))
    cv_rows = []
    for trial_id, p in enumerate(choices, 1):
        scores = [fit_predict(tr, va, p, seed, ngram_order)[2] for tr, va in cv_folds]
        row = {'trial': trial_id, **p}
        row.update({'cv_'+metric: float(np.mean([s[metric] for s in scores]))
                    for metric in METRICS})
        cv_rows.append(row)
        print(f'CV {trial_id}/{len(choices)}: NDCG@3={row["cv_ndcg_at_3"]:.3f}; '
              f'pairwise={row["cv_pairwise_accuracy"]:.3f}; '
              f'top1={row["cv_top1_accuracy"]:.3f}', flush=True)
    ranked = rank_all(cv_rows, tuple('cv_'+m for m in METRICS))
    for r in ranked:
        r['cv_rank_position'] = ranked.index(r) + 1
    write_csv(output_dir / 'tuning_results.csv', ranked)
    top = ranked[:min(top_k, len(ranked))]

    # Paired cluster bootstrap at ROUND level. Every candidate uses same sampled
    # training rounds and out-of-bag rounds; each round's final ranking stays intact.
    plans = bootstrap_plans(tr_groups, bootstraps, seed+1)
    by_group: dict[str, list[dict]] = {}
    for t in training:
        by_group.setdefault(round_key(t), []).append(t)
    boot_rows = []
    for b, (draws, omitted) in enumerate(plans, 1):
        train_b = [t for rid in draws for t in by_group[rid]]  # repeated rounds = repeated tasks
        val_b = [t for rid in omitted for t in by_group[rid]]
        for r in top:
            pars = {p: r[p] for p in SEARCH_SPACE}
            _, _, metrics = fit_predict(train_b, val_b, pars, seed, ngram_order)
            boot_rows.append({'bootstrap': b, 'trial': r['trial'],
                              'oob_rounds': len(omitted), **metrics})
        if b % max(1, bootstraps//5) == 0:
            print(f'Bootstrap {b}/{bootstraps}', flush=True)
    write_csv(output_dir / 'bootstrap_results.csv', boot_rows)
    summary=[]
    for row in top:
        sub = [r for r in boot_rows if r['trial'] == row['trial']]
        metrics={'trial': row['trial'], **{p: row[p] for p in SEARCH_SPACE}}
        metrics.update({'boot_'+m: float(np.mean([s[m] for s in sub])) for m in METRICS})
        summary.append(metrics)
    selected = rank_all(summary, tuple('boot_'+m for m in METRICS))[0]
    params = {k: selected[k] for k in SEARCH_SPACE}
    model, vec, metrics = fit_predict(training, testing, params, seed, ngram_order)
    model.get_booster().save_model(str(output_dir / 'model.json'))
    first = training[0]
    trees, base = export_js(model, vec, output_dir / 'humor_ranker.js', ngram_order,
                            (first['inputs']['candidates'][0], first['inputs']['prompt']))
    js_parity: dict = {'status': 'not_checked'}
    if verify_js:
        node = shutil.which('node')
        if node:
            # JS and Python must agree on score outputs, not only ordering.
            checks = [(c, t['inputs']['prompt']) for t in
                      (training[:12] + testing[:12]) for c in t['inputs']['candidates']]
            js_in = [{'c': c, 'prompt': p} for c,p in checks]
            script = "const m=require(process.argv[1]);let d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(JSON.stringify(d.map(x=>m.score(x.c,x.prompt))));"
            proc = subprocess.run([node, '-e', script, str((output_dir/'humor_ranker.cjs').resolve())],
                                  input=json.dumps(js_in), capture_output=True, text=True, check=True)
            js_scores = np.asarray(json.loads(proc.stdout))
            py_scores = np.asarray([float(model.predict(vec.transform([feature_dict(c, p, ngram_order)]))[0])
                                   for c,p in checks])
            errors = np.abs(js_scores - py_scores)
            tolerance = 1e-4
            if not np.all(errors <= tolerance):
                raise RuntimeError(f'JavaScript / Python inference mismatch: max error {errors.max():.6g}')
            js_parity = {'status': 'passed', 'max_abs_difference': float(errors.max()),
                         'samples': len(checks), 'tolerance': tolerance}
        else:
            js_parity = {'status': 'not_checked', 'reason': 'Node.js not installed'}
    report = {
        'training_source': str(input_path), 'synthetic_generation': False,
        'independent_rounds': len(set(all_groups)), 'training_rounds': len(set(tr_groups)),
        'test_rounds': len(set(round_key(t) for t in testing)),
        'training_tasks': len(training), 'heldout_tasks': len(testing),
        'cv_trials': len(choices), 'cv_folds': folds, 'bootstrap_resamples': bootstraps,
        'bootstrapped_top_trials': [r['trial'] for r in top],
        'selected_trial': selected['trial'], 'selected_parameters': params,
        'ngram_order': ngram_order,
        'selected_bootstrap_mean': {m: selected['boot_'+m] for m in METRICS},
        'heldout': metrics, 'javascript_parity': js_parity,
        'ranking_scope': 'round',
        'target': 'Final round ranking from aggregated game scores; equal scores remain tied.',
        'note': 'Metrics quantify held-out final round rankings if the input contains real human votes. '
                'Predictions are scores for ordering, not calibrated humor probabilities.',
    }
    (output_dir/'experiment_report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print('Saved model and standalone JS to:', output_dir.resolve())
    print('Held-out metrics:', json.dumps(metrics))
    print('JavaScript parity:', json.dumps(js_parity))
    return report


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--input', type=Path, required=True, help='REAL labeled round-ranking JSONL from preprocessor')
    ap.add_argument('--output-dir', type=Path, required=True)
    ap.add_argument('--trials', type=int, default=12)
    ap.add_argument('--bootstrap', type=int, default=100)
    ap.add_argument('--top-k', type=int, default=5)
    ap.add_argument('--cv-folds', type=int, default=3)
    ap.add_argument('--test-size', type=float, default=.25)
    ap.add_argument('--seed', type=int, default=42)
    ap.add_argument('--ngram-order', type=int, default=3)
    ap.add_argument('--skip-js-verification', action='store_true')
    a = ap.parse_args()
    run(a.input, a.output_dir, trials=a.trials, bootstraps=a.bootstrap,
        top_k=a.top_k, folds=a.cv_folds, test_size=a.test_size,
        seed=a.seed, ngram_order=a.ngram_order,
        verify_js=not a.skip_js_verification)


if __name__ == '__main__':
    main()
