import { describe, it, expect } from "vitest";
import {
  PlateauDetector,
  DEFAULT_PLATEAU_ROUNDS,
  DEFAULT_MIN_DELTA,
} from "../../src/evolve/plateau.js";

describe("DEFAULT constants — match locked design", () => {
  it("5 rounds, ≥0.01 delta threshold", () => {
    expect(DEFAULT_PLATEAU_ROUNDS).toBe(5);
    expect(DEFAULT_MIN_DELTA).toBeCloseTo(0.01, 6);
  });
});

describe("PlateauDetector", () => {
  it("does not signal stop before observing rounds", () => {
    const d = new PlateauDetector();
    expect(d.shouldStop()).toBe(false);
  });

  it("flags plateau after 5 rounds without ≥0.01 delta (1 baseline + 5 flat)", () => {
    const d = new PlateauDetector();
    d.observe(0.50); // baseline
    d.observe(0.501);
    d.observe(0.502);
    d.observe(0.503);
    d.observe(0.504);
    d.observe(0.505);
    expect(d.shouldStop()).toBe(true);
  });

  it("resets counter when delta ≥ minDelta is observed", () => {
    const d = new PlateauDetector();
    d.observe(0.50);
    d.observe(0.501);
    d.observe(0.502);
    d.observe(0.503);
    // Big jump → reset
    d.observe(0.60);
    expect(d.shouldStop()).toBe(false);
    expect(d.consecutiveFlatRounds).toBe(0);
  });

  it("custom rounds + minDelta override", () => {
    const d = new PlateauDetector({ rounds: 2, minDelta: 0.05 });
    d.observe(0.5); // baseline
    d.observe(0.52); // flat #1 (delta 0.02 < 0.05)
    d.observe(0.54); // flat #2
    expect(d.shouldStop()).toBe(true);
  });

  it("requires reSurvived flag before terminating run", () => {
    const d = new PlateauDetector();
    d.observe(0.50);
    d.observe(0.501);
    d.observe(0.502);
    d.observe(0.503);
    d.observe(0.504);
    d.observe(0.505);
    expect(d.shouldStop()).toBe(true);
    expect(d.terminate(false)).toBe(false);
    expect(d.terminate(true)).toBe(true);
  });

  it("regression: a drop also counts as flat (no improvement)", () => {
    const d = new PlateauDetector();
    d.observe(0.5);
    d.observe(0.4); // drop
    expect(d.consecutiveFlatRounds).toBe(1);
  });
});
