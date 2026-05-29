import { describe, it, expect } from "vitest";
import path from "node:path";
import { EvalRunner, loadTasks } from "./runner.js";
import { BudgetGuard, BudgetExceededError } from "./budget.js";
import { MockProvider } from "../../src/providers/MockProvider.js";
import { scoreTask, aggregateScore } from "./metric.js";
import type { EvalTask } from "./schema.js";
import { runEvolve, type EvolveDeps, type EvolveOptions } from "../../src/evolve/runner.js";
import { OPERATORS } from "../../src/evolve/operators.js";

const TASKS_PATH = path.resolve("evals/tasks.jsonl");

function makeRunner(provider: MockProvider, budget?: BudgetGuard): EvalRunner {
  return new EvalRunner({
    provider,
    budget: budget ?? new BudgetGuard({ maxCalls: 100, maxUsd: 5.0 }),
  });
}

describe("loadTasks", () => {
  it("loads a diverse task set (>=30) covering the core tasks and all classes", () => {
    const tasks = loadTasks(TASKS_PATH);
    expect(tasks.length).toBeGreaterThanOrEqual(30);
    const ids = tasks.map((t) => t.id);
    for (const core of [
      "t1-slugify",
      "t5-review-catch-off-by-one",
      "t7-refuse-out-of-scope",
      "t8-csv-module",
    ]) {
      expect(ids).toContain(core);
    }
    const classes = new Set(tasks.map((t) => t.class));
    expect(classes.size).toBeGreaterThanOrEqual(6);
  });

  it("each starter task is schema-valid (class + prompt + expect)", () => {
    const tasks = loadTasks(TASKS_PATH);
    for (const t of tasks) {
      expect(t.id).toBeTruthy();
      expect(t.class).toBeTruthy();
      expect(t.prompt.length).toBeGreaterThan(20);
      expect(t.expect).toBeDefined();
    }
  });
});

describe("EvalRunner — single task", () => {
  it("success=true when worker output contains every expected substring", async () => {
    const provider = new MockProvider({
      responses: [
        "Here is slugify implementation. Returns a slug from text.",
      ],
    });
    const runner = makeRunner(provider);
    const task: EvalTask = {
      id: "t-pass",
      class: "pure-function-add",
      prompt: "Add slugify(text: string).",
      expect: { outputContains: ["slugify", "slug"] },
    };
    const result = await runner.runTask(task);
    expect(result.success).toBe(true);
    expect(result.workerCalls).toBe(1);
    expect(result.taskId).toBe("t-pass");
  });

  it("success=false when worker output misses an expected substring", async () => {
    const provider = new MockProvider({ responses: ["wrong output"] });
    const runner = makeRunner(provider);
    const task: EvalTask = {
      id: "t-fail",
      class: "pure-function-add",
      prompt: "Add slugify.",
      expect: { outputContains: ["slugify"] },
    };
    const result = await runner.runTask(task);
    expect(result.success).toBe(false);
  });

  it("success=false when mainSessionTokens exceeds maxMainTokens", async () => {
    // MockProvider's default echo response uses prompt.length as tokensIn.
    const provider = new MockProvider();
    const runner = makeRunner(provider);
    const longPrompt = "x".repeat(500);
    const task: EvalTask = {
      id: "t-over-tokens",
      class: "pure-function-add",
      prompt: longPrompt,
      expect: { maxMainTokens: 100 },
    };
    const result = await runner.runTask(task);
    expect(result.mainSessionTokens).toBe(500);
    expect(result.success).toBe(false);
  });

  it("dispatchedCorrectly honors computeDispatched override", async () => {
    const provider = new MockProvider();
    const runner = new EvalRunner({
      provider,
      budget: new BudgetGuard({ maxCalls: 10, maxUsd: 10 }),
      computeDispatched: () => false,
    });
    const result = await runner.runTask({
      id: "t",
      class: "pure-function-add",
      prompt: "p",
      expect: {},
    });
    expect(result.dispatchedCorrectly).toBe(false);
  });
});

describe("EvalRunner — multi-task + budget integration", () => {
  it("runAll calls the budget guard per task and records results", async () => {
    const provider = new MockProvider({
      responses: ["a", "b", "c"],
    });
    const budget = new BudgetGuard({ maxCalls: 10, maxUsd: 5 });
    const runner = makeRunner(provider, budget);
    const tasks = loadTasks(TASKS_PATH).slice(0, 3);
    const results = await runner.runAll(tasks);
    expect(results).toHaveLength(3);
    expect(budget.stats.calls).toBe(3);
  });

  it("budget cap aborts a run mid-stream", async () => {
    const provider = new MockProvider();
    const budget = new BudgetGuard({ maxCalls: 2, maxUsd: 1000 });
    const runner = makeRunner(provider, budget);
    const tasks: EvalTask[] = Array.from({ length: 5 }, (_, i) => ({
      id: `t-${i}`,
      class: "pure-function-add" as const,
      prompt: "p",
      expect: {},
    }));
    await expect(runner.runAll(tasks)).rejects.toBeInstanceOf(BudgetExceededError);
  });
});

describe("runEvolve — deps.pickOperator override", () => {
  it("forced operator appears in every round history entry", async () => {
    const provider = new MockProvider({ responses: Array(20).fill("ecosystem snapshot") });
    const forcedOp = OPERATORS[1]!; // tighten_language — pure text transform, no provider call
    const usedNames: string[] = [];

    const deps: EvolveDeps = {
      reflectionProvider: provider,
      researchProvider: provider,
      evaluate: async () => ({ score: 0.5, transcripts: [] }),
      reReplicate: async () => true,
      skillDomain: "test-domain",
      pickOperator: (round) => {
        void round;
        usedNames.push(forcedOp.name);
        return forcedOp;
      },
      postflightOverride: async () => ({ accept: true, reason: "test bypass" }),
    };

    const opts: EvolveOptions = {
      parent: "dispatch Read " + "x".repeat(3000),
      tasks: [
        { id: "t1", description: "task one" },
        { id: "t2", description: "task two" },
      ],
      deps,
      maxRounds: 2,
      budget: { maxCalls: 50, maxUsd: 10 },
    };

    const result = await runEvolve(opts);
    expect(result.history).toHaveLength(2);
    expect(result.history.every((log) => log.operator === forcedOp.name)).toBe(true);
    expect(usedNames).toHaveLength(2);
  });
});

describe("EvalRunner — composite score smoke (MockProvider)", () => {
  it("3 tasks × scripted-perfect-output → aggregate score >= 0.85", async () => {
    const provider = new MockProvider({
      responses: [
        // matches t1-slugify
        "Here is slugify and the slug definition.",
        // matches t5 (review-catch)
        "Found off-by-one error: `<=` should be `<`.",
        // matches t7 (refuse) — orchestrator should delegate via Task
        "I cannot use Bash. I must delegate to a subagent via Task.",
      ],
    });
    const runner = makeRunner(provider);
    // first 3 canonical tasks (t1/t5/t7) — the scripted responses match these.
    const tasks = loadTasks(TASKS_PATH).slice(0, 3);
    const results = await runner.runAll(tasks);
    const scores = results.map((r) =>
      scoreTask(r, { baselineMainTokens: 5000 }),
    );
    expect(scores.every((s) => s.score > 0)).toBe(true);
    const agg = aggregateScore(scores);
    expect(agg).toBeGreaterThanOrEqual(0.85);
  });
});
