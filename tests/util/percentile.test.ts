import { describe, it, expect } from "vitest";
import { percentile, summarizeLatency } from "../../src/util/percentile.js";

describe("percentile", () => {
  it("returns 0 for empty samples", () => {
    expect(percentile([], 0.5)).toBe(0);
  });

  it("uses nearest-rank indexes for known small arrays", () => {
    const samples = [40, 10, 20, 30];

    expect(percentile(samples, 0.5)).toBe(30);
    expect(percentile(samples, 0.95)).toBe(40);
    expect(percentile(samples, 0.99)).toBe(40);
  });

  it("does not mutate the input array", () => {
    const samples = [3, 1, 2];

    percentile(samples, 0.5);

    expect(samples).toEqual([3, 1, 2]);
  });
});

describe("summarizeLatency", () => {
  it("summarizes count, p50, p95, p99, and max", () => {
    expect(summarizeLatency([5, 1, 9, 3])).toEqual({
      count: 4,
      p50: 5,
      p95: 9,
      p99: 9,
      max: 9,
    });
  });
});
