import { describe, it, expect } from "vitest";
import { splitTasks } from "./runner.js";
import type { EvalTask } from "./schema.js";

function task(id: string): EvalTask {
  return {
    id,
    class: "pure-function-add",
    prompt: `prompt ${id}`,
    expect: {},
  };
}

const t1 = task("t1");
const t2 = task("t2");
const t3 = task("t3");
const t4 = task("t4");
const t5 = task("t5");

describe("splitTasks — N=3 starter set (Wave 3)", () => {
  it("round 0 → holdout=t1, train+val=[t2,t3]", () => {
    const s = splitTasks([t1, t2, t3], 0);
    expect(s.holdout.id).toBe("t1");
    expect(s.train.map((t) => t.id)).toEqual(["t2"]);
    expect(s.val.map((t) => t.id)).toEqual(["t3"]);
  });

  it("round 1 → holdout=t2", () => {
    const s = splitTasks([t1, t2, t3], 1);
    expect(s.holdout.id).toBe("t2");
    expect([...s.train, ...s.val].map((t) => t.id).sort()).toEqual(["t1", "t3"]);
  });

  it("round N wraps", () => {
    const s = splitTasks([t1, t2, t3], 3);
    expect(s.holdout.id).toBe("t1");
  });
});

describe("splitTasks — N>=4 balanced split", () => {
  it("N=4 round 0 → train=1, val=2", () => {
    const s = splitTasks([t1, t2, t3, t4], 0);
    expect(s.holdout.id).toBe("t1");
    expect(s.train).toHaveLength(1);
    expect(s.val).toHaveLength(2);
    expect([...s.train, ...s.val].map((t) => t.id)).toEqual(["t2", "t3", "t4"]);
  });

  it("N=5 round 0 → train=2, val=2", () => {
    const s = splitTasks([t1, t2, t3, t4, t5], 0);
    expect(s.train).toHaveLength(2);
    expect(s.val).toHaveLength(2);
  });
});

describe("splitTasks — error cases", () => {
  it("throws on N<2", () => {
    expect(() => splitTasks([t1], 0)).toThrow(/at least 2/);
    expect(() => splitTasks([], 0)).toThrow();
  });

  it("throws on negative round", () => {
    expect(() => splitTasks([t1, t2], -1)).toThrow(/non-negative/);
  });

  it("throws on non-integer round", () => {
    expect(() => splitTasks([t1, t2], 1.5)).toThrow();
  });
});
