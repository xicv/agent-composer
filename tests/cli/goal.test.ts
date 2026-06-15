import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGoal } from "../../src/cli/goal.js";

describe("runGoal", () => {
  let root: string;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "composer-goal-cli-"));
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    rmSync(root, { recursive: true, force: true });
  });

  it("runs start, status, step, and clear against the persisted goal store", () => {
    const started = runGoal(root, {
      action: "start",
      flags: ["ship cli goal", "--condition", "checks pass", "--check", "unit=true", "--max-turns", "3"],
    });
    expect(started.state).toBe("active");
    expect(started.turns).toBe(0);
    expect(started.nextAction?.tool).toBe("composer_route_decide");

    const files = readdirSync(join(root, ".composer", "goals"));
    expect(files).toHaveLength(1);
    expect(existsSync(join(root, ".composer", "goals", files[0]!))).toBe(true);

    const status = runGoal(root, { action: "status", flags: [] });
    expect(status.state).toBe("active");
    expect(status.turns).toBe(0);

    const pending = runGoal(root, { action: "step", flags: [] });
    expect(pending.state).toBe("active");
    expect(pending.turns).toBe(1);
    expect(pending.nextAction).toMatchObject({
      tool: "composer_goal_status",
      manualChecks: ["unit"],
      reason: "composer_goal_status shows the declared check commands; run them yourself, then call composer_goal_step with --check-result name=pass|fail for each",
    });
    expect(JSON.stringify(pending.nextAction)).not.toContain("true");

    const stepped = runGoal(root, { action: "step", flags: ["--check-result", "unit=pass"] });
    expect(stepped.state).toBe("achieved");
    expect(stepped.turns).toBe(2);
    expect(stepped.nextAction?.tool).toBe("none");

    const cleared = runGoal(root, { action: "clear", flags: [started.goalId!] });
    expect(cleared).toEqual({ state: "achieved", goalId: started.goalId, changed: false });

    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("goal:active"));
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("goal:achieved"));
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("already achieved (unchanged)"));
  });

  it("prints cancelled when goal clear transitions an active goal", () => {
    const started = runGoal(root, {
      action: "start",
      flags: ["cancel active", "--condition", "cancel command works"],
    });

    const cleared = runGoal(root, { action: "clear", flags: [] });

    expect(cleared).toEqual({ state: "cancelled", goalId: started.goalId, changed: true });
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("goal:cancelled"));
  });

  it("marks a check-less goal achieved with goal step --condition-met", () => {
    runGoal(root, {
      action: "start",
      flags: ["judge transcript", "--condition", "condition is externally satisfied"],
    });

    const stepped = runGoal(root, { action: "step", flags: ["--condition-met"] });

    expect(stepped.state).toBe("achieved");
    expect(stepped.nextAction?.tool).toBe("none");
  });

  it("keeps an all-passing checked goal active with goal step --condition-not-met", () => {
    runGoal(root, {
      action: "start",
      flags: ["veto completion", "--condition", "external condition is satisfied", "--check", "unit=true"],
    });

    const stepped = runGoal(root, {
      action: "step",
      flags: ["--check-result", "unit=pass", "--condition-not-met"],
    });

    expect(stepped.state).toBe("active");
    expect(stepped.nextAction).toMatchObject({
      tool: "composer_code_cli",
      reason: "condition not yet met - keep working",
    });
  });

  it("rejects mutually exclusive condition flags on goal step", () => {
    runGoal(root, {
      action: "start",
      flags: ["contradict condition", "--condition", "condition signal is parsed"],
    });

    expect(() => runGoal(root, {
      action: "step",
      flags: ["--condition-met", "--condition-not-met"],
    })).toThrow("--condition-met and --condition-not-met are mutually exclusive");
  });

  it("blocks a goal with goal step --spent when maxCost is reached", () => {
    runGoal(root, {
      action: "start",
      flags: ["watch budget", "--condition", "stay under spend cap", "--max-cost", "1"],
    });

    const stepped = runGoal(root, { action: "step", flags: ["--spent", "1.25"] });

    expect(stepped.state).toBe("blocked");
    expect(stepped.nextAction?.tool).toBe("composer_goal_status");
    expect(stepped.lastReason).toBe("budget/turn cap reached - extend budget (budgetExtension) or clear");
  });

  it("rejects a non-numeric goal step --spent value", () => {
    runGoal(root, {
      action: "start",
      flags: ["watch invalid spend", "--condition", "spend is parsed"],
    });

    expect(() => runGoal(root, { action: "step", flags: ["--spent", "notanumber"] }))
      .toThrow('--spent expects a non-negative number, got "notanumber"');
  });

  it("accepts a valid goal step --spent value", () => {
    runGoal(root, {
      action: "start",
      flags: ["watch valid spend", "--condition", "spend is parsed", "--max-cost", "10"],
    });

    const stepped = runGoal(root, { action: "step", flags: ["--spent", "5"] });

    expect(stepped.state).toBe("active");
    expect(stepped.turns).toBe(1);
  });

  it("passes check results and budget extensions through goal step flags", () => {
    runGoal(root, {
      action: "start",
      flags: [
        "resume via cli",
        "--condition",
        "budget raised and checks pass",
        "--check",
        "unit=npm test",
        "--max-cost",
        "1",
      ],
    });

    const blocked = runGoal(root, { action: "step", flags: ["--spent", "1"] });
    expect(blocked.state).toBe("blocked");

    const achieved = runGoal(root, {
      action: "step",
      flags: ["--raise-max-cost", "2", "--check-result", "unit=pass"],
    });

    expect(achieved.state).toBe("achieved");
    expect(achieved.nextAction?.tool).toBe("none");
  });
});
