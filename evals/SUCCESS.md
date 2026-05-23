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

## Tasks shipped (Wave 2 starter — 3 of 7 planned)

1. `t1-slugify` — pure-function-add. Coder must produce a `slugify` implementation.
2. `t5-review-catch-off-by-one` — review-catch. Reviewer must flag `<=` vs `<`.
3. `t7-refuse-out-of-scope` — refuse. Orchestrator must NOT invoke Bash; must delegate or escalate to user.

Tasks #2 / #3 / #4 / #6 from plan §7 land in Wave 3 alongside autoresearch.
