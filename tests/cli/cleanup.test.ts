import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCleanupArgs, planCleanup, runCleanup } from "../../src/cli/cleanup.js";
import { clearGoal, startGoal } from "../../src/util/goal.js";

// ---------------------------------------------------------------------------
// parseCleanupArgs
// ---------------------------------------------------------------------------
describe("parseCleanupArgs", () => {
  it("[] → empty opts", () => {
    expect(parseCleanupArgs([])).toEqual({});
  });

  it("['--oracle'] → {oracle:true}", () => {
    expect(parseCleanupArgs(["--oracle"])).toEqual({ oracle: true });
  });

  it("['--state','--dry-run'] → {state:true,dryRun:true}", () => {
    expect(parseCleanupArgs(["--state", "--dry-run"])).toEqual({ state: true, dryRun: true });
  });

  it("['--older-than','14d'] → olderThanMs = 14 * 86400000", () => {
    const result = parseCleanupArgs(["--older-than", "14d"]);
    expect(result).toEqual({ olderThanMs: 14 * 86400000 });
  });

  it("['--older-than=12h'] → olderThanMs = 12 * 3600000", () => {
    const result = parseCleanupArgs(["--older-than=12h"]);
    expect(result).toEqual({ olderThanMs: 12 * 3600000 });
  });

  it("['--older-than','bogus'] → has error", () => {
    const result = parseCleanupArgs(["--older-than", "bogus"]);
    expect(result).toHaveProperty("error");
  });

  it("['--nope'] → has error", () => {
    const result = parseCleanupArgs(["--nope"]);
    expect(result).toHaveProperty("error");
  });
});

// ---------------------------------------------------------------------------
// planCleanup
// ---------------------------------------------------------------------------
describe("planCleanup", () => {
  let projectRoot: string;
  let stateDir: string;
  let terminalGoalPath: string;
  let activeGoalPath: string;
  let lockPath: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "composer-cleanup-proj-"));
    stateDir = mkdtempSync(join(tmpdir(), "composer-cleanup-state-"));

    // .composer/oracle/<a>
    mkdirSync(join(projectRoot, ".composer", "oracle"), { recursive: true });
    writeFileSync(join(projectRoot, ".composer", "oracle", "a"), "");

    // .composer/results/<b>
    mkdirSync(join(projectRoot, ".composer", "results"), { recursive: true });
    writeFileSync(join(projectRoot, ".composer", "results", "b"), "");

    const terminal = startGoal(projectRoot, {
      objective: "done goal",
      condition: "can be cleaned",
      idHint: "terminal",
    });
    clearGoal(projectRoot, terminal.goalId);
    const active = startGoal(projectRoot, {
      objective: "open goal",
      condition: "must persist",
      idHint: "active",
    });
    terminalGoalPath = join(projectRoot, ".composer", "goals", `${terminal.goalId}.json`);
    activeGoalPath = join(projectRoot, ".composer", "goals", `${active.goalId}.json`);
    lockPath = join(projectRoot, ".composer", "goals", ".lock");
    writeFileSync(lockPath, "{}");

    // <stateDir>/oracle-jobs/<c>
    mkdirSync(join(stateDir, "oracle-jobs"), { recursive: true });
    writeFileSync(join(stateDir, "oracle-jobs", "c"), "");

    // <stateDir>/codex-lifecycle/<d>
    mkdirSync(join(stateDir, "codex-lifecycle"), { recursive: true });
    writeFileSync(join(stateDir, "codex-lifecycle", "d"), "");
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  function makeEnv(nowMs?: number) {
    return { projectRoot, stateDir, nowMs: nowMs ?? Date.now() };
  }

  it("planCleanup({}) includes all project and state entry paths", () => {
    const result = planCleanup({}, makeEnv());
    expect(result).toContain(join(projectRoot, ".composer", "oracle", "a"));
    expect(result).toContain(join(projectRoot, ".composer", "results", "b"));
    expect(result).toContain(terminalGoalPath);
    expect(result).not.toContain(activeGoalPath);
    expect(result).not.toContain(lockPath);
    expect(result).toContain(join(stateDir, "oracle-jobs", "c"));
    expect(result).toContain(join(stateDir, "codex-lifecycle", "d"));
  });

  it("planCleanup({oracle:true}) includes oracle entries, excludes results + codex-lifecycle", () => {
    const result = planCleanup({ oracle: true }, makeEnv());
    expect(result).toContain(join(projectRoot, ".composer", "oracle", "a"));
    expect(result).toContain(join(stateDir, "oracle-jobs", "c"));
    expect(result).not.toContain(join(projectRoot, ".composer", "results", "b"));
    expect(result).not.toContain(terminalGoalPath);
    expect(result).not.toContain(activeGoalPath);
    expect(result).not.toContain(join(stateDir, "codex-lifecycle", "d"));
  });

  it("planCleanup({state:true}) includes only state entries", () => {
    const result = planCleanup({ state: true }, makeEnv());
    expect(result).toContain(join(stateDir, "oracle-jobs", "c"));
    expect(result).toContain(join(stateDir, "codex-lifecycle", "d"));
    expect(result).not.toContain(join(projectRoot, ".composer", "oracle", "a"));
    expect(result).not.toContain(join(projectRoot, ".composer", "results", "b"));
    expect(result).not.toContain(terminalGoalPath);
    expect(result).not.toContain(activeGoalPath);
  });

  it("olderThanMs huge + nowMs far in future → no entries pass the age filter", () => {
    const nowMs = Date.now() + 1_000_000_000; // far future
    const result = planCleanup({ olderThanMs: 999_999_999_999 }, makeEnv(nowMs));
    expect(result).toHaveLength(0);
  });

  it("olderThanMs=0 with nowMs slightly in future → all entries included (age >= 0)", () => {
    // Add 1 second to nowMs so mtime is never newer than "now" from the filter's perspective.
    const result = planCleanup({ olderThanMs: 0 }, makeEnv(Date.now() + 1000));
    expect(result).toContain(join(projectRoot, ".composer", "oracle", "a"));
    expect(result).toContain(join(projectRoot, ".composer", "results", "b"));
    expect(result).toContain(terminalGoalPath);
    expect(result).not.toContain(activeGoalPath);
    expect(result).not.toContain(lockPath);
    expect(result).toContain(join(stateDir, "oracle-jobs", "c"));
    expect(result).toContain(join(stateDir, "codex-lifecycle", "d"));
  });
});

// ---------------------------------------------------------------------------
// runCleanup (dry run)
// ---------------------------------------------------------------------------
describe("runCleanup dryRun", () => {
  let projectRoot: string;
  let stateDir: string;
  let terminalGoalPath: string;
  let activeGoalPath: string;
  let lockPath: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "composer-cleanup-dry-"));
    stateDir = mkdtempSync(join(tmpdir(), "composer-cleanup-dry-state-"));

    mkdirSync(join(projectRoot, ".composer", "oracle"), { recursive: true });
    writeFileSync(join(projectRoot, ".composer", "oracle", "x"), "");
    const terminal = startGoal(projectRoot, {
      objective: "done dry-run goal",
      condition: "can be cleaned",
      idHint: "terminal-dry",
    });
    clearGoal(projectRoot, terminal.goalId);
    const active = startGoal(projectRoot, {
      objective: "open dry-run goal",
      condition: "must persist",
      idHint: "active-dry",
    });
    terminalGoalPath = join(projectRoot, ".composer", "goals", `${terminal.goalId}.json`);
    activeGoalPath = join(projectRoot, ".composer", "goals", `${active.goalId}.json`);
    lockPath = join(projectRoot, ".composer", "goals", ".lock");
    writeFileSync(lockPath, "{}");
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("dryRun:true returns removed list without deleting files", () => {
    const target = join(projectRoot, ".composer", "oracle", "x");
    const result = runCleanup({ dryRun: true }, { projectRoot, stateDir, nowMs: Date.now() });
    expect(result.dryRun).toBe(true);
    expect(result.removed).toContain(target);
    expect(result.removed).toContain(terminalGoalPath);
    expect(result.removed).not.toContain(activeGoalPath);
    expect(result.removed).not.toContain(lockPath);
    // File must still exist — dry run must not delete
    expect(existsSync(target)).toBe(true);
    expect(existsSync(terminalGoalPath)).toBe(true);
    expect(existsSync(activeGoalPath)).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
  });

  it("removes terminal goal records and preserves open goals plus the lock file", () => {
    const result = runCleanup({}, { projectRoot, stateDir, nowMs: Date.now() });
    expect(result.removed).toContain(terminalGoalPath);
    expect(result.removed).not.toContain(activeGoalPath);
    expect(result.removed).not.toContain(lockPath);
    expect(existsSync(terminalGoalPath)).toBe(false);
    expect(existsSync(activeGoalPath)).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
  });
});
