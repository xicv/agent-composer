import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGoal } from "../../src/cli/goal.js";
import { appendAuditEvent } from "../../src/util/auditLog.js";
import { COMPOSER_STATE_DIR_ENV } from "../../src/util/codexLifecycleJob.js";

describe("runGoal", () => {
  let root: string;
  let stateDir: string;
  let previousComposerStateDir: string | undefined;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "composer-goal-cli-"));
    stateDir = mkdtempSync(join(tmpdir(), "composer-goal-cli-state-"));
    previousComposerStateDir = process.env[COMPOSER_STATE_DIR_ENV];
    process.env[COMPOSER_STATE_DIR_ENV] = stateDir;
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    if (previousComposerStateDir === undefined) delete process.env[COMPOSER_STATE_DIR_ENV];
    else process.env[COMPOSER_STATE_DIR_ENV] = previousComposerStateDir;
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("runs start, status, step, and clear against the persisted goal store", () => {
    const started = runGoal(root, {
      action: "start",
      flags: ["ship cli goal", "--condition", "checks pass", "--check", "unit=true", "--max-turns", "3"],
    });
    expect(started.state).toBe("active");
    expect(started.turns).toBe(0);
    expect(started.nextAction?.tool).toBe("composer_route_decide");

    const files = readdirSync(join(root, ".composer", "goals")).filter((name) => name.endsWith(".json"));
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

  it("goal report prints markdown for active goals by default and toggles commands", () => {
    appendAuditEvent(root, { kind: "tool-call", tool: "composer_code_cli" });
    runGoal(root, {
      action: "start",
      flags: ["report active", "--condition", "check visible", "--check", "unit=echo RAW_CLI_COMMAND"],
    });

    const report = runGoal(root, { action: "report", flags: [] });
    const output = writeSpy.mock.calls.at(-1)?.[0] as string;

    expect("goal" in report && report.goal.state).toBe("active");
    expect(output).toContain("# Goal Report");
    expect(output).toContain("| unit | pending |");
    expect(output).not.toContain("toolCalls=1");
    expect(output).not.toContain("- recent:");
    expect(output).not.toContain("composer_code_cli");
    expect(output).not.toContain("RAW_CLI_COMMAND");

    runGoal(root, { action: "report", flags: ["--include-commands"] });
    expect(writeSpy.mock.calls.at(-1)?.[0]).toContain("RAW_CLI_COMMAND");

    runGoal(root, { action: "report", flags: ["--audit"] });
    const withAudit = writeSpy.mock.calls.at(-1)?.[0] as string;
    expect(withAudit).toContain("## Recent project activity (not goal-scoped)");
    expect(withAudit).toContain("toolCalls=1");
    expect(withAudit).not.toContain("- recent:");
    expect(withAudit).not.toContain("composer_code_cli");

    runGoal(root, { action: "report", flags: ["--audit", "--include-audit-events"] });
    const withAuditEvents = writeSpy.mock.calls.at(-1)?.[0] as string;
    expect(withAuditEvents).toContain("- recent:");
    expect(withAuditEvents).toContain("composer_code_cli");
  });

  it("goal report boolean flags do not consume the positional goal id", () => {
    const started = runGoal(root, {
      action: "start",
      flags: ["boolean parser", "--condition", "goal id survives flags", "--check", "unit=echo RAW_CLI_COMMAND"],
    });

    const afterGoalId = runGoal(root, { action: "report", flags: [started.goalId!, "--include-commands"] });
    const afterGoalOutput = writeSpy.mock.calls.at(-1)?.[0] as string;
    expect("goal" in afterGoalId && afterGoalId.goal.goalId).toBe(started.goalId);
    expect(afterGoalOutput).toContain("RAW_CLI_COMMAND");

    const beforeGoalId = runGoal(root, { action: "report", flags: ["--include-commands", started.goalId!] });
    const beforeGoalOutput = writeSpy.mock.calls.at(-1)?.[0] as string;
    expect("goal" in beforeGoalId && beforeGoalId.goal.goalId).toBe(started.goalId);
    expect(beforeGoalOutput).toContain("RAW_CLI_COMMAND");

    const formatAfterGoalId = runGoal(root, {
      action: "report",
      flags: [started.goalId!, "--format", "json"],
    });
    expect("goal" in formatAfterGoalId && formatAfterGoalId.goal.goalId).toBe(started.goalId);
    expect(JSON.parse(writeSpy.mock.calls.at(-1)?.[0] as string).goal.goalId).toBe(started.goalId);

    const formatBeforeGoalId = runGoal(root, {
      action: "report",
      flags: ["--format", "json", started.goalId!],
    });
    expect("goal" in formatBeforeGoalId && formatBeforeGoalId.goal.goalId).toBe(started.goalId);
    expect(JSON.parse(writeSpy.mock.calls.at(-1)?.[0] as string).goal.goalId).toBe(started.goalId);
  });

  it("goal report prints json for terminal goals by id", () => {
    const started = runGoal(root, {
      action: "start",
      flags: ["report terminal", "--condition", "eventually terminal"],
    });
    runGoal(root, { action: "clear", flags: [started.goalId!] });

    const report = runGoal(root, {
      action: "report",
      flags: [started.goalId!, "--format", "json"],
    });
    const output = writeSpy.mock.calls.at(-1)?.[0] as string;

    expect("goal" in report && report.goal.state).toBe("cancelled");
    expect(JSON.parse(output).goal.state).toBe("cancelled");
  });
});
