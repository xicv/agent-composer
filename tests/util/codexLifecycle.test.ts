import { describe, expect, it } from "vitest";

import {
  decideCodexLifecycle,
  resolveCodexLifecycle,
} from "../../src/util/codexLifecycle.js";

describe("resolveCodexLifecycle", () => {
  it("returns conservative defaults when omitted", () => {
    expect(resolveCodexLifecycle(undefined)).toEqual({
      enabled: false,
      mode: "ask",
      execution: "background",
      model: "gpt-5.4-mini",
      triggers: {
        postResearch: false,
        postPlan: true,
        postCodeApply: true,
        postTestFailure: true,
        afterFailedAttempts: true,
        preCommit: false,
        stopWarm: false,
      },
      thresholds: {
        minScore: 60,
        minExpectedOutputTokens: 500,
        minChangedFiles: 2,
        minDiffLines: 80,
        failedAttempts: 2,
      },
      fallback: {
        enabled: false,
        order: ["reviewerClaude", "reviewer", "coder"],
      },
      totalWallClockMs: 900000,
    });
  });
});

describe("decideCodexLifecycle", () => {
  it("skips when lifecycle participation is disabled", () => {
    const decision = decideCodexLifecycle(undefined, "postCodeApply", {
      changedFiles: 5,
      diffLines: 300,
      risk: "high",
    });

    expect(decision.action).toBe("skip");
    expect(decision.reasons).toEqual(["codexLifecycle disabled"]);
  });

  it("skips disabled triggers even when other signals are high", () => {
    const decision = decideCodexLifecycle(
      { enabled: true, triggers: { postCodeApply: false } },
      "postCodeApply",
      { changedFiles: 5, diffLines: 300, risk: "critical" },
    );

    expect(decision.action).toBe("skip");
    expect(decision.reasons).toEqual(["trigger postCodeApply disabled"]);
  });

  it("returns ask for a non-trivial post-code event in ask mode", () => {
    const decision = decideCodexLifecycle(
      { enabled: true, mode: "ask" },
      "postCodeApply",
      {
        expectedOutputTokens: 900,
        changedFiles: 3,
        diffLines: 120,
        touchesSecurity: true,
        hasHandoff: true,
      },
    );

    expect(decision.action).toBe("ask");
    expect(decision.score).toBeGreaterThanOrEqual(decision.threshold);
    expect(decision.model).toBe("gpt-5.4-mini");
    expect(decision.execution).toBe("background");
    expect(decision.reasons).toContain("security-sensitive surface");
  });

  it("returns run for qualifying events in auto mode", () => {
    const decision = decideCodexLifecycle(
      { enabled: true, mode: "auto" },
      "postTestFailure",
      {
        failingTests: true,
        failedAttempts: 2,
      },
    );

    expect(decision.action).toBe("run");
    expect(decision.reasons).toContain("test failure needs second opinion");
    expect(decision.reasons).toContain("failed attempts >= 2");
  });

  it("keeps trivial or destructive work out of Codex", () => {
    const trivial = decideCodexLifecycle(
      { enabled: true, mode: "auto", thresholds: { minScore: 10 } },
      "postPlan",
      {
        userRequestedCodex: false,
        isTrivial: true,
      },
    );
    const destructive = decideCodexLifecycle(
      { enabled: true, mode: "auto" },
      "postCodeApply",
      {
        userRequestedCodex: true,
        isDestructive: true,
      },
    );

    expect(trivial.action).toBe("skip");
    expect(trivial.reasons).toContain("trivial task penalty");
    expect(destructive.action).toBe("skip");
    expect(destructive.reasons).toEqual(["destructive action needs human control"]);
  });

  it("lets an explicit user request bypass the score threshold but not the trigger", () => {
    const decision = decideCodexLifecycle(
      { enabled: true, mode: "ask", thresholds: { minScore: 90 } },
      "postPlan",
      { userRequestedCodex: true },
    );

    expect(decision.action).toBe("ask");
    expect(decision.score).toBe(100);
    expect(decision.reasons).toEqual(["user explicitly requested Codex", "plan review before code"]);
  });
});
