import { describe, it, expect } from "vitest";
import {
  EvolveBudgetGuard,
  EvolveBudgetExceededError,
  DEFAULT_EVOLVE_BUDGET,
} from "../../src/evolve/budget.js";

describe("DEFAULT_EVOLVE_BUDGET", () => {
  it("matches handoff doc: maxCalls=100, maxUsd=4.0", () => {
    expect(DEFAULT_EVOLVE_BUDGET.maxCalls).toBe(100);
    expect(DEFAULT_EVOLVE_BUDGET.maxUsd).toBe(4.0);
  });
});

describe("EvolveBudgetGuard — config validation", () => {
  it("throws on non-positive caps", () => {
    expect(() => new EvolveBudgetGuard({ maxCalls: 0, maxUsd: 1 })).toThrow();
    expect(() => new EvolveBudgetGuard({ maxCalls: 1, maxUsd: 0 })).toThrow();
  });
});

describe("EvolveBudgetGuard — call accounting", () => {
  it("permits up to maxCalls (charged via spent())", () => {
    const b = new EvolveBudgetGuard({ maxCalls: 3, maxUsd: 1000 });
    b.spent(0.01);
    b.spent(0.01);
    b.spent(0.01);
    expect(b.stats.calls).toBe(3);
  });

  it("throws when call N+1 attempted", () => {
    const b = new EvolveBudgetGuard({ maxCalls: 2, maxUsd: 1000 });
    b.spent(0.01);
    b.spent(0.01);
    expect(() => b.spent(0.01)).toThrow(EvolveBudgetExceededError);
    expect(() => b.spent(0.01)).toThrow(/call cap 2/);
  });
});

describe("EvolveBudgetGuard — USD accounting", () => {
  it("throws when single charge exceeds cap", () => {
    const b = new EvolveBudgetGuard({ maxCalls: 100, maxUsd: 1.0 });
    expect(() => b.spent(2.0)).toThrow(/USD cap/);
  });

  it("accumulates across calls until cap", () => {
    const b = new EvolveBudgetGuard({ maxCalls: 100, maxUsd: 1.0 });
    b.spent(0.5);
    expect(() => b.spent(0.6)).toThrow(/USD cap/);
  });

  it("rejects negative cost", () => {
    const b = new EvolveBudgetGuard(DEFAULT_EVOLVE_BUDGET);
    expect(() => b.spent(-0.01)).toThrow();
  });
});

describe("EvolveBudgetGuard — remaining()", () => {
  it("reports remaining calls and USD", () => {
    const b = new EvolveBudgetGuard({ maxCalls: 10, maxUsd: 2.0 });
    b.spent(0.5);
    expect(b.remaining.calls).toBe(9);
    expect(b.remaining.usd).toBeCloseTo(1.5, 6);
  });

  it("exhausted() flips after either cap met", () => {
    const b = new EvolveBudgetGuard({ maxCalls: 2, maxUsd: 100 });
    expect(b.exhausted()).toBe(false);
    b.spent(0.01);
    b.spent(0.01);
    expect(b.exhausted()).toBe(true);
  });
});
