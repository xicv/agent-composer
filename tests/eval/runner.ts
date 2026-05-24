// Wave 2 F2.2 — eval runner skeleton.
//
// Smoke version: calls the IProvider once per task and scores its output
// against the task's `expect.outputContains` rule. Wave 3 wires real
// subagent dispatch so dispatchedCorrectly becomes a meaningful signal.
//
// Until then, dispatchedCorrectly defaults to `true` — Wave 2 metric
// values are intended to verify the metric calculator + budget guard,
// not to compare Composer against stock Claude.

import fs from "node:fs";
import type { IProvider } from "../../src/providers/IProvider.js";
import { BudgetGuard } from "./budget.js";
import { EvalTaskSchema, type EvalTask, type EvalResult } from "./schema.js";

export interface RunnerOptions {
  provider: IProvider;
  budget: BudgetGuard;
  /** Override Wave-2 stub for testing. */
  computeDispatched?: (task: EvalTask) => boolean;
}

export class EvalRunner {
  constructor(private readonly opts: RunnerOptions) {}

  async runTask(task: EvalTask): Promise<EvalResult> {
    this.opts.budget.guard(task.prompt.length);
    const start = Date.now();
    const workerOut = await this.opts.provider.execute({ prompt: task.prompt });
    const durationMs = Date.now() - start;

    const text = workerOut.text;
    const expect = task.expect;

    let success = true;
    if (expect.outputContains && expect.outputContains.length > 0) {
      success = expect.outputContains.every((needle) => text.includes(needle));
    }

    if (
      expect.maxMainTokens !== undefined &&
      expect.maxMainTokens > 0 &&
      (workerOut.tokensIn ?? task.prompt.length) > expect.maxMainTokens
    ) {
      success = false;
    }

    const dispatchedCorrectly = this.opts.computeDispatched
      ? this.opts.computeDispatched(task)
      : true;

    return {
      taskId: task.id,
      success,
      mainSessionTokens: workerOut.tokensIn ?? task.prompt.length,
      dispatchedCorrectly,
      durationMs,
      workerCalls: 1,
      workerTextSample:
        text.length > 500 ? text.slice(0, 500) + "..." : text,
    };
  }

  async runAll(tasks: ReadonlyArray<EvalTask>): Promise<EvalResult[]> {
    const results: EvalResult[] = [];
    for (const t of tasks) {
      results.push(await this.runTask(t));
    }
    return results;
  }
}

// Wave 3 Step 3 — train/val/holdout split.
//
// Holdout = tasks[round % N] — never seen by selection logic within
// the round. Train+val = remainder; for N>=4 the remainder is halved
// (train = first floor(M/2), val = remaining). For N=3 (starter set)
// the remainder is split 1/1.
//
// Mirrors the evolve-internal `rotateHoldout` in src/evolve/runner.ts
// but exposes a deeper train/val partition for autoresearch + baseline
// callers that want both phases distinct.

export interface TaskSplit {
  holdout: EvalTask;
  train: EvalTask[];
  val: EvalTask[];
}

export function splitTasks(
  tasks: ReadonlyArray<EvalTask>,
  round: number,
): TaskSplit {
  if (tasks.length < 2) {
    throw new Error(`splitTasks: need at least 2 tasks, got ${tasks.length}`);
  }
  if (round < 0 || !Number.isInteger(round)) {
    throw new Error(`splitTasks: round must be non-negative integer, got ${round}`);
  }
  const idx = round % tasks.length;
  const holdout = tasks[idx]!;
  const remainder = tasks.filter((_, i) => i !== idx);
  const trainCount = Math.floor(remainder.length / 2);
  return {
    holdout,
    train: remainder.slice(0, trainCount),
    val: remainder.slice(trainCount),
  };
}

export function loadTasks(jsonlPath: string): EvalTask[] {
  const raw = fs.readFileSync(jsonlPath, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const out: EvalTask[] = [];
  lines.forEach((line, idx) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      throw new Error(`tasks.jsonl line ${idx + 1}: invalid JSON — ${detail}`);
    }
    const result = EvalTaskSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw new Error(
        `tasks.jsonl line ${idx + 1}: schema validation failed — ${issues}`,
      );
    }
    out.push(result.data);
  });
  return out;
}
