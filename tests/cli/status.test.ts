import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { buildStatus, renderStatusLine, runStatus, statusEnvelope } from "../../src/cli/status.js";
import { newOracleJob, writeOracleJob } from "../../src/util/oracleJob.js";
import { COMPOSER_STATE_DIR_ENV } from "../../src/util/codexLifecycleJob.js";
import { appendAuditEvent } from "../../src/util/auditLog.js";
import { startGoal, stepGoal } from "../../src/util/goal.js";

const MINIMAL_CONFIG = JSON.stringify(
  {
    roles: {
      researcher: { provider: "mock", model: "researcher-mock" },
      coder: { provider: "mock", model: "coder-mock" },
      reviewer: { provider: "mock", model: "reviewer-mock" },
    },
  },
  null,
  2,
);

describe("buildStatus", () => {
  let tmp: string;
  let previousComposerConfig: string | undefined;
  let previousComposerProfile: string | undefined;
  let previousComposerStateDir: string | undefined;
  let previousComposerDisabled: string | undefined;
  let previousXdgConfigHome: string | undefined;
  let previousHome: string | undefined;
  let stateDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "composer-status-test-"));
    stateDir = mkdtempSync(join(tmpdir(), "composer-status-state-"));
    previousComposerConfig = process.env["COMPOSER_CONFIG"];
    previousComposerProfile = process.env["COMPOSER_PROFILE"];
    previousComposerStateDir = process.env[COMPOSER_STATE_DIR_ENV];
    previousComposerDisabled = process.env["COMPOSER_DISABLED"];
    previousXdgConfigHome = process.env["XDG_CONFIG_HOME"];
    previousHome = process.env["HOME"];
    delete process.env["COMPOSER_CONFIG"];
    delete process.env["COMPOSER_PROFILE"];
    delete process.env["COMPOSER_DISABLED"];
    delete process.env["XDG_CONFIG_HOME"];
    process.env["HOME"] = tmp;
    process.env[COMPOSER_STATE_DIR_ENV] = stateDir;
  });

  afterEach(() => {
    if (previousComposerConfig === undefined) delete process.env["COMPOSER_CONFIG"];
    else process.env["COMPOSER_CONFIG"] = previousComposerConfig;
    if (previousComposerProfile === undefined) delete process.env["COMPOSER_PROFILE"];
    else process.env["COMPOSER_PROFILE"] = previousComposerProfile;
    if (previousComposerStateDir === undefined) delete process.env[COMPOSER_STATE_DIR_ENV];
    else process.env[COMPOSER_STATE_DIR_ENV] = previousComposerStateDir;
    if (previousComposerDisabled === undefined) delete process.env["COMPOSER_DISABLED"];
    else process.env["COMPOSER_DISABLED"] = previousComposerDisabled;
    if (previousXdgConfigHome === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = previousXdgConfigHome;
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
    rmSync(tmp, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("returns config.exists:false and recommendation to init when composer.config.json is absent", () => {
    const status = buildStatus(tmp);

    expect(status.config.exists).toBe(false);
    expect(status.integrations.codexReview).toBe(false);
    expect(status.integrations.codexLifecycle).toBe(false);
    expect(status.integrations.oraclePlanner).toBe(false);
    expect(status.integrations.gitHook).toBe("off");
    expect(status.integrations.gitHookInstalled).toBe(false);
    expect(status.recommendation.nextAction).toBe("agent-composer init");
  });

  it("returns config.exists:false when config file is invalid JSON", () => {
    writeFileSync(join(tmp, "composer.config.json"), "{ broken json", "utf8");

    const status = buildStatus(tmp);

    expect(status.config.exists).toBe(false);
  });

  it("returns config.exists:true with a minimal valid config; integrations all false", () => {
    writeFileSync(join(tmp, "composer.config.json"), MINIMAL_CONFIG, "utf8");

    const status = buildStatus(tmp);

    expect(status.config.exists).toBe(true);
    expect(status.integrations.codexReview).toBe(false);
    expect(status.integrations.codexLifecycle).toBe(false);
    expect(status.integrations.oraclePlanner).toBe(false);
    expect(status.integrations.gitHook).toBe("off");
    expect(status.integrations.gitHookInstalled).toBe(false);
    expect(status.executorProfile).toEqual({
      active: null,
      source: "default",
      available: [],
      warnings: [],
    });
  });

  it("surfaces active executor profile selected from config", () => {
    const config = {
      roles: {
        researcher: { provider: "mock", model: "r" },
        coder: { provider: "mock", model: "c" },
        reviewer: { provider: "mock", model: "v" },
      },
      activeProfile: "mock-coder",
      profiles: {
        "z-last": {},
        "mock-coder": {
          roles: {
            coder: { provider: "mock", model: "profile-coder" },
          },
        },
      },
    };
    writeFileSync(join(tmp, "composer.config.json"), JSON.stringify(config), "utf8");

    const status = buildStatus(tmp);

    expect(status.executorProfile).toEqual({
      active: "mock-coder",
      source: "config",
      available: ["mock-coder", "z-last"],
      warnings: [],
    });
  });

  it("surfaces COMPOSER_PROFILE as the active executor profile source", () => {
    const config = {
      roles: {
        researcher: { provider: "mock", model: "r" },
        coder: { provider: "mock", model: "c" },
        reviewer: { provider: "mock", model: "v" },
      },
      activeProfile: "from-config",
      profiles: {
        "from-config": {
          roles: {
            coder: { provider: "mock", model: "config-coder" },
          },
        },
        "from-env": {
          roles: {
            coder: { provider: "mock", model: "env-coder" },
          },
        },
      },
    };
    writeFileSync(join(tmp, "composer.config.json"), JSON.stringify(config), "utf8");
    process.env["COMPOSER_PROFILE"] = "from-env";

    const status = buildStatus(tmp);

    expect(status.executorProfile).toEqual({
      active: "from-env",
      source: "env",
      available: ["from-config", "from-env"],
      warnings: [],
    });
  });

  it("reflects codexReview.enabled from config", () => {
    const config = {
      roles: {
        researcher: { provider: "mock", model: "r" },
        coder: { provider: "mock", model: "c" },
        reviewer: { provider: "mock", model: "v" },
      },
      codexReview: { enabled: true },
    };
    writeFileSync(join(tmp, "composer.config.json"), JSON.stringify(config), "utf8");

    const status = buildStatus(tmp);

    expect(status.integrations.codexReview).toBe(true);
  });

  it("reflects codexLifecycle.enabled from config", () => {
    const config = {
      roles: {
        researcher: { provider: "mock", model: "r" },
        coder: { provider: "mock", model: "c" },
        reviewer: { provider: "mock", model: "v" },
      },
      codexLifecycle: { enabled: true },
    };
    writeFileSync(join(tmp, "composer.config.json"), JSON.stringify(config), "utf8");

    const status = buildStatus(tmp);

    expect(status.integrations.codexLifecycle).toBe(true);
  });

  it("reflects oraclePlanner role presence in integrations.oraclePlanner", () => {
    const config = {
      roles: {
        researcher: { provider: "mock", model: "r" },
        coder: { provider: "mock", model: "c" },
        reviewer: { provider: "mock", model: "v" },
        oraclePlanner: { provider: "mock", model: "oracle" },
      },
    };
    writeFileSync(join(tmp, "composer.config.json"), JSON.stringify(config), "utf8");

    const status = buildStatus(tmp);

    expect(status.integrations.oraclePlanner).toBe(true);
  });

  it("reflects oracle.defaultMode and requireExplicitTag in config block", () => {
    const config = {
      roles: {
        researcher: { provider: "mock", model: "r" },
        coder: { provider: "mock", model: "c" },
        reviewer: { provider: "mock", model: "v" },
        oraclePlanner: { provider: "mock", model: "oracle" },
      },
      oracle: { defaultMode: "deep", requireExplicitTag: true },
    };
    writeFileSync(join(tmp, "composer.config.json"), JSON.stringify(config), "utf8");

    const status = buildStatus(tmp);

    expect(status.integrations.oraclePlanner).toBe(true);
    expect(status.config.oracleDefaultMode).toBe("deep");
    expect(status.config.oracleRequireExplicitTag).toBe(true);
  });

  it("oracle fields are absent when oracle block not configured", () => {
    writeFileSync(join(tmp, "composer.config.json"), MINIMAL_CONFIG, "utf8");

    const status = buildStatus(tmp);

    expect(status.config.oracleDefaultMode).toBeUndefined();
    expect(status.config.oracleRequireExplicitTag).toBeUndefined();
  });

  it("honors COMPOSER_CONFIG env var to locate config", () => {
    const subDir = join(tmp, "nested");
    mkdirSync(subDir, { recursive: true });
    const customPath = join(subDir, "custom.config.json");
    writeFileSync(customPath, MINIMAL_CONFIG, "utf8");
    process.env["COMPOSER_CONFIG"] = customPath;

    const status = buildStatus(tmp);

    expect(status.config.exists).toBe(true);
    expect(status.config.path).toBe(customPath);
  });

  it("deriveMode: config with codexReview.enabled=false + codexLifecycle.enabled=false → mode 'fast'", () => {
    const config = {
      roles: {
        researcher: { provider: "mock", model: "r" },
        coder: { provider: "mock", model: "c" },
        reviewer: { provider: "mock", model: "v" },
      },
      codexReview: { enabled: false },
      codexLifecycle: { enabled: false },
    };
    writeFileSync(join(tmp, "composer.config.json"), JSON.stringify(config), "utf8");

    const status = buildStatus(tmp);

    expect(status.config.mode).toBe("fast");
  });

  it("active.oracleJob is populated when a running oracle job exists, with correct ageSeconds", () => {
    writeFileSync(join(tmp, "composer.config.json"), MINIMAL_CONFIG, "utf8");

    const job = newOracleJob(tmp, { mode: "research" });
    const startedAt = new Date(Date.now() - 90_000).toISOString();
    const runningJob = { ...job, status: "running" as const, startedAt };
    writeOracleJob(tmp, runningJob);

    const nowMs = Date.parse(startedAt) + 90_000;
    const status = buildStatus(tmp, { nowMs });

    expect(status.active.oracleJob).toBeDefined();
    expect(status.active.oracleJob?.status).toBe("running");
    expect(status.active.oracleJob?.jobId).toBe(job.jobId);
    const age = status.active.oracleJob?.ageSeconds ?? -1;
    expect(age).toBeGreaterThanOrEqual(88);
    expect(age).toBeLessThanOrEqual(92);
    expect(status.recommendation.nextAction).toBe("composer_oracle_job_result");
  });

  it("GLOBAL CONFIG: finds composer.config.json in globalConfigDir when cwd has none", () => {
    const xdg = mkdtempSync(join(tmpdir(), "composer-status-xdg-"));
    const globalComposerDir = join(xdg, "composer");
    mkdirSync(globalComposerDir, { recursive: true });
    writeFileSync(join(globalComposerDir, "composer.config.json"), MINIMAL_CONFIG, "utf8");
    process.env["XDG_CONFIG_HOME"] = xdg;
    const emptyCwd = mkdtempSync(join(tmpdir(), "composer-status-empty-"));
    try {
      const status = buildStatus(emptyCwd);
      expect(status.config.exists).toBe(true);
    } finally {
      rmSync(xdg, { recursive: true, force: true });
      rmSync(emptyCwd, { recursive: true, force: true });
    }
  });

  it("DISABLED: COMPOSER_DISABLED=on → integrations.composerDisabled true", () => {
    process.env["COMPOSER_DISABLED"] = "on";
    const status = buildStatus(tmp);
    expect(status.integrations.composerDisabled).toBe(true);
  });

  it("LATEST-BY-KIND: finds route-decision even when a trailing note event exists after it", () => {
    writeFileSync(join(tmp, "composer.config.json"), MINIMAL_CONFIG, "utf8");
    appendAuditEvent(tmp, { kind: "route-decision", route: "composer-code-cli", taskClass: "implementation" });
    appendAuditEvent(tmp, { kind: "note", note: "a trailing note" });
    const status = buildStatus(tmp);
    expect(status.latest.route).toBe("composer-code-cli");
    expect(status.latest.taskClass).toBe("implementation");
  });

  it("status --fast keeps cheap gates and omits audit/job/goal scan fields", () => {
    const config = {
      roles: {
        researcher: { provider: "mock", model: "r" },
        coder: { provider: "mock", model: "c" },
        reviewer: { provider: "mock", model: "v" },
        oraclePlanner: { provider: "mock", model: "oracle" },
      },
      codexReview: { enabled: true },
      codexLifecycle: { enabled: true },
    };
    writeFileSync(join(tmp, "composer.config.json"), JSON.stringify(config), "utf8");
    appendAuditEvent(tmp, { kind: "route-decision", route: "composer-code-cli", taskClass: "implementation" });
    const job = newOracleJob(tmp, { mode: "research" });
    writeOracleJob(tmp, { ...job, status: "running", startedAt: new Date().toISOString() });
    startGoal(tmp, {
      objective: "fast status must not read this",
      condition: "goal is omitted",
      checks: [{ name: "unit", command: "true" }],
    });

    const status = buildStatus(tmp, { fast: true });
    const line = renderStatusLine(status);

    expect(status.fast).toBe(true);
    expect(status.config.mode).toBe("balanced");
    expect(status.integrations.codexReview).toBe(true);
    expect(status.integrations.codexLifecycle).toBe(true);
    expect(status.integrations.oraclePlanner).toBe(true);
    expect(status.latest.route).toBeUndefined();
    expect(status.latestJob.oracleJob).toBeUndefined();
    expect(status.active.oracleJob).toBeUndefined();
    expect(status.goal).toBeUndefined();
    expect(status.recommendation.nextAction).toBeUndefined();
    expect(line).toContain("CMP balanced");
    expect(line).toContain("R:on");
    expect(line).toContain("L:on");
    expect(line).toContain("O:idle");
    expect(line).toContain("H:off");
    expect(line).not.toContain("goal:");
    expect(line).not.toContain("active:");
    expect(line).not.toContain("last:");
    expect(line).not.toContain("next:");
    expect(line).not.toContain("undefined");
  });

  it("runStatus --fast composes with --line", () => {
    writeFileSync(join(tmp, "composer.config.json"), MINIMAL_CONFIG, "utf8");

    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    let line = "";
    try {
      runStatus(tmp, { fast: true, line: true });
      line = String(write.mock.calls.map((call) => call[0]).join(""));
    } finally {
      write.mockRestore();
    }

    expect(line).toMatch(/^CMP /);
    expect(line).toContain("R:off");
    expect(line).toContain("L:off");
    expect(line).not.toContain("last:");
    expect(line).not.toContain("active:");
    expect(line).not.toContain("undefined");
  });

  it("includes the active goal snapshot without running checks", () => {
    const goal = startGoal(tmp, {
      objective: "show goal status",
      condition: "status line includes it",
      checks: [{ name: "unit", command: "true" }],
    });

    const status = buildStatus(tmp);

    expect(status.goal).toEqual({
      goalId: goal.goalId,
      state: "active",
      turns: 0,
      nextReason: undefined,
    });
  });

  it("recommends composer_goal_step when a goal is active", () => {
    writeFileSync(join(tmp, "composer.config.json"), MINIMAL_CONFIG, "utf8");
    startGoal(tmp, {
      objective: "advance active goal",
      condition: "checks pass",
      checks: [{ name: "unit", command: "true" }],
    });

    const status = buildStatus(tmp);

    expect(status.recommendation).toEqual({
      nextAction: "composer_goal_step",
      reason: "active goal; advance the goal loop",
    });
  });

  it("recommends config setup when config is missing even if a goal is active", () => {
    startGoal(tmp, {
      objective: "do not hide missing config",
      condition: "config is set up",
      checks: [{ name: "unit", command: "true" }],
    });

    const status = buildStatus(tmp);

    expect(status.config.exists).toBe(false);
    expect(status.goal?.state).toBe("active");
    expect(status.recommendation).toEqual({
      nextAction: "agent-composer init",
      reason: "no composer.config.json found",
    });
  });

  it("recommends active oracle job before an active goal when config exists", () => {
    writeFileSync(join(tmp, "composer.config.json"), MINIMAL_CONFIG, "utf8");
    startGoal(tmp, {
      objective: "oracle should finish first",
      condition: "oracle job completed",
      checks: [{ name: "unit", command: "true" }],
    });
    const job = newOracleJob(tmp, { mode: "research" });
    writeOracleJob(tmp, { ...job, status: "running", startedAt: new Date().toISOString() });

    const status = buildStatus(tmp);

    expect(status.goal?.state).toBe("active");
    expect(status.active.oracleJob?.status).toBe("running");
    expect(status.recommendation).toEqual({
      nextAction: "composer_oracle_job_result",
      reason: "an Oracle job is in progress",
    });
  });

  it("recommends composer_goal_step when a goal is blocked", () => {
    writeFileSync(join(tmp, "composer.config.json"), MINIMAL_CONFIG, "utf8");
    const goal = startGoal(tmp, {
      objective: "advance blocked goal",
      condition: "budget is enough",
      maxCost: 1,
    });
    stepGoal(tmp, {
      goalId: goal.goalId,
      signals: { spentUsd: 2 },
    });

    const status = buildStatus(tmp);

    expect(status.goal?.state).toBe("blocked");
    expect(status.recommendation).toEqual({
      nextAction: "composer_goal_step",
      reason: "goal is blocked; extend budget, report check results, or clear",
    });
  });

  it("keeps the route recommendation when there is no active goal", () => {
    writeFileSync(join(tmp, "composer.config.json"), MINIMAL_CONFIG, "utf8");

    const status = buildStatus(tmp);

    expect(status.goal).toBeUndefined();
    expect(status.recommendation.nextAction).toBe("composer_route_decide");
  });

  it("shows a subtle report hint for a latest terminal goal without changing route recommendation", () => {
    writeFileSync(join(tmp, "composer.config.json"), MINIMAL_CONFIG, "utf8");
    const goal = startGoal(tmp, {
      objective: "terminal hint",
      condition: "check passes",
      checks: [{ name: "unit", command: "true" }],
    });
    stepGoal(tmp, {
      goalId: goal.goalId,
      signals: { checkResults: [{ name: "unit", passed: true }] },
    });

    const status = buildStatus(tmp);
    const line = renderStatusLine(status);

    expect(status.goal).toMatchObject({
      goalId: goal.goalId,
      state: "achieved",
      reportHint: true,
    });
    expect(status.recommendation).toEqual({
      nextAction: "composer_route_decide",
      reason: "ask Composer which lane fits the next task",
    });
    expect(line).toContain("goal:achieved (report)");
    expect(line).toContain("next:composer_route_decide");
  });

  it("ACTIVE-VS-LATEST: succeeded oracle job → latestJob present, active absent", () => {
    writeFileSync(join(tmp, "composer.config.json"), MINIMAL_CONFIG, "utf8");
    const job = newOracleJob(tmp, { mode: "research" });
    const succeededJob = { ...job, status: "succeeded" as const, startedAt: new Date(Date.now() - 5000).toISOString() };
    writeOracleJob(tmp, succeededJob);
    const status = buildStatus(tmp);
    expect(status.latestJob.oracleJob).toBeDefined();
    expect(status.latestJob.oracleJob?.status).toBe("succeeded");
    expect(status.active.oracleJob).toBeUndefined();
  });

  it("ACTIVE-VS-LATEST: running oracle job → both latestJob and active populated", () => {
    writeFileSync(join(tmp, "composer.config.json"), MINIMAL_CONFIG, "utf8");
    const job = newOracleJob(tmp, { mode: "research" });
    const runningJob = { ...job, status: "running" as const, startedAt: new Date(Date.now() - 3000).toISOString() };
    writeOracleJob(tmp, runningJob);
    const status = buildStatus(tmp);
    expect(status.latestJob.oracleJob).toBeDefined();
    expect(status.active.oracleJob).toBeDefined();
    expect(status.active.oracleJob?.status).toBe("running");
  });

  describe("gitHook tri-state", () => {
    function makeGitRepo(dir: string): void {
      execSync("git init", { cwd: dir, stdio: "ignore" });
      execSync('git config user.email "test@test.com"', { cwd: dir, stdio: "ignore" });
      execSync('git config user.name "Test"', { cwd: dir, stdio: "ignore" });
    }

    it("gitHook is 'off' when no pre-commit hook is present", () => {
      makeGitRepo(tmp);
      const status = buildStatus(tmp);
      expect(status.integrations.gitHook).toBe("off");
      expect(status.integrations.gitHookInstalled).toBe(false);
    });

    it("gitHook is 'on' when hook references script AND --git-hook marker", () => {
      makeGitRepo(tmp);
      const hooksDir = join(tmp, ".git", "hooks");
      mkdirSync(hooksDir, { recursive: true });
      const hookPath = join(hooksDir, "pre-commit");
      writeFileSync(hookPath, "#!/bin/sh\nbash scripts/precommit_codex_review.sh --git-hook\n", "utf8");
      chmodSync(hookPath, 0o755);
      const status = buildStatus(tmp);
      expect(status.integrations.gitHook).toBe("on");
      expect(status.integrations.gitHookInstalled).toBe(true);
    });

    it("gitHook is 'warn' when hook references script but NOT --git-hook marker", () => {
      makeGitRepo(tmp);
      const hooksDir = join(tmp, ".git", "hooks");
      mkdirSync(hooksDir, { recursive: true });
      const hookPath = join(hooksDir, "pre-commit");
      writeFileSync(hookPath, "#!/bin/sh\nbash scripts/precommit_codex_review.sh\n", "utf8");
      chmodSync(hookPath, 0o755);
      const status = buildStatus(tmp);
      expect(status.integrations.gitHook).toBe("warn");
      expect(status.integrations.gitHookInstalled).toBe(true);
    });

    it("gitHook is 'off' when hook is not executable", () => {
      makeGitRepo(tmp);
      const hooksDir = join(tmp, ".git", "hooks");
      mkdirSync(hooksDir, { recursive: true });
      const hookPath = join(hooksDir, "pre-commit");
      writeFileSync(hookPath, "#!/bin/sh\nbash scripts/precommit_codex_review.sh --git-hook\n", "utf8");
      chmodSync(hookPath, 0o644);
      const status = buildStatus(tmp);
      expect(status.integrations.gitHook).toBe("off");
      expect(status.integrations.gitHookInstalled).toBe(false);
    });
  });
});

describe("renderStatusLine", () => {
  let tmpHome: string;
  let previousComposerDisabled: string | undefined;
  let previousComposerDisabledFile: string | undefined;
  let previousComposerEnabled: string | undefined;
  let previousHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "composer-renderline-home-"));
    previousComposerDisabled = process.env["COMPOSER_DISABLED"];
    previousComposerDisabledFile = process.env["COMPOSER_DISABLED_FILE"];
    previousComposerEnabled = process.env["COMPOSER_ENABLED"];
    previousHome = process.env["HOME"];
    delete process.env["COMPOSER_DISABLED"];
    delete process.env["COMPOSER_DISABLED_FILE"];
    delete process.env["COMPOSER_ENABLED"];
    process.env["HOME"] = tmpHome;
  });

  afterEach(() => {
    if (previousComposerDisabled === undefined) delete process.env["COMPOSER_DISABLED"];
    else process.env["COMPOSER_DISABLED"] = previousComposerDisabled;
    if (previousComposerDisabledFile === undefined) delete process.env["COMPOSER_DISABLED_FILE"];
    else process.env["COMPOSER_DISABLED_FILE"] = previousComposerDisabledFile;
    if (previousComposerEnabled === undefined) delete process.env["COMPOSER_ENABLED"];
    else process.env["COMPOSER_ENABLED"] = previousComposerEnabled;
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns a single line starting with 'CMP ' containing R: L: O: H: and no objective text", () => {
    const tmp2 = mkdtempSync(join(tmpdir(), "composer-renderline-"));
    try {
      const s = buildStatus(tmp2);
      const line = renderStatusLine(s);

      expect(line.trim().split("\n").length).toBe(1);
      expect(line).toMatch(/^CMP /);
      expect(line).toContain("R:");
      expect(line).toContain("L:");
      expect(line).toContain("O:");
      expect(line).toContain("H:");
      // Must NOT contain objective/prompt/note style text
      expect(line).not.toContain("objective");
      expect(line).not.toContain("prompt");
      expect(line).not.toContain("note");
      expect(line).toContain("next:");
    } finally {
      rmSync(tmp2, { recursive: true, force: true });
    }
  });

  it("renderStatusLine without session does NOT include 'P:' segment", () => {
    const tmp2 = mkdtempSync(join(tmpdir(), "composer-renderline-nosession-"));
    try {
      const s = buildStatus(tmp2);
      const line = renderStatusLine(s);
      expect(line).not.toContain("P:");
    } finally {
      rmSync(tmp2, { recursive: true, force: true });
    }
  });

  it("renderStatusLine with session profile includes 'P:<profile>' after mode", () => {
    const tmp2 = mkdtempSync(join(tmpdir(), "composer-renderline-session-"));
    try {
      const s = buildStatus(tmp2);
      const line = renderStatusLine(s, { mode: "strict", profile: "deep", oracle: { enabled: true } });
      expect(line).toMatch(/^CMP strict · P:deep /);
      expect(line).toContain("P:deep");
    } finally {
      rmSync(tmp2, { recursive: true, force: true });
    }
  });

  it("renders the active goal segment after H", () => {
    const tmp2 = mkdtempSync(join(tmpdir(), "composer-renderline-goal-"));
    try {
      const goal = startGoal(tmp2, {
        objective: "render goal",
        condition: "check passes",
        checks: [{ name: "unit", command: "false" }],
      });
      stepGoal(tmp2, {
        goalId: goal.goalId,
        signals: { checkResults: [{ name: "unit", passed: false }] },
      });

      const line = renderStatusLine(buildStatus(tmp2));

      expect(line).toContain("H:off · goal:active 1t · next:checks failing - fix · active:none");
    } finally {
      rmSync(tmp2, { recursive: true, force: true });
    }
  });

  it("renderStatusLine session mode overrides config mode in display", () => {
    const tmp2 = mkdtempSync(join(tmpdir(), "composer-renderline-sessionmode-"));
    try {
      const s = buildStatus(tmp2);
      const line = renderStatusLine(s, { mode: "fast" });
      expect(line).toMatch(/^CMP fast /);
    } finally {
      rmSync(tmp2, { recursive: true, force: true });
    }
  });

  it("H: segment uses tri-state gitHook value (off/warn/on)", () => {
    const tmp2 = mkdtempSync(join(tmpdir(), "composer-renderline-hstate-"));
    try {
      const s = buildStatus(tmp2);
      // No git repo → gitHook is "off"
      const line = renderStatusLine(s);
      expect(line).toContain("H:off");
    } finally {
      rmSync(tmp2, { recursive: true, force: true });
    }
  });

  it("renderStatusLine with foreground run shows active:<tool-short> <age>s", () => {
    const tmp2 = mkdtempSync(join(tmpdir(), "composer-renderline-fg-"));
    try {
      const s = buildStatus(tmp2);
      s.active.foreground = [{ tool: "composer_code_cli", providerRole: undefined, ageSeconds: 42 }];
      const line = renderStatusLine(s);
      expect(line).toContain("active:code_cli 42s");
    } finally {
      rmSync(tmp2, { recursive: true, force: true });
    }
  });

  it("renderStatusLine with empty foreground shows active:none", () => {
    const tmp2 = mkdtempSync(join(tmpdir(), "composer-renderline-nofg-"));
    try {
      const s = buildStatus(tmp2);
      s.active.foreground = [];
      const line = renderStatusLine(s);
      expect(line).toContain("active:none");
    } finally {
      rmSync(tmp2, { recursive: true, force: true });
    }
  });

  it("renderStatusLine with undefined foreground shows active:none", () => {
    const tmp2 = mkdtempSync(join(tmpdir(), "composer-renderline-undefg-"));
    try {
      const s = buildStatus(tmp2);
      // foreground not set — should default to active:none
      const line = renderStatusLine(s);
      expect(line).toContain("active:none");
    } finally {
      rmSync(tmp2, { recursive: true, force: true });
    }
  });

  it("renderStatusLine with foreground run >= 60s shows minutes", () => {
    const tmp2 = mkdtempSync(join(tmpdir(), "composer-renderline-fgmin-"));
    try {
      const s = buildStatus(tmp2);
      s.active.foreground = [{ tool: "composer_research", providerRole: undefined, ageSeconds: 120 }];
      const line = renderStatusLine(s);
      expect(line).toContain("active:research 2m");
    } finally {
      rmSync(tmp2, { recursive: true, force: true });
    }
  });
});

describe("statusEnvelope", () => {
  it("wraps status with version:1 and a line field starting with CMP", () => {
    const tmp2 = mkdtempSync(join(tmpdir(), "composer-envelope-"));
    try {
      const status = buildStatus(tmp2);
      const envelope = statusEnvelope(status);
      expect(envelope.version).toBe(1);
      expect(typeof envelope.line).toBe("string");
      expect(envelope.line).toMatch(/^CMP /);
      expect(envelope.line).toContain("next:");
    } finally {
      rmSync(tmp2, { recursive: true, force: true });
    }
  });

  it("statusEnvelope with session renders session mode and profile in line", () => {
    const tmp2 = mkdtempSync(join(tmpdir(), "composer-envelope-session-"));
    try {
      const status = buildStatus(tmp2);
      const envelope = statusEnvelope(status, { mode: "balanced", profile: "fast" });
      expect(envelope.version).toBe(1);
      expect(envelope.line).toMatch(/^CMP balanced · P:fast /);
    } finally {
      rmSync(tmp2, { recursive: true, force: true });
    }
  });
});
