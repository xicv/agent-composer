import { describe, it, expect } from "vitest";
import {
  EvalTaskSchema,
  EvalResultSchema,
  TaskClassSchema,
} from "./schema.js";

const VALID_TASK = {
  id: "t1",
  class: "pure-function-add",
  prompt: "Add slugify(text: string) to src/util/slug.ts.",
  expect: { outputContains: ["slugify"], dispatchSequence: ["coder"] },
};

describe("EvalTaskSchema", () => {
  it("accepts a canonical task", () => {
    expect(() => EvalTaskSchema.parse(VALID_TASK)).not.toThrow();
  });

  it("rejects empty id", () => {
    expect(() => EvalTaskSchema.parse({ ...VALID_TASK, id: "" })).toThrow();
  });

  it("rejects unknown task class", () => {
    expect(() =>
      EvalTaskSchema.parse({ ...VALID_TASK, class: "bogus" }),
    ).toThrow();
  });

  it("rejects extra top-level keys (strict)", () => {
    expect(() =>
      EvalTaskSchema.parse({ ...VALID_TASK, extra: 1 }),
    ).toThrow();
  });

  it("rejects unknown subagent role in dispatchSequence", () => {
    expect(() =>
      EvalTaskSchema.parse({
        ...VALID_TASK,
        expect: { dispatchSequence: ["coder", "smuggler"] },
      }),
    ).toThrow();
  });

  it("accepts empty dispatchSequence (refuse-out-of-scope case)", () => {
    expect(() =>
      EvalTaskSchema.parse({
        ...VALID_TASK,
        expect: { dispatchSequence: [] },
      }),
    ).not.toThrow();
  });

  it("rejects negative maxMainTokens", () => {
    expect(() =>
      EvalTaskSchema.parse({
        ...VALID_TASK,
        expect: { maxMainTokens: -1 },
      }),
    ).toThrow();
  });

  it("accepts optional dispatchRequired flag (audit 2026-05-24 carve-out)", () => {
    expect(() =>
      EvalTaskSchema.parse({
        ...VALID_TASK,
        expect: { dispatchSequence: ["reviewer"], dispatchRequired: false },
      }),
    ).not.toThrow();
  });

  it("rejects non-boolean dispatchRequired", () => {
    expect(() =>
      EvalTaskSchema.parse({
        ...VALID_TASK,
        expect: { dispatchRequired: "maybe" },
      }),
    ).toThrow();
  });
});

describe("EvalResultSchema", () => {
  it("accepts a canonical result", () => {
    expect(() =>
      EvalResultSchema.parse({
        taskId: "t1",
        success: true,
        mainSessionTokens: 100,
        dispatchedCorrectly: true,
        durationMs: 250,
        workerCalls: 1,
        workerTextSample: "ok",
      }),
    ).not.toThrow();
  });

  it("rejects negative token count", () => {
    expect(() =>
      EvalResultSchema.parse({
        taskId: "t1",
        success: true,
        mainSessionTokens: -5,
        dispatchedCorrectly: true,
        durationMs: 0,
        workerCalls: 0,
        workerTextSample: "",
      }),
    ).toThrow();
  });
});

describe("TaskClassSchema", () => {
  it("includes all 7 plan §7 classes", () => {
    const classes = [
      "pure-function-add",
      "bug-fix-from-test",
      "cross-file-refactor",
      "research-first-feature",
      "review-catch",
      "multi-step-plan",
      "refuse-out-of-scope",
    ];
    for (const c of classes) {
      expect(() => TaskClassSchema.parse(c)).not.toThrow();
    }
  });
});
