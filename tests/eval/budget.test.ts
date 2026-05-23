import { describe, it, expect } from "vitest";
import { BudgetGuard, BudgetExceededError } from "./budget.js";

describe("BudgetGuard — config validation", () => {
  it("throws on maxCalls <= 0", () => {
    expect(() => new BudgetGuard({ maxCalls: 0, maxUsd: 1 })).toThrow();
  });
  it("throws on maxUsd <= 0", () => {
    expect(() => new BudgetGuard({ maxCalls: 1, maxUsd: 0 })).toThrow();
  });
});

describe("BudgetGuard — call cap", () => {
  it("permits up to maxCalls", () => {
    const b = new BudgetGuard({ maxCalls: 3, maxUsd: 1000 });
    expect(() => b.guard(10)).not.toThrow();
    expect(() => b.guard(10)).not.toThrow();
    expect(() => b.guard(10)).not.toThrow();
  });

  it("throws BudgetExceededError on call N+1", () => {
    const b = new BudgetGuard({ maxCalls: 2, maxUsd: 1000 });
    b.guard(10);
    b.guard(10);
    expect(() => b.guard(10)).toThrow(BudgetExceededError);
    expect(() => b.guard(10)).toThrow(/call cap 2/);
  });
});

describe("BudgetGuard — USD cap", () => {
  it("throws when est cost exceeds maxUsd in one call", () => {
    // costPerKToken default = 0.0005 → 10M chars = ~$5 → exceeds $1 cap
    const b = new BudgetGuard({ maxCalls: 1000, maxUsd: 1.0 });
    expect(() => b.guard(10_000_000)).toThrow(/USD cap/);
  });

  it("respects custom costPerKToken", () => {
    const b = new BudgetGuard({
      maxCalls: 1000,
      maxUsd: 1.0,
      costPerKToken: 1.0, // $1 per 1k chars
    });
    expect(() => b.guard(2000)).toThrow(/USD cap/); // 2000 chars = $2 > $1
  });

  it("accumulates across calls", () => {
    const b = new BudgetGuard({
      maxCalls: 100,
      maxUsd: 1.0,
      costPerKToken: 0.5, // $0.50 per 1k chars
    });
    expect(() => b.guard(1000)).not.toThrow(); // $0.50, ok
    expect(() => b.guard(1500)).toThrow(/USD cap/); // total $1.25 > $1
  });
});

describe("BudgetGuard — stats", () => {
  it("exposes calls + estCostUsd", () => {
    const b = new BudgetGuard({ maxCalls: 10, maxUsd: 10 });
    b.guard(2000);
    b.guard(3000);
    expect(b.stats.calls).toBe(2);
    expect(b.stats.estCostUsd).toBeCloseTo((2000 / 1000 + 3000 / 1000) * 0.0005, 6);
  });
});

describe("BudgetGuard — input validation", () => {
  it("rejects negative promptLen", () => {
    const b = new BudgetGuard({ maxCalls: 10, maxUsd: 10 });
    expect(() => b.guard(-1)).toThrow();
  });
});
