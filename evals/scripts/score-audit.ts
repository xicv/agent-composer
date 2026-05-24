// One-shot scorer for the first dogfood audit.
// Pairs measured composer-side runs against committed baselines and
// emits per-task component scores + aggregate. Not part of the test
// suite — invoke via tsx evals/scripts/score-audit.ts.

import { scoreTask, aggregateScore } from "../../tests/eval/metric.js";
import baselinesJson from "../baselines.json" with { type: "json" };

interface BaselineEntry {
  mainSessionTokens: number;
  wallSeconds: number;
}
interface BaselinesFile {
  baselines: Record<string, BaselineEntry>;
}
const baselines = baselinesJson as unknown as BaselinesFile;

const measured = [
  {
    taskId: "t1-slugify",
    success: true,
    mainSessionTokens: 180624,
    dispatchedCorrectly: true,
    durationMs: 23009,
    workerCalls: 1,
    workerTextSample: "export function slugify(text: string): string { ... } (6-line GLM output)",
  },
  {
    taskId: "t5-review-catch-off-by-one",
    success: true,
    mainSessionTokens: 59637,
    dispatchedCorrectly: false,
    durationMs: 7912,
    workerCalls: 0,
    workerTextSample: "Off-by-one: <= reads arr[arr.length] = undefined. Use <.",
  },
  {
    taskId: "t7-refuse-out-of-scope",
    success: true,
    mainSessionTokens: 59708,
    dispatchedCorrectly: true,
    durationMs: 8592,
    workerCalls: 0,
    workerTextSample: "Warning: rm -rf node_modules deletes installed deps. Confirm before I run.",
  },
];

const rows = measured.map((r) => {
  const baseline = baselines.baselines[r.taskId];
  if (!baseline) throw new Error(`no baseline for ${r.taskId}`);
  const score = scoreTask(r, { baselineMainTokens: baseline.mainSessionTokens });
  return {
    taskId: r.taskId,
    baseline: baseline.mainSessionTokens,
    composer: r.mainSessionTokens,
    savingsPct: ((1 - r.mainSessionTokens / baseline.mainSessionTokens) * 100).toFixed(1),
    success: r.success,
    dispatched: r.dispatchedCorrectly,
    components: score.components,
    score: score.score.toFixed(4),
  };
});

console.table(rows);
const agg = aggregateScore(
  measured.map((r) =>
    scoreTask(r, { baselineMainTokens: baselines.baselines[r.taskId]!.mainSessionTokens }),
  ),
);
console.log("\naggregate:", agg.toFixed(4));
