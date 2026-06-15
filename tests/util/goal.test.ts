import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  GOAL_DIR,
  GoalSchema,
  classifyGoalReadError,
  clearGoal,
  readActiveGoal,
  readGoal,
  startGoal,
  stepGoal,
} from "../../src/util/goal.js";

describe("goal", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "composer-goal-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("startGoal persists and readActiveGoal round-trips", () => {
    const record = startGoal(root, {
      objective: "ship goal substrate",
      condition: "tests pass",
      checks: [{ name: "unit", command: "true" }],
      now: "2026-06-14T00:00:00.000Z",
      idHint: "goal-mvp",
    });

    expect(record.goalId).toBe("goal-mvp-2026-06-14t00-00-00.000z");
    expect(record.state).toBe("active");
    expect(record.turns).toBe(0);
    expect(record.checks[0]?.status).toBe("pending");
    expect(existsSync(join(root, GOAL_DIR, `${record.goalId}.json`))).toBe(true);
    expect(readFileSync(join(root, GOAL_DIR, ".active"), "utf8").trim()).toBe(record.goalId);

    const active = readActiveGoal(root);
    expect(active?.goalId).toBe(record.goalId);
    expect(active?.objective).toBe("ship goal substrate");
  });

  it("second startGoal while active throws", () => {
    startGoal(root, {
      objective: "one",
      condition: "done",
      now: "2026-06-14T00:00:00.000Z",
      idHint: "one",
    });

    expect(() => startGoal(root, {
      objective: "two",
      condition: "done",
      now: "2026-06-14T00:01:00.000Z",
      idHint: "two",
    })).toThrow(/open goal already exists/);
  });

  it("readActiveGoal uses the active-goal index when it is valid", () => {
    const record = startGoal(root, {
      objective: "indexed",
      condition: "active index points here",
      now: "2026-06-14T00:00:00.000Z",
      idHint: "indexed",
    });

    expect(readActiveGoal(root)?.goalId).toBe(record.goalId);
    expect(readFileSync(join(root, GOAL_DIR, ".active"), "utf8").trim()).toBe(record.goalId);
  });

  it("readActiveGoal falls back to scan and refreshes when the active-goal index is missing", () => {
    const record = startGoal(root, {
      objective: "missing index",
      condition: "scan still finds it",
      now: "2026-06-14T00:00:00.000Z",
      idHint: "missing-index",
    });
    rmSync(join(root, GOAL_DIR, ".active"), { force: true });

    expect(readActiveGoal(root)?.goalId).toBe(record.goalId);
    expect(readFileSync(join(root, GOAL_DIR, ".active"), "utf8").trim()).toBe(record.goalId);
  });

  it("readActiveGoal falls back to scan when the active-goal index is stale", () => {
    const first = startGoal(root, {
      objective: "terminal indexed",
      condition: "first completes",
      checks: [{ name: "pass", command: "true" }],
      now: "2026-06-14T00:00:00.000Z",
      idHint: "terminal-indexed",
    });
    stepGoal(root, {
      goalId: first.goalId,
      signals: { checkResults: [{ name: "pass", passed: true }] },
    });
    const second = startGoal(root, {
      objective: "real active",
      condition: "scan finds second",
      now: "2026-06-14T00:01:00.000Z",
      idHint: "real-active",
    });
    writeFileSync(join(root, GOAL_DIR, ".active"), `${first.goalId}\n`, "utf8");

    expect(readActiveGoal(root)?.goalId).toBe(second.goalId);
    expect(readFileSync(join(root, GOAL_DIR, ".active"), "utf8").trim()).toBe(second.goalId);
  });

  it("readActiveGoal falls back to scan when the active-goal index points to a nonexistent goal", () => {
    const record = startGoal(root, {
      objective: "nonexistent index",
      condition: "scan still wins",
      now: "2026-06-14T00:00:00.000Z",
      idHint: "nonexistent-index",
    });
    writeFileSync(join(root, GOAL_DIR, ".active"), "missing-goal\n", "utf8");

    expect(readActiveGoal(root)?.goalId).toBe(record.goalId);
    expect(readFileSync(join(root, GOAL_DIR, ".active"), "utf8").trim()).toBe(record.goalId);
  });

  it("startGoal rejects a second open goal even when the active-goal index is deleted", () => {
    const record = startGoal(root, {
      objective: "scan invariant",
      condition: "one open goal",
      now: "2026-06-14T00:00:00.000Z",
      idHint: "scan-invariant",
    });
    rmSync(join(root, GOAL_DIR, ".active"), { force: true });

    expect(() => startGoal(root, {
      objective: "second",
      condition: "must be rejected",
      now: "2026-06-14T00:01:00.000Z",
      idHint: "second",
    })).toThrow(`open goal already exists: ${record.goalId} (active)`);
  });

  it("startGoal rejects a second open goal even when the active-goal index is stale", () => {
    const record = startGoal(root, {
      objective: "scan invariant stale",
      condition: "one open goal",
      now: "2026-06-14T00:00:00.000Z",
      idHint: "scan-invariant-stale",
    });
    writeFileSync(join(root, GOAL_DIR, ".active"), "missing-goal\n", "utf8");

    expect(() => startGoal(root, {
      objective: "second",
      condition: "must be rejected",
      now: "2026-06-14T00:01:00.000Z",
      idHint: "second",
    })).toThrow(`open goal already exists: ${record.goalId} (active)`);
  });

  it("startGoal rejects duplicate check names", () => {
    expect(() => startGoal(root, {
      objective: "reject ambiguous checks",
      condition: "checks are unique",
      checks: [
        { name: "unit", command: "npm test" },
        { name: "unit", command: "npm run test:integration" },
      ],
      now: "2026-06-14T00:00:00.000Z",
      idHint: "duplicate-checks",
    })).toThrow("duplicate check name: unit");
  });

  it("GoalSchema rejects persisted records with duplicate check names", () => {
    const parsed = GoalSchema.safeParse({
      goalId: "duplicate-check-record",
      objective: "reject ambiguous persisted checks",
      condition: "checks are unique",
      checks: [
        { name: "unit", command: "npm test", status: "pending" },
        { name: "unit", command: "npm run test:integration", status: "pending" },
      ],
      state: "active",
      turns: 0,
      maxTurns: 12,
      createdAt: "2026-06-14T00:00:00.000Z",
      updatedAt: "2026-06-14T00:00:00.000Z",
      history: [],
    });

    expect(parsed.success).toBe(false);
  });

  it("ignores corrupt goal files while finding the valid active goal", () => {
    const record = startGoal(root, {
      objective: "valid active",
      condition: "still discoverable",
      now: "2026-06-14T00:00:00.000Z",
      idHint: "valid",
    });
    writeFileSync(join(root, GOAL_DIR, "junk.json"), "not json", "utf8");

    expect(readActiveGoal(root)?.goalId).toBe(record.goalId);
    expect(readGoal(root, "junk")).toBeNull();
    expect(() => startGoal(root, {
      objective: "second",
      condition: "done",
      now: "2026-06-14T00:01:00.000Z",
      idHint: "second",
    })).toThrow(/open goal already exists/);

    clearGoal(root, record.goalId);
    expect(startGoal(root, {
      objective: "after corrupt",
      condition: "start still works",
      now: "2026-06-14T00:02:00.000Z",
      idHint: "after-corrupt",
    }).goalId).toBe("after-corrupt-2026-06-14t00-02-00.000z");
  });

  it("classifies absent goal-file reads as missing and surfaces unreadable errors", () => {
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    const unreadable = Object.assign(new Error("permission denied"), { code: "EACCES" });

    expect(classifyGoalReadError(missing)).toBeNull();
    expect(() => classifyGoalReadError(unreadable)).toThrow("permission denied");
  });

  it("ignores a goal file whose embedded goalId does not match its filename", () => {
    mkdirSync(join(root, GOAL_DIR), { recursive: true });
    writeFileSync(join(root, GOAL_DIR, "blocking-file.json"), `${JSON.stringify({
      goalId: "different-internal-id",
      objective: "tampered active",
      condition: "should not block new goals",
      checks: [],
      state: "active",
      turns: 0,
      maxTurns: 12,
      createdAt: "2026-06-14T00:00:00.000Z",
      updatedAt: "2026-06-14T00:00:00.000Z",
      history: [],
    }, null, 2)}\n`, "utf8");

    expect(readGoal(root, "blocking-file")).toBeNull();
    expect(readActiveGoal(root)).toBeNull();
    expect(startGoal(root, {
      objective: "fresh goal",
      condition: "mismatched file ignored",
      now: "2026-06-14T00:01:00.000Z",
      idHint: "fresh",
    }).goalId).toBe("fresh-2026-06-14t00-01-00.000z");
  });

  it("does not overwrite an existing goal file when a new goal id would collide", () => {
    const first = startGoal(root, {
      objective: "original",
      condition: "kept",
      now: "2026-06-14T00:00:00.000Z",
      idHint: "collision",
    });
    clearGoal(root, first.goalId);
    const originalRaw = readFileSync(join(root, GOAL_DIR, `${first.goalId}.json`), "utf8");

    const second = startGoal(root, {
      objective: "new",
      condition: "separate file",
      now: "2026-06-14T00:00:00.000Z",
      idHint: "collision",
    });

    expect(second.goalId).toBe(`${first.goalId}-2`);
    expect(readFileSync(join(root, GOAL_DIR, `${first.goalId}.json`), "utf8")).toBe(originalRaw);
    expect(readGoal(root, first.goalId)?.objective).toBe("original");
    expect(readGoal(root, second.goalId)?.objective).toBe("new");
  });

  it("releases the goal lock after startGoal while preserving the one-open-goal invariant", () => {
    startGoal(root, {
      objective: "first",
      condition: "done",
      now: "2026-06-14T00:00:00.000Z",
      idHint: "first",
    });

    expect(() => startGoal(root, {
      objective: "second",
      condition: "done",
      now: "2026-06-14T00:01:00.000Z",
      idHint: "second",
    })).toThrow(/open goal already exists/);
    expect(existsSync(join(root, GOAL_DIR, ".lock"))).toBe(false);
  });

  it("blocked goals remain active for lookup and block a second startGoal", () => {
    const record = startGoal(root, {
      objective: "pause for budget",
      condition: "budget observed",
      maxCost: 1,
      maxTurns: 10,
      now: "2026-06-14T00:00:00.000Z",
      idHint: "blocked-open",
    });

    const blocked = stepGoal(root, {
      goalId: record.goalId,
      signals: { spentUsd: 1 },
    }).record;

    expect(blocked.state).toBe("blocked");
    expect(readActiveGoal(root)?.goalId).toBe(record.goalId);
    expect(() => startGoal(root, {
      objective: "second",
      condition: "done",
      now: "2026-06-14T00:01:00.000Z",
      idHint: "second",
    })).toThrow(/open goal already exists: .* \(blocked\)/);
  });

  it("keeps objective and condition immutable across step", () => {
    const record = startGoal(root, {
      objective: "immutable objective",
      condition: "immutable condition",
      checks: [{ name: "fail", command: "false" }],
      now: "2026-06-14T00:00:00.000Z",
      idHint: "immutable",
    });

    const stepped = stepGoal(root, { goalId: record.goalId }).record;

    expect(stepped.objective).toBe("immutable objective");
    expect(stepped.condition).toBe("immutable condition");
  });

  it("clearGoal sets the active goal to cancelled", () => {
    const record = startGoal(root, {
      objective: "cancel me",
      condition: "cancelled",
      now: "2026-06-14T00:00:00.000Z",
      idHint: "cancel",
    });

    const cleared = clearGoal(root);

    expect(cleared?.state).toBe("cancelled");
    expect(readGoal(root, record.goalId)?.state).toBe("cancelled");
    expect(readActiveGoal(root)).toBeNull();
  });

  it("clearGoal releases the lock and leaves cancelled goals terminal", () => {
    const record = startGoal(root, {
      objective: "cancel and continue",
      condition: "cancelled",
      now: "2026-06-14T00:00:00.000Z",
      idHint: "cancel-lock",
    });

    const cleared = clearGoal(root, record.goalId);

    expect(cleared?.state).toBe("cancelled");
    expect(() => stepGoal(root, { goalId: record.goalId }))
      .toThrow(`cannot step goal ${record.goalId}: state is cancelled (terminal)`);
    expect(existsSync(join(root, GOAL_DIR, ".lock"))).toBe(false);
    expect(startGoal(root, {
      objective: "new goal",
      condition: "lock was released",
      now: "2026-06-14T00:01:00.000Z",
      idHint: "new-after-clear",
    }).goalId).toBe("new-after-clear-2026-06-14t00-01-00.000z");
  });

  it("clearGoal is a no-op for terminal goals", () => {
    const record = startGoal(root, {
      objective: "already achieved",
      condition: "true passes",
      checks: [{ name: "pass", command: "true" }],
      now: "2026-06-14T00:00:00.000Z",
      idHint: "achieved-clear",
    });
    const achieved = stepGoal(root, {
      goalId: record.goalId,
      signals: { checkResults: [{ name: "pass", passed: true }] },
    }).record;
    const filePath = join(root, GOAL_DIR, `${record.goalId}.json`);
    const rawBefore = readFileSync(filePath, "utf8");

    const cleared = clearGoal(root, record.goalId);

    expect(achieved.state).toBe("achieved");
    expect(cleared?.state).toBe("achieved");
    expect(readGoal(root, record.goalId)?.state).toBe("achieved");
    expect(readFileSync(filePath, "utf8")).toBe(rawBefore);
  });

  it("clearGoal cancels blocked goals", () => {
    const record = startGoal(root, {
      objective: "cancel blocked",
      condition: "budget observed",
      maxCost: 1,
      maxTurns: 10,
      now: "2026-06-14T00:00:00.000Z",
      idHint: "cancel-blocked",
    });
    const blocked = stepGoal(root, {
      goalId: record.goalId,
      signals: { spentUsd: 1 },
    }).record;

    const cleared = clearGoal(root, record.goalId);

    expect(blocked.state).toBe("blocked");
    expect(cleared?.state).toBe("cancelled");
    expect(readGoal(root, record.goalId)?.state).toBe("cancelled");
  });

  it("stepGoal asks the orchestrator to run pending checks even when conditionMet is signalled", () => {
    const record = startGoal(root, {
      objective: "check exits",
      condition: "status captured",
      checks: [
        { name: "unit", command: "echo RAW_UNIT_COMMAND" },
        { name: "typecheck", command: "echo RAW_TYPECHECK_COMMAND" },
      ],
      now: "2026-06-14T00:00:00.000Z",
      idHint: "checks",
    });

    const result = stepGoal(root, {
      goalId: record.goalId,
      signals: { conditionMet: true },
    });

    expect(result.record.state).toBe("active");
    expect(result.record.checks.map((check) => check.status)).toEqual(["pending", "pending"]);
    expect(result.nextAction).toEqual({
      tool: "composer_goal_status",
      manualChecks: ["unit", "typecheck"],
      reason: "composer_goal_status shows the declared check commands; run them yourself, then call composer_goal_step with --check-result name=pass|fail for each",
    });
    expect(JSON.stringify(result.nextAction)).not.toContain("RAW_UNIT_COMMAND");
    expect(JSON.stringify(result.nextAction)).not.toContain("RAW_TYPECHECK_COMMAND");
  });

  it("stepGoal keeps a goal active when conditionMet false vetoes passing checks", () => {
    const record = startGoal(root, {
      objective: "achieve",
      condition: "true passes",
      checks: [{ name: "pass", command: "true" }],
      now: "2026-06-14T00:00:00.000Z",
      idHint: "achieve",
    });

    const result = stepGoal(root, {
      goalId: record.goalId,
      signals: {
        conditionMet: false,
        checkResults: [{ name: "pass", passed: true }],
      },
    });

    expect(result.record.state).toBe("active");
    expect(result.record.turns).toBe(1);
    expect(result.nextAction).toEqual({
      tool: "composer_code_cli",
      reason: "condition not yet met - keep working",
    });
    expect(result.record.conditionMet).toBe(false);
    expect(result.record.history?.[0]?.action).toBe("composer_code_cli");
  });

  it("stepGoal keeps a persisted conditionMet false veto until explicitly cleared", () => {
    const record = startGoal(root, {
      objective: "sticky veto",
      condition: "checks pass and caller agrees",
      checks: [{ name: "unit", command: "true" }],
      maxTurns: 10,
      now: "2026-06-14T00:00:00.000Z",
      idHint: "sticky-veto",
    });

    const vetoed = stepGoal(root, {
      goalId: record.goalId,
      signals: {
        conditionMet: false,
        checkResults: [{ name: "unit", passed: true }],
      },
    });
    const stillVetoed = stepGoal(root, { goalId: record.goalId });
    const achieved = stepGoal(root, {
      goalId: record.goalId,
      signals: { conditionMet: true },
    });

    expect(vetoed.record.state).toBe("active");
    expect(stillVetoed.record.state).toBe("active");
    expect(stillVetoed.record.conditionMet).toBe(false);
    expect(stillVetoed.nextAction).toEqual({
      tool: "composer_code_cli",
      reason: "condition not yet met - keep working",
    });
    expect(achieved.record.state).toBe("achieved");
    expect(achieved.record.conditionMet).toBe(true);
    expect(achieved.nextAction).toEqual({
      tool: "none",
      reason: "condition met",
    });
  });

  it("stepGoal rejects unknown checkResult names without mutating the goal", () => {
    const record = startGoal(root, {
      objective: "reject mistargeted result",
      condition: "declared check passes",
      checks: [{ name: "unit", command: "true" }],
      now: "2026-06-14T00:00:00.000Z",
      idHint: "unknown-check-result",
    });
    const filePath = join(root, GOAL_DIR, `${record.goalId}.json`);
    const before = readFileSync(filePath, "utf8");

    expect(() => stepGoal(root, {
      goalId: record.goalId,
      signals: { checkResults: [{ name: "typo", passed: true }] },
    })).toThrow("unknown check name in checkResults: typo");

    expect(readFileSync(filePath, "utf8")).toBe(before);
    expect(readGoal(root, record.goalId)?.checks[0]?.status).toBe("pending");
  });

  it("stepGoal still applies a valid checkResult name", () => {
    const record = startGoal(root, {
      objective: "accept declared result",
      condition: "declared check passes",
      checks: [{ name: "unit", command: "true" }],
      now: "2026-06-14T00:00:00.000Z",
      idHint: "valid-check-result",
    });

    const result = stepGoal(root, {
      goalId: record.goalId,
      signals: { checkResults: [{ name: "unit", passed: true }] },
    });

    expect(result.record.state).toBe("achieved");
    expect(result.record.checks[0]?.status).toBe("pass");
    expect(result.nextAction.tool).toBe("none");
  });

  it("stepGoal marks achieved when all checks pass and conditionMet is omitted", () => {
    const record = startGoal(root, {
      objective: "accept checks",
      condition: "declared check passes",
      checks: [{ name: "unit", command: "true" }],
      now: "2026-06-14T00:00:00.000Z",
      idHint: "checks-achieve",
    });

    const result = stepGoal(root, {
      goalId: record.goalId,
      signals: { checkResults: [{ name: "unit", passed: true }] },
    });

    expect(result.record.state).toBe("achieved");
    expect(result.nextAction).toEqual({
      tool: "none",
      reason: "condition met",
    });
  });

  it("stepGoal rejects duplicate checkResult names", () => {
    const record = startGoal(root, {
      objective: "reject ambiguous results",
      condition: "declared check passes",
      checks: [{ name: "unit", command: "true" }],
      now: "2026-06-14T00:00:00.000Z",
      idHint: "duplicate-check-result",
    });

    expect(() => stepGoal(root, {
      goalId: record.goalId,
      signals: {
        checkResults: [
          { name: "unit", passed: false },
          { name: "unit", passed: true },
        ],
      },
    })).toThrow("duplicate check name in checkResults: unit");
  });

  it("stepGoal refuses terminal goals", () => {
    const achieved = startGoal(root, {
      objective: "achieved",
      condition: "true passes",
      checks: [{ name: "pass", command: "true" }],
      now: "2026-06-14T00:00:00.000Z",
      idHint: "achieved-terminal",
    });
    stepGoal(root, {
      goalId: achieved.goalId,
      signals: { checkResults: [{ name: "pass", passed: true }] },
    });

    const cancelled = startGoal(root, {
      objective: "cancelled",
      condition: "cancelled",
      now: "2026-06-14T00:01:00.000Z",
      idHint: "cancelled-terminal",
    });
    clearGoal(root, cancelled.goalId);

    const failed = startGoal(root, {
      objective: "failed",
      condition: "false fails",
      checks: [{ name: "fail", command: "false" }],
      maxTurns: 1,
      now: "2026-06-14T00:02:00.000Z",
      idHint: "failed-terminal",
    });
    stepGoal(root, {
      goalId: failed.goalId,
      signals: { checkResults: [{ name: "fail", passed: false }] },
    });
    stepGoal(root, { goalId: failed.goalId });

    expect(() => stepGoal(root, { goalId: achieved.goalId }))
      .toThrow(`cannot step goal ${achieved.goalId}: state is achieved (terminal)`);
    expect(() => stepGoal(root, { goalId: cancelled.goalId }))
      .toThrow(`cannot step goal ${cancelled.goalId}: state is cancelled (terminal)`);
    expect(() => stepGoal(root, { goalId: failed.goalId }))
      .toThrow(`cannot step goal ${failed.goalId}: state is failed (terminal)`);
  });

  it("stepGoal resumes blocked goals with a budget extension and can progress", () => {
    const record = startGoal(root, {
      objective: "resume blocked",
      condition: "user intervenes",
      maxCost: 1,
      maxTurns: 10,
      now: "2026-06-14T00:00:00.000Z",
      idHint: "resume-blocked",
    });
    const blocked = stepGoal(root, {
      goalId: record.goalId,
      signals: { spentUsd: 1 },
    }).record;

    expect(blocked.state).toBe("blocked");

    const resumed = stepGoal(root, {
      goalId: record.goalId,
      signals: { budgetExtension: { maxCost: 2 } },
    });

    expect(resumed.record.turns).toBe(2);
    expect(resumed.record.state).toBe("active");
    expect(resumed.nextAction.tool).toBe("composer_code_cli");

    const achieved = stepGoal(root, {
      goalId: record.goalId,
      signals: { conditionMet: true },
    });
    expect(achieved.record.state).toBe("achieved");
  });

  it("stepGoal fails when turns exceed maxTurns with a failing check", () => {
    const record = startGoal(root, {
      objective: "block",
      condition: "too many turns",
      checks: [{ name: "fail", command: "false" }],
      maxTurns: 1,
      now: "2026-06-14T00:00:00.000Z",
      idHint: "block",
    });

    stepGoal(root, {
      goalId: record.goalId,
      signals: { checkResults: [{ name: "fail", passed: false }] },
    });
    const result = stepGoal(root, { goalId: record.goalId });

    expect(result.record.state).toBe("failed");
    expect(result.record.turns).toBe(2);
    expect(result.nextAction.tool).toBe("composer_goal_status");
    expect(result.nextAction.reason).toBe("condition not met within budget - goal failed");
  });

  it("stepGoal accumulates spentUsd and blocks when maxCost is crossed without failing checks", () => {
    const record = startGoal(root, {
      objective: "stay in budget",
      condition: "budget observed",
      maxCost: 1,
      maxTurns: 10,
      now: "2026-06-14T00:00:00.000Z",
      idHint: "budget",
    });

    const first = stepGoal(root, {
      goalId: record.goalId,
      signals: { spentUsd: 0.4 },
    });
    const second = stepGoal(root, {
      goalId: record.goalId,
      signals: { spentUsd: 0.6 },
    });

    expect(first.record.state).toBe("active");
    expect(first.record.spentUsd).toBe(0.4);
    expect(second.record.state).toBe("blocked");
    expect(second.record.spentUsd).toBe(1);
    expect(second.nextAction).toEqual({
      tool: "composer_goal_status",
      reason: "budget/turn cap reached - extend budget (budgetExtension) or clear",
    });
  });

  it("stepGoal does not mark achieved from conditionMet when a check is failing", () => {
    const record = startGoal(root, {
      objective: "do not trust transcript over checks",
      condition: "hard checks pass",
      checks: [{ name: "fail", command: "false" }],
      maxTurns: 10,
      now: "2026-06-14T00:00:00.000Z",
      idHint: "condition-met-failing-check",
    });

    const result = stepGoal(root, {
      goalId: record.goalId,
      signals: {
        conditionMet: true,
        checkResults: [{ name: "fail", passed: false }],
      },
    });

    expect(result.record.state).toBe("active");
    expect(result.nextAction.tool).not.toBe("none");
    expect(result.record.checks[0]?.status).toBe("fail");
  });

  it("stepGoal marks a check-less goal achieved when conditionMet is signalled", () => {
    const record = startGoal(root, {
      objective: "judge transcript",
      condition: "transcript says done",
      maxTurns: 10,
      now: "2026-06-14T00:00:00.000Z",
      idHint: "condition-met",
    });

    const result = stepGoal(root, {
      goalId: record.goalId,
      signals: { conditionMet: true },
    });

    expect(result.record.state).toBe("achieved");
    expect(result.nextAction).toEqual({
      tool: "none",
      reason: "condition met",
    });
    expect(result.record.conditionMet).toBe(true);
  });

  it("stepGoal keeps a check-less conditionMet false veto across signal-less steps", () => {
    const record = startGoal(root, {
      objective: "judge transcript conservatively",
      condition: "caller eventually agrees",
      maxTurns: 10,
      now: "2026-06-14T00:00:00.000Z",
      idHint: "condition-not-met",
    });

    const vetoed = stepGoal(root, {
      goalId: record.goalId,
      signals: { conditionMet: false },
    });
    const stillVetoed = stepGoal(root, { goalId: record.goalId });

    expect(vetoed.record.state).toBe("active");
    expect(vetoed.record.conditionMet).toBe(false);
    expect(stillVetoed.record.state).toBe("active");
    expect(stillVetoed.record.conditionMet).toBe(false);
    expect(stillVetoed.nextAction.tool).toBe("composer_code_cli");
  });

  it("stepGoal does not run checks when the turn cap is already exceeded with a prior failing check", () => {
    const record = startGoal(root, {
      objective: "stop before checks",
      condition: "check would pass if run",
      checks: [{ name: "previously failed", command: "false" }],
      maxTurns: 1,
      now: "2026-06-14T00:00:00.000Z",
      idHint: "turn-cap-prior-fail",
    });
    const first = stepGoal(root, {
      goalId: record.goalId,
      signals: { checkResults: [{ name: "previously failed", passed: false }] },
    }).record;
    const filePath = join(root, GOAL_DIR, `${record.goalId}.json`);
    writeFileSync(filePath, `${JSON.stringify({
      ...first,
      checks: first.checks.map((check) => ({ ...check, command: "true" })),
    }, null, 2)}\n`, "utf8");

    const result = stepGoal(root, { goalId: record.goalId });

    expect(result.record.state).toBe("failed");
    expect(result.record.turns).toBe(2);
    expect(result.record.checks[0]?.status).toBe("fail");
    expect(result.record.checks[0]?.command).toBe("true");
    expect(result.nextAction).toEqual({
      tool: "composer_goal_status",
      reason: "condition not met within budget - goal failed",
    });
  });

  it("stepGoal does not run checks when the turn cap is already exceeded without prior failing checks", () => {
    const record = startGoal(root, {
      objective: "blocked before checks",
      condition: "user decides",
      checks: [{ name: "would fail", command: "false" }],
      maxTurns: 1,
      now: "2026-06-14T00:00:00.000Z",
      idHint: "turn-cap-prior-nonfail",
    });
    const filePath = join(root, GOAL_DIR, `${record.goalId}.json`);
    writeFileSync(filePath, `${JSON.stringify({
      ...record,
      turns: 1,
    }, null, 2)}\n`, "utf8");

    const result = stepGoal(root, { goalId: record.goalId });

    expect(result.record.state).toBe("blocked");
    expect(result.record.turns).toBe(2);
    expect(result.record.checks[0]?.status).toBe("pending");
    expect(result.nextAction).toEqual({
      tool: "composer_goal_status",
      reason: "budget/turn cap reached - extend budget (budgetExtension) or clear",
    });
  });

  it("stepGoal records achieved when checks pass exactly at maxTurns", () => {
    const record = startGoal(root, {
      objective: "finish at cap",
      condition: "last turn passes",
      checks: [{ name: "pass", command: "true" }],
      maxTurns: 1,
      now: "2026-06-14T00:00:00.000Z",
      idHint: "exact-max-turns",
    });

    const result = stepGoal(root, {
      goalId: record.goalId,
      signals: { checkResults: [{ name: "pass", passed: true }] },
    });

    expect(result.record.state).toBe("achieved");
    expect(result.record.turns).toBe(1);
    expect(result.nextAction.tool).toBe("none");
  });

  it("stepGoal selects tactical rescue after two failed attempts", () => {
    const record = startGoal(root, {
      objective: "rescue",
      condition: "needs help",
      checks: [{ name: "fail", command: "false" }],
      maxTurns: 10,
      now: "2026-06-14T00:00:00.000Z",
      idHint: "rescue",
    });

    const result = stepGoal(root, {
      goalId: record.goalId,
      signals: {
        failedAttempts: 2,
        checkResults: [{ name: "fail", passed: false }],
      },
    });

    expect(result.record.state).toBe("active");
    expect(result.nextAction).toEqual({
      tool: "composer_codex_lifecycle_run",
      reason: "2+ failed attempts - tactical rescue",
    });
  });

  it("stepGoal selects strategic replan when stuck before tactical rescue", () => {
    const record = startGoal(root, {
      objective: "stuck",
      condition: "needs replan",
      checks: [{ name: "fail", command: "false" }],
      maxTurns: 10,
      now: "2026-06-14T00:00:00.000Z",
      idHint: "stuck",
    });

    const result = stepGoal(root, {
      goalId: record.goalId,
      signals: {
        stuck: true,
        failedAttempts: 2,
        checkResults: [{ name: "fail", passed: false }],
      },
    });

    expect(result.record.state).toBe("active");
    expect(result.nextAction).toEqual({
      tool: "composer_oracle_plan",
      reason: "stuck - strategic replan",
    });
  });

  it("stepGoal returns an advisory next action shape and persists history", () => {
    const record = startGoal(root, {
      objective: "fix",
      condition: "false becomes true",
      checks: [{ name: "fail", command: "false" }],
      maxTurns: 12,
      now: "2026-06-14T00:00:00.000Z",
      idHint: "fix",
    });

    const result = stepGoal(root, {
      goalId: record.goalId,
      signals: { checkResults: [{ name: "fail", passed: false }] },
    });
    const raw = JSON.parse(readFileSync(join(root, GOAL_DIR, `${record.goalId}.json`), "utf8"));

    expect(result.nextAction.tool).toBe("composer_code_cli");
    expect(result.nextAction.args).toBeUndefined();
    expect(result.nextAction.reason).toBe("checks failing - fix");
    expect(raw.history).toHaveLength(1);
    expect(raw.history[0].action).toBe("composer_code_cli");
  });

  it("stepGoal caps history at 100 entries", () => {
    const record = startGoal(root, {
      objective: "keep history bounded",
      condition: "eventually done",
      maxTurns: 200,
      now: "2026-06-14T00:00:00.000Z",
      idHint: "bounded-history",
    });

    let result = stepGoal(root, { goalId: record.goalId });
    for (let i = 1; i < 125; i += 1) {
      result = stepGoal(root, { goalId: record.goalId });
    }

    const raw = JSON.parse(readFileSync(join(root, GOAL_DIR, `${record.goalId}.json`), "utf8"));
    expect(result.record.history).toHaveLength(100);
    expect(raw.history).toHaveLength(100);
    expect(raw.history[0].turn).toBe(26);
    expect(raw.history[99].turn).toBe(125);
  });
});
