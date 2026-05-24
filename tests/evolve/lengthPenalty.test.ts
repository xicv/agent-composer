import { describe, it, expect } from "vitest";
import {
  estimateTokens,
  lengthPenalty,
  DEFAULT_LAMBDA,
} from "../../src/evolve/lengthPenalty.js";

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });
  it("counts whitespace-separated tokens roughly", () => {
    expect(estimateTokens("one two three")).toBe(3);
  });
  it("strips markdown bullet markers, counts payload words", () => {
    expect(estimateTokens("- a\n- b\n- c")).toBe(3);
  });
});

describe("lengthPenalty", () => {
  it("returns 0 for empty skill", () => {
    expect(lengthPenalty("")).toBe(0);
  });

  it("scales linearly with token count using default lambda", () => {
    const text = "one two three four five";
    const expected = -DEFAULT_LAMBDA * estimateTokens(text);
    expect(lengthPenalty(text)).toBeCloseTo(expected, 10);
  });

  it("accepts a custom lambda", () => {
    const text = "one two three";
    expect(lengthPenalty(text, 0.01)).toBeCloseTo(-0.03, 6);
  });

  it("rejects negative lambda", () => {
    expect(() => lengthPenalty("x", -0.001)).toThrow(/lambda/);
  });

  it("is monotonically more-negative for longer prompts", () => {
    const short = lengthPenalty("a b");
    const long = lengthPenalty("a b c d e f g h");
    expect(long).toBeLessThan(short);
  });

  it("default lambda matches handoff doc (≈0.001)", () => {
    expect(DEFAULT_LAMBDA).toBeCloseTo(0.001, 6);
  });
});
