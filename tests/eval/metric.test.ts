import { describe, it, expect } from "vitest";
import {
  scoreTask,
  aggregateScore,
  evaluateDispatch,
  type TaskScore,
} from "./metric.js";
import type { EvalResult, SubagentRole } from "./schema.js";

function res(overrides: Partial<EvalResult> = {}): EvalResult {
  return {
    taskId: "t",
    success: true,
    mainSessionTokens: 100,
    dispatchedCorrectly: true,
    durationMs: 0,
    workerCalls: 1,
    workerTextSample: "",
    ...overrides,
  };
}

describe("scoreTask — default weights (0.5 / 0.3 / 0.2)", () => {
  it("perfect run scores 1.0", () => {
    const s = scoreTask(
      res({ success: true, mainSessionTokens: 0, dispatchedCorrectly: true }),
      { baselineMainTokens: 1000 },
    );
    expect(s.score).toBeCloseTo(1.0, 6);
  });

  it("failure with full token + dispatch credit scores 0.5", () => {
    const s = scoreTask(
      res({ success: false, mainSessionTokens: 0, dispatchedCorrectly: true }),
      { baselineMainTokens: 1000 },
    );
    expect(s.score).toBeCloseTo(0.3 + 0.2, 6);
  });

  it("token component caps at 0 (no negative score)", () => {
    const s = scoreTask(
      res({ mainSessionTokens: 5000 }), // way above baseline 1000
      { baselineMainTokens: 1000 },
    );
    expect(s.components.token).toBe(0);
  });

  it("token component proportional to savings", () => {
    const s = scoreTask(
      res({ mainSessionTokens: 250 }), // 75% saving
      { baselineMainTokens: 1000 },
    );
    expect(s.components.token).toBeCloseTo(0.3 * 0.75, 6);
  });

  it("baseline 0 yields 0 token component", () => {
    const s = scoreTask(res(), { baselineMainTokens: 0 });
    expect(s.components.token).toBe(0);
  });
});

describe("scoreTask — custom weights", () => {
  it("rejects weights that do not sum to 1", () => {
    expect(() =>
      scoreTask(res(), {
        baselineMainTokens: 1000,
        successWeight: 0.5,
        tokenWeight: 0.5,
        dispatchWeight: 0.5,
      }),
    ).toThrow(/sum to 1/);
  });

  it("accepts custom weights summing to 1.0", () => {
    const s = scoreTask(
      res({ success: true, mainSessionTokens: 500, dispatchedCorrectly: false }),
      {
        baselineMainTokens: 1000,
        successWeight: 0.7,
        tokenWeight: 0.3,
        dispatchWeight: 0.0,
      },
    );
    expect(s.score).toBeCloseTo(0.7 + 0.3 * 0.5, 6);
  });
});

describe("scoreTask — config validation", () => {
  it("rejects negative baseline", () => {
    expect(() =>
      scoreTask(res(), { baselineMainTokens: -1 }),
    ).toThrow();
  });
});

describe("evaluateDispatch — audit 2026-05-24 thin-task carve-out", () => {
  const reviewerOnly: SubagentRole[] = ["reviewer"];
  const coderOnly: SubagentRole[] = ["coder"];
  const noDispatch: SubagentRole[] = [];

  it("required + matching sequence = correct", () => {
    expect(
      evaluateDispatch({
        actualSequence: ["reviewer"],
        expectedSequence: reviewerOnly,
        dispatchRequired: true,
        success: true,
      }),
    ).toBe(true);
  });

  it("required + missing dispatch = incorrect (strict mode)", () => {
    expect(
      evaluateDispatch({
        actualSequence: [],
        expectedSequence: reviewerOnly,
        dispatchRequired: true,
        success: true,
      }),
    ).toBe(false);
  });

  it("required + wrong subagent = incorrect", () => {
    expect(
      evaluateDispatch({
        actualSequence: ["coder"],
        expectedSequence: reviewerOnly,
        dispatchRequired: true,
        success: true,
      }),
    ).toBe(false);
  });

  it("not required + no dispatch + success = correct (the thin-task win)", () => {
    expect(
      evaluateDispatch({
        actualSequence: [],
        expectedSequence: reviewerOnly,
        dispatchRequired: false,
        success: true,
      }),
    ).toBe(true);
  });

  it("not required + no dispatch + failure = incorrect (must dispatch when inline fails)", () => {
    expect(
      evaluateDispatch({
        actualSequence: [],
        expectedSequence: reviewerOnly,
        dispatchRequired: false,
        success: false,
      }),
    ).toBe(false);
  });

  it("not required + dispatched anyway + matches expected = correct", () => {
    expect(
      evaluateDispatch({
        actualSequence: ["reviewer"],
        expectedSequence: reviewerOnly,
        dispatchRequired: false,
        success: true,
      }),
    ).toBe(true);
  });

  it("not required + dispatched wrong subagent = incorrect", () => {
    expect(
      evaluateDispatch({
        actualSequence: ["coder"],
        expectedSequence: reviewerOnly,
        dispatchRequired: false,
        success: true,
      }),
    ).toBe(false);
  });

  it("empty expected + no dispatch (refuse-out-of-scope) = correct", () => {
    expect(
      evaluateDispatch({
        actualSequence: noDispatch,
        expectedSequence: noDispatch,
        dispatchRequired: true,
        success: true,
      }),
    ).toBe(true);
  });

  it("default dispatchRequired=true when undefined (backward compat)", () => {
    expect(
      evaluateDispatch({
        actualSequence: ["coder"],
        expectedSequence: coderOnly,
        success: true,
      }),
    ).toBe(true);
    expect(
      evaluateDispatch({
        actualSequence: [],
        expectedSequence: coderOnly,
        success: true,
      }),
    ).toBe(false);
  });
});

describe("aggregateScore", () => {
  it("returns 0 on empty list", () => {
    expect(aggregateScore([])).toBe(0);
  });

  it("returns mean of task scores", () => {
    const scores: TaskScore[] = [
      { taskId: "a", score: 0.6, components: { success: 0.5, token: 0.1, dispatch: 0 } },
      { taskId: "b", score: 1.0, components: { success: 0.5, token: 0.3, dispatch: 0.2 } },
      { taskId: "c", score: 0.2, components: { success: 0, token: 0, dispatch: 0.2 } },
    ];
    expect(aggregateScore(scores)).toBeCloseTo((0.6 + 1.0 + 0.2) / 3, 6);
  });
});
