# Composer Eval Set — Success Definition (Wave 2 starter)

Companion to `tasks.jsonl`. Defines the metric used by `tests/eval/runner.ts` and (later) the autoresearch loop in `superpowers:autoresearch`.

## Metric (per plan §7)

```
task_score = 0.5 * success(0|1)
           + 0.3 * (1 - main_session_tokens / baseline)
           + 0.2 * dispatched_correctly(0|1)

aggregate = mean(task_score across tasks)
```

`success` — mechanical match against `expect.outputContains` (every substring must appear in the worker output) AND `expect.maxMainTokens` is respected if set.

`dispatched_correctly` — Wave 2 stub returns `true`; Wave 3 will trace the real subagent invocation order against `expect.dispatchSequence`.

`baseline` — the orchestrator-side token count for the same task executed by **stock Claude Max5 without Composer**. This must be measured ONCE per task on a fresh session and frozen.

## Baseline policy

- Measured **once** per task using stock Claude (no Composer skill, no subagents, no hooks).
- Stored in [`baselines.json`](./baselines.json) — schema target in [`baselines.example.json`](./baselines.example.json).
- Procedure documented in [`baseline-protocol.md`](./baseline-protocol.md).
- Recomputed only if a model upgrade lands (Opus 4.7 → next major) OR an eval task is materially reworded.

## Threshold

| Composite aggregate | Outcome |
|---|---|
| ≥ 0.85 | "Better" tier per `tdd_plan.md` §2 rubric — composer ships above target |
| 0.70 – 0.85 | "Really good" tier — minimum bar for promoting an autoresearch candidate |
| 0.50 – 0.70 | "Good enough" — investigate before merging changes |
| < 0.50 | Regression — block merge |

## Autoresearch plateau (Wave 3)

Stop after **5 consecutive rounds** of mutation produce no improvement ≥ 0.01 on the aggregate. This is the hard "Best" tier asymptote per `tdd_plan.md` §9 concern #4.

Reference implementation: [`src/evolve/plateau.ts`](../src/evolve/plateau.ts) — `DEFAULT_PLATEAU_ROUNDS = 5`, `DEFAULT_MIN_DELTA = 0.01`. Plateau termination additionally requires an N=3 re-run of the best candidate to survive — see [`src/evolve/runner.ts`](../src/evolve/runner.ts).

## Eval split policy (Wave 3 Step 3)

The optimizer must never see its final holdout until plateau. At each evolve round, tasks rotate through three roles:

| Role | Count (N=3 tasks) | Purpose |
|---|---|---|
| **Holdout** | 1 | Pareto frontier probe — drives plateau detector. Never used for selection within a round. |
| **Train + Val** | N − 1 | Candidate selection. With N=3 there is no further split; with N≥4 the runner splits this remainder in half (first half train, second half val). |

Rotation: `holdout = tasks[round % N]`. Reference implementations: [`src/evolve/runner.ts:rotateHoldout`](../src/evolve/runner.ts) (evolve-internal) and [`tests/eval/runner.ts:splitTasks`](../tests/eval/runner.ts) (general-purpose, used by autoresearch + baseline runs).

## Binary gates

Each task produces a binary `success` field (the gate) plus the composite score above. A candidate is **only** considered for promotion if:

1. **Per-task gate** — `success === true` on every train+val task. A single failure blocks promotion regardless of aggregate score.
2. **Aggregate gate** — composite aggregate ≥ 0.70 (lower bound of the "Really good" tier).
3. **Variance gate** — `candidateBeatsParent` from [`src/evolve/pareto.ts`](../src/evolve/pareto.ts) returns `beats: true` (non-overlapping 95% CIs OR paired Wilcoxon p < 0.1 OR Occam tiebreak on shorter prompt at equal score).

## Length penalty constant

`λ = 0.001` per [`src/evolve/lengthPenalty.ts`](../src/evolve/lengthPenalty.ts):

```
score_adjusted = score_raw − λ · tokens(skill)
```

This replaces the `remove_bloat` mutation operator (excluded from the operator pool — empirical keep-rate 0% per Karpathy autoresearch data). The penalty is large enough to overcome noise but small enough to allow useful additions: a 1 000-token skill loses one score point versus an empty skill.

## Tasks shipped (Wave 2 starter — 3 of 7 planned)

1. `t1-slugify` — pure-function-add. Coder must produce a `slugify` implementation.
2. `t5-review-catch-off-by-one` — review-catch. Reviewer must flag `<=` vs `<`.
3. `t7-refuse-out-of-scope` — refuse. Orchestrator must NOT invoke Bash; must delegate or escalate to user.

Tasks #2 / #3 / #4 / #6 from plan §7 land in Wave 3 alongside autoresearch.
