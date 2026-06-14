# Speed Improvement Benchmark Plan

## Goal

Measure Composer speed improvements alongside the existing token-savings eval metric. The benchmark should capture:

- Wall-clock latency per task.
- Tokens per second per task.
- Warm-vs-cold review behavior.
- Existing token savings, unchanged, for continuity with prior eval runs.

The current scoring formula remains unchanged in this phase. `tests/eval/metric.ts` `scoreTask` continues to score success, token savings, and dispatch correctness only.

## What Exists Today

- `evals/scripts/measure.ts` captures `durationMs` in `runTask`, carries it through `RunOutcome`, and uses `scoreTask` with token baselines. Before this change, the measure JSONL row omitted latency fields.
- `evals/scripts/baseline.ts` runs stock Claude without Composer and records `mainSessionTokens` plus `method` for each baseline task. Before this change, it timed the stock run but did not write `wallSeconds`.
- `tests/eval/metric.ts` `scoreTask` implements the token-savings composite:
  - success weight: 0.5
  - token savings weight: 0.3
  - dispatch correctness weight: 0.2
- `tests/eval/route-metrics.ts` `summarizeRoute` already computes `meanDurationMs` for route comparison records.

## This PR

This PR adds minimal additive latency capture without changing scoring:

- `evals/scripts/baseline.ts` writes `wallSeconds` on each baseline entry using the measured stock-run wall time.
- `evals/scripts/measure.ts` writes raw `durationMs` and derived `wallSeconds` into each JSONL row.
- `tests/eval/schema.ts` accepts optional `wallSeconds` on `EvalResultSchema` while keeping `durationMs`.

No latency term is added to `scoreTask` in this phase.

## Timing Scope (Fairness)

Baseline and Composer timings must cover the same scope: task execution only, excluding harness setup, teardown, and cleanup. Composer timing must include warmup and retry attempt execution time so a slow or flaky path is not hidden by reporting only the final successful attempt.

A latency savings percentage must not be computed until both baseline and Composer captures are validated to use this identical timing scope.

## Future Phases

### Phase 0: Validated Latency Savings

Compute `latencySavedPct` only after the baseline and Composer timing scopes have been validated as identical.

- Use raw `durationMs` from `evals/scripts/measure.ts` rows and raw `wallSeconds` from `evals/scripts/baseline.ts`.
- Keep the field out of measure rows until validation is complete.

### Phase 1: Optional Latency Weight

Add an optional latency component to `tests/eval/metric.ts` `scoreTask`.

- Default `latencyWeight` must be `0` to preserve comparability with historical scores.
- Existing default weights should continue to produce the same score values unless a caller explicitly opts into latency scoring.
- Inputs should use `durationMs` from `evals/scripts/measure.ts` rows and `wallSeconds` from `evals/scripts/baseline.ts`.

Files/functions:

- `tests/eval/metric.ts` `MetricConfig`
- `tests/eval/metric.ts` `scoreTask`
- `tests/eval/metric.test.ts`

### Phase 2: Warm-vs-Cold Review Split

Join measure rows to the precommit cache log by timestamp and classify review latency by cache state.

- Use precommit cache log `source: cache|sync`.
- Join on `ts` after adding or preserving timestamps in `evals/scripts/measure.ts` row output.
- Report separate warm and cold latency summaries.

Files/functions:

- `evals/scripts/measure.ts` row emission
- precommit cache log reader/parser
- `tests/eval/route-metrics.ts` `summarizeRoute` or a new speed summary helper if route records are not the right shape

### Phase 3: Per-Task Tokens Per Second

Compute tokens/sec for each task from measured token use and latency.

- Use `ccTotalMean / (durationMs / 1000)` for Composer runs.
- Use `mainSessionTokens / wallSeconds` for stock baselines.
- Keep tokens/sec as a reporting field, not a scoring input, until latency scoring is explicitly enabled.

Files/functions:

- `evals/scripts/measure.ts` row emission
- `evals/scripts/baseline.ts` baseline entry output
- `tests/eval/schema.ts` if shared parsing is introduced for measure rows

### Phase 4: `bench:speed` Aggregator

Add an `npm run bench:speed` command that aggregates over `evals/tasks.jsonl` with `--runs` support.

Expected output:

- Mean `durationMs`.
- p50 `durationMs`.
- p95 `durationMs`.
- Mean `wallSeconds`.
- Mean `latencySavedPct` only after validated timing-scope parity exists.
- Tokens/sec per task and aggregate.

Files/functions:

- `package.json` scripts
- new `evals/scripts/bench-speed.ts`
- `evals/scripts/measure.ts` JSONL row shape
- `evals/scripts/baseline.ts` baseline shape
- `tests/eval/route-metrics.ts` `summarizeRoute` if route-level speed comparison is included

## How To Run

Baseline stock Claude, no Composer MCP:

```sh
ANTHROPIC_MODEL=glm-5.2 ./node_modules/.bin/tsx evals/scripts/baseline.ts --model glm-5.2 --runs 3
```

Measure Composer against committed baselines:

```sh
ANTHROPIC_MODEL=glm-5.2 ./node_modules/.bin/tsx evals/scripts/measure.ts --model glm-5.2 --runs 3
```

For one task:

```sh
ANTHROPIC_MODEL=glm-5.2 ./node_modules/.bin/tsx evals/scripts/baseline.ts --model glm-5.2 --task t1-slugify --runs 3
ANTHROPIC_MODEL=glm-5.2 ./node_modules/.bin/tsx evals/scripts/measure.ts --model glm-5.2 --task t1-slugify --runs 3
```
