import { describe, it, expect } from "vitest";
import { parseArgs, enforceSpendCap, SpendCapExceededError, syntheticScore } from "../../scripts/run-evolve.js";
import type { ComposerConfig } from "../../src/config/schema.js";

describe("run-evolve helpers", () => {
  describe("parseArgs", () => {
    it("returns defaults for empty argv", () => {
      const result = parseArgs([]);
      expect(result.budgetUsd).toBe(2.0);
      expect(result.maxRounds).toBe(10);
    });

    it("parses explicit --budget-usd and --max-rounds", () => {
      const result = parseArgs(["--budget-usd", "0.50", "--max-rounds", "3"]);
      expect(result.budgetUsd).toBe(0.5);
      expect(result.maxRounds).toBe(3);
    });

    it("throws on unknown flag", () => {
      expect(() => parseArgs(["--unknown-flag"])).toThrow("unknown flag: --unknown-flag");
    });

    it("throws when --budget-usd value is non-numeric", () => {
      expect(() => parseArgs(["--budget-usd", "abc"])).toThrow('--budget-usd: "abc" is not a number');
    });

    it("throws when --budget-usd is negative", () => {
      expect(() => parseArgs(["--budget-usd", "-1.0"])).toThrow("--budget-usd must be non-negative");
    });

    it("throws when --budget-usd lacks a value", () => {
      expect(() => parseArgs(["--budget-usd"])).toThrow("--budget-usd requires a value");
    });

    it("throws when --max-rounds value is non-numeric", () => {
      expect(() => parseArgs(["--max-rounds", "xyz"])).toThrow('--max-rounds: "xyz" is not a number');
    });

    it("throws when --max-rounds is negative", () => {
      expect(() => parseArgs(["--max-rounds", "-5"])).toThrow("--max-rounds must be non-negative");
    });
  });

  describe("enforceSpendCap", () => {
    const mockRoles = {
      researcher: { provider: "mock" as const },
      coder: { provider: "mock" as const },
      reviewer: { provider: "mock" as const },
    };

    it("throws SpendCapExceededError when budget exceeds maxUsdPerSession", () => {
      const config: ComposerConfig = {
        roles: mockRoles,
        spendAuthorization: { mode: "auto", maxUsdPerSession: 0.1 },
      };
      expect(() => enforceSpendCap(config, 5.0)).toThrow(SpendCapExceededError);
    });

    it("does not throw when budget equals maxUsdPerSession", () => {
      const config: ComposerConfig = {
        roles: mockRoles,
        spendAuthorization: { mode: "auto", maxUsdPerSession: 1.0 },
      };
      expect(() => enforceSpendCap(config, 1.0)).not.toThrow();
    });

    it("does not throw when budget is less than maxUsdPerSession", () => {
      const config: ComposerConfig = {
        roles: mockRoles,
        spendAuthorization: { mode: "auto", maxUsdPerSession: 5.0 },
      };
      expect(() => enforceSpendCap(config, 2.0)).not.toThrow();
    });

    it("does not throw when spendAuthorization is undefined", () => {
      const config: ComposerConfig = { roles: mockRoles };
      expect(() => enforceSpendCap(config, 100.0)).not.toThrow();
    });

    it("does not throw when maxUsdPerSession is undefined", () => {
      const config: ComposerConfig = {
        roles: mockRoles,
        spendAuthorization: { mode: "auto" },
      };
      expect(() => enforceSpendCap(config, 50.0)).not.toThrow();
    });
  });

  describe("syntheticScore", () => {
    it("scores empty string as 0", () => {
      expect(syntheticScore("")).toBe(0);
    });

    it("scores skill with both keywords near 4000-char peak as > 0.9", () => {
      // 14 chars of keywords + 3986 'x' = 4000 chars total → peak length score.
      const skill = "dispatch Read " + "x".repeat(3986);
      const score = syntheticScore(skill);
      expect(score).toBeGreaterThan(0.9);
    });

    it("scores skill with both keywords at short length (114 chars) as ~0.6", () => {
      const skill = "dispatch Read " + "y".repeat(100);
      expect(syntheticScore(skill)).toBeCloseTo(0.6, 5);
    });

    it("awards 0.4 for dispatch keyword alone", () => {
      const score = syntheticScore("dispatch is present");
      expect(score).toBe(0.4);
    });

    it("awards 0.2 for Read tool name alone", () => {
      const score = syntheticScore("Read file content");
      expect(score).toBe(0.2);
    });

    it("scales length score higher at 4000 than 3000 chars", () => {
      const skill4000 = "x".repeat(4000) + " dispatch Read";
      const skill3000 = "x".repeat(3000) + " dispatch Read";
      expect(syntheticScore(skill4000)).toBeGreaterThan(syntheticScore(skill3000));
    });

    it("returns 0 length component for lengths outside [2000, 6000]", () => {
      const short = "x".repeat(100) + " dispatch Read";
      const long = "x".repeat(10000) + " dispatch Read";
      expect(syntheticScore(short)).toBeCloseTo(0.6, 5);
      expect(syntheticScore(long)).toBeCloseTo(0.6, 5);
    });

    it("is case-insensitive for dispatch", () => {
      expect(syntheticScore("dispatch here")).toBeGreaterThanOrEqual(0.4);
      expect(syntheticScore("DISPATCH HERE")).toBeGreaterThanOrEqual(0.4);
      expect(syntheticScore("DiSpAtCh here")).toBeGreaterThanOrEqual(0.4);
    });

    it("is case-sensitive for Read", () => {
      expect(syntheticScore("Read file")).toBeGreaterThan(syntheticScore("read file"));
    });

    it("clamps result to [0, 1]", () => {
      const skill = "dispatch Read " + "x".repeat(4000);
      const score = syntheticScore(skill);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });
  });
});
