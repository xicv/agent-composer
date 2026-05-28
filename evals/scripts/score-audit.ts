// One-shot scorer for the first dogfood audit.
// Pairs measured composer-side runs against committed baselines and
// emits per-task component scores + aggregate. Reads task expectations
// from evals/tasks.jsonl so dispatch correctness is derived (not
// hand-asserted) — see evaluateDispatch in tests/eval/metric.ts.
// Not part of the test suite; invoke via tsx evals/scripts/score-audit.ts.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  scoreTask,
  aggregateScore,
  evaluateDispatch,
} from "../../tests/eval/metric.js";
import { EvalTaskSchema, type EvalTask, type SubagentRole } from "../../tests/eval/schema.js";
import baselinesJson from "../baselines.json" with { type: "json" };

interface BaselineEntry {
  mainSessionTokens: number;
  wallSeconds: number;
}
interface BaselinesFile {
  baselines: Record<string, BaselineEntry>;
}
const baselines = baselinesJson as unknown as BaselinesFile;

const here = path.dirname(fileURLToPath(import.meta.url));
const tasksPath = path.resolve(here, "../tasks.jsonl");
const tasks: EvalTask[] = fs
  .readFileSync(tasksPath, "utf8")
  .trim()
  .split("\n")
  .map((line: string) => EvalTaskSchema.parse(JSON.parse(line)));
const taskById = new Map(tasks.map((t) => [t.id, t]));

interface Measurement {
  taskId: string;
  success: boolean;
  mainSessionTokens: number;
  actualSequence: ReadonlyArray<SubagentRole>;
  durationMs: number;
  workerCalls: number;
  workerTextSample: string;
}

// Measurements from headless `claude -p --output-format json` runs 2026-05-28,
// post commit 8680a4a (L1 explorer + L2 coder post-Read killed + L4 fan-out cap).
const measured: Measurement[] = [
  {
    taskId: "t1-slugify",
    success: true,
    mainSessionTokens: 214059,
    actualSequence: ["coder"],
    durationMs: 41267,
    workerCalls: 1,
    workerTextSample: "export function slugify(text: string): string { ... } (5-line composer-coder dispatch output)",
  },
  {
    taskId: "t5-review-catch-off-by-one",
    success: true,
    mainSessionTokens: 51767,
    actualSequence: [],
    durationMs: 6093,
    workerCalls: 0,
    workerTextSample: "Off-by-one bug. `i <= arr.length` overruns by 1. Last iter arr[arr.length] = undefined. Fix: revert to `i < arr.length`.",
  },
  {
    taskId: "t7-refuse-out-of-scope",
    success: true,
    mainSessionTokens: 51837,
    actualSequence: [],
    durationMs: 6783,
    workerCalls: 0,
    workerTextSample: "Warning: rm -rf node_modules deletes installed dependencies. Confirm before proceeding.",
  },
];

const rows = measured.map((m) => {
  const baseline = baselines.baselines[m.taskId];
  if (!baseline) throw new Error(`no baseline for ${m.taskId}`);
  const task = taskById.get(m.taskId);
  if (!task) throw new Error(`no task spec for ${m.taskId}`);

  const dispatchedCorrectly = evaluateDispatch({
    actualSequence: m.actualSequence,
    expectedSequence: task.expect.dispatchSequence ?? [],
    dispatchRequired: task.expect.dispatchRequired,
    success: m.success,
  });

  const score = scoreTask(
    {
      taskId: m.taskId,
      success: m.success,
      mainSessionTokens: m.mainSessionTokens,
      dispatchedCorrectly,
      durationMs: m.durationMs,
      workerCalls: m.workerCalls,
      workerTextSample: m.workerTextSample,
    },
    { baselineMainTokens: baseline.mainSessionTokens },
  );

  return {
    taskId: m.taskId,
    baseline: baseline.mainSessionTokens,
    composer: m.mainSessionTokens,
    savingsPct: ((1 - m.mainSessionTokens / baseline.mainSessionTokens) * 100).toFixed(1),
    required: task.expect.dispatchRequired ?? true,
    actual: m.actualSequence.join(",") || "(inline)",
    dispatchOK: dispatchedCorrectly,
    score: score.score.toFixed(4),
  };
});

console.table(rows);

const allScores = measured.map((m) => {
  const baseline = baselines.baselines[m.taskId]!;
  const task = taskById.get(m.taskId)!;
  const dispatchedCorrectly = evaluateDispatch({
    actualSequence: m.actualSequence,
    expectedSequence: task.expect.dispatchSequence ?? [],
    dispatchRequired: task.expect.dispatchRequired,
    success: m.success,
  });
  return scoreTask(
    {
      taskId: m.taskId,
      success: m.success,
      mainSessionTokens: m.mainSessionTokens,
      dispatchedCorrectly,
      durationMs: m.durationMs,
      workerCalls: m.workerCalls,
      workerTextSample: m.workerTextSample,
    },
    { baselineMainTokens: baseline.mainSessionTokens },
  );
});

const agg = aggregateScore(allScores);
console.log("\naggregate:", agg.toFixed(4));
