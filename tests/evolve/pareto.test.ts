import { describe, it, expect } from "vitest";
import {
  mean,
  stdDev,
  ci95,
  wilcoxonSignedRankP,
  candidateBeatsParent,
} from "../../src/evolve/pareto.js";

describe("mean / stdDev", () => {
  it("mean of empty is 0", () => {
    expect(mean([])).toBe(0);
  });
  it("stdDev of singleton is 0", () => {
    expect(stdDev([5])).toBe(0);
  });
  it("computes sample mean + stdDev", () => {
    expect(mean([1, 2, 3, 4, 5])).toBe(3);
    expect(stdDev([1, 2, 3, 4, 5])).toBeCloseTo(Math.sqrt(2.5), 6);
  });
});

describe("ci95", () => {
  it("returns [μ, μ] for singleton", () => {
    const { lower, upper } = ci95([0.7]);
    expect(lower).toBe(0.7);
    expect(upper).toBe(0.7);
  });

  it("widens with sample variance", () => {
    const tight = ci95([0.5, 0.5, 0.5, 0.5]);
    const loose = ci95([0.2, 0.5, 0.5, 0.8]);
    expect(upperMinusLower(loose)).toBeGreaterThan(upperMinusLower(tight));
  });
});

describe("wilcoxonSignedRankP — paired test", () => {
  it("returns 1 when samples identical (no signal)", () => {
    const p = wilcoxonSignedRankP([0.5, 0.6, 0.7], [0.5, 0.6, 0.7]);
    expect(p).toBe(1);
  });

  it("returns small p when candidate strictly dominates", () => {
    const parent = [0.30, 0.32, 0.31, 0.33, 0.29, 0.30, 0.31];
    const cand = [0.55, 0.57, 0.56, 0.58, 0.54, 0.55, 0.56];
    const p = wilcoxonSignedRankP(parent, cand);
    expect(p).toBeLessThan(0.05);
  });

  it("throws on mismatched lengths", () => {
    expect(() => wilcoxonSignedRankP([1, 2], [1])).toThrow();
  });
});

describe("candidateBeatsParent", () => {
  const parent = [0.30, 0.32, 0.31, 0.33, 0.29, 0.30, 0.31];
  const winner = [0.55, 0.57, 0.56, 0.58, 0.54, 0.55, 0.56];

  it("accepts when CIs disjoint", () => {
    const r = candidateBeatsParent(parent, winner);
    expect(r.beats).toBe(true);
    expect(r.reason).toMatch(/CI|Wilcoxon/);
  });

  it("rejects when CIs overlap and Wilcoxon p high", () => {
    const noisy = [0.30, 0.50, 0.20, 0.45, 0.35, 0.40, 0.25];
    const r = candidateBeatsParent(parent, noisy);
    expect(r.beats).toBe(false);
  });

  it("Occam tiebreak: when scores tied, shorter prompt wins", () => {
    const same = [0.5, 0.5, 0.5];
    const r = candidateBeatsParent(same, same, {
      parentTokens: 200,
      candidateTokens: 100,
    });
    expect(r.beats).toBe(true);
    expect(r.reason).toMatch(/Occam|shorter/);
  });

  it("Occam tiebreak: longer prompt does NOT win on tie", () => {
    const same = [0.5, 0.5, 0.5];
    const r = candidateBeatsParent(same, same, {
      parentTokens: 100,
      candidateTokens: 200,
    });
    expect(r.beats).toBe(false);
  });

  it("does not throw on unequal-but-nonempty arrays — Wilcoxon path is skipped", () => {
    // Higher-mean parent → falls past CI + Wilcoxon paths, lands on Occam (which needs exact mean tie).
    const r = candidateBeatsParent([0.5, 0.6, 0.7], [0.5, 0.6]);
    expect(r.beats).toBe(false);
    expect(r.parentMean).toBeCloseTo(0.6, 5);
    expect(r.candidateMean).toBeCloseTo(0.55, 5);
  });

  it("does not throw on unequal-and-candidate-higher (still rejects Wilcoxon, falls through)", () => {
    // Candidate mean (0.85) > parent mean (0.30) but arrays differ → Wilcoxon skipped.
    // CI 95% of [0.85, 0.85] is degenerate (Infinity-bounded); CI of [0.3, 0.31, 0.29] is small.
    // CI disjoint check may still fire when candidate CI is finite and above parent CI.
    const r = candidateBeatsParent([0.3, 0.31, 0.29], [0.85, 0.85]);
    expect(typeof r.beats).toBe("boolean");
    expect(r.parentMean).toBeCloseTo(0.3, 1);
    expect(r.candidateMean).toBeCloseTo(0.85, 5);
  });

  it("handles fully-empty candidate (all task evals failed) without throw", () => {
    const r = candidateBeatsParent([0.5, 0.6, 0.7], []);
    expect(r.beats).toBe(false);
    expect(r.reason).toMatch(/empty score array/);
    expect(r.candidateMean).toBe(0);
  });
});

function upperMinusLower(b: { lower: number; upper: number }): number {
  return b.upper - b.lower;
}
