import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildConfigChecks,
  checkGitPreCommitHook,
  classifyOracleNode,
  classifyPreCommitJq,
  isHealthy,
  resolveCodexPluginRoot,
  type DoctorCheck,
} from "../../src/cli/doctor.js";
import type { ComposerConfig } from "../../src/config/schema.js";

const BASE_CONFIG: ComposerConfig = {
  roles: {
    researcher: { provider: "cli", cli: ["agy", "-p"] },
    coder: {
      provider: "anthropic",
      baseUrl: "https://api.z.ai/api/anthropic",
      apiKeyEnv: "ANTHROPIC_AUTH_TOKEN",
      model: "glm-4.6",
    },
    reviewer: { provider: "cli", cli: ["agy", "-p"] },
  },
};

describe("doctor Codex plugin discovery", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "composer-doctor-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the marketplaces plugin path when present", () => {
    const root = join(tmp, "marketplaces", "openai-codex", "plugins", "codex");
    writeFakeCodexPlugin(root, "2.3.4");

    const result = resolveCodexPluginRoot(tmp);

    expect(result).toEqual({ root, version: "2.3.4" });
  });

  it("picks the highest semver cache plugin when marketplaces path is absent", () => {
    writeFakeCodexPlugin(join(tmp, "cache", "openai-codex", "codex", "1.0.2"), "1.0.2");
    writeFakeCodexPlugin(join(tmp, "cache", "openai-codex", "codex", "1.0.4"), "1.0.4");

    const result = resolveCodexPluginRoot(tmp);

    expect(result?.root).toBe(join(tmp, "cache", "openai-codex", "codex", "1.0.4"));
    expect(result?.version).toBe("1.0.4");
  });

  it("returns null when no Codex plugin is available", () => {
    expect(resolveCodexPluginRoot(tmp)).toBeNull();
  });
});

describe("doctor config checks", () => {
  it("reports codexReview.enabled=false as an optional warn", () => {
    const checks = buildConfigChecks({
      ...BASE_CONFIG,
      codexReview: { enabled: false },
    });

    expect(checks.length).toBeGreaterThan(0);
    expect(checks.find((check) => check.name === "config: codexReview")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("OFF"),
    });
    expect(checks.find((check) => check.name === "config: codexReview warmCache")).toMatchObject({
      status: "pass",
      detail: expect.stringContaining("off"),
    });
    expect(checks.find((check) => check.name === "config: codexReview notify")?.detail)
      .toContain("desktop=off");
    expect(checks.find((check) => check.name === "config: codexRescue")?.detail)
      .toContain("enabled=true");
    expect(checks.find((check) => check.name === "config: codexLifecycle")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("enabled=false"),
    });
    expect(checks.find((check) => check.name === "config: codexLifecycle fallback")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("enabled=false"),
    });
  });

  it("reports enabled triggers and resolved defaults without throwing", () => {
    const checks = buildConfigChecks({
      ...BASE_CONFIG,
      codexReview: {
        enabled: true,
        triggers: { preCommit: true, postPlan: true },
      },
    });

    expect(checks.length).toBeGreaterThan(0);
    expect(checks.find((check) => check.name === "config: codexReview")).toMatchObject({
      status: "pass",
      detail: expect.stringContaining("ON"),
    });
    expect(checks.find((check) => check.name === "config: codexReview triggers")?.detail)
      .toContain("preCommit=true, postPlan=true");
    const defaults = checks.find((check) => check.name === "config: codexReview defaults")?.detail;
    expect(defaults).toContain("mode=ask");
    expect(defaults).toContain("execution=background");
    expect(defaults).toContain("model=unset");
  });

  it("warns when the mechanical pre-commit gate uses free-text review output", () => {
    const checks = buildConfigChecks({
      ...BASE_CONFIG,
      codexReview: {
        enabled: true,
        preCommitCommand: "review",
        preCommitHook: { enabled: true },
      },
    });

    expect(checks.find((check) => check.name === "config: codexReview preCommitCommand")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("free-text only"),
    });
  });

  it("reports configured codexReview.model in defaults", () => {
    const checks = buildConfigChecks({
      ...BASE_CONFIG,
      codexReview: {
        enabled: true,
        model: "gpt-5.4-mini",
      },
    });

    expect(checks.find((check) => check.name === "config: codexReview defaults")?.detail)
      .toContain("model=gpt-5.4-mini");
  });

  it("warns when warmCache is enabled while codexReview is disabled", () => {
    const checks = buildConfigChecks({
      ...BASE_CONFIG,
      codexReview: {
        enabled: false,
        warmCache: { enabled: true, maxAgeMinutes: 10, timeoutMs: 300000 },
      },
      codexRescue: { enabled: true, mode: "auto", model: "gpt-5.4-mini" },
    });

    expect(checks.find((check) => check.name === "config: codexReview warmCache")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("inert"),
    });
    expect(checks.find((check) => check.name === "config: codexRescue")?.detail)
      .toContain("mode=auto");
  });

  it("reports configured codexLifecycle policy", () => {
    const checks = buildConfigChecks({
      ...BASE_CONFIG,
      codexLifecycle: {
        enabled: true,
        mode: "auto",
        execution: "foreground",
        model: "gpt-5.4",
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
          minScore: 45,
          minExpectedOutputTokens: 500,
          minChangedFiles: 2,
          minDiffLines: 80,
          failedAttempts: 3,
        },
        fallback: {
          enabled: true,
          order: ["reviewerClaude", "reviewer"],
        },
      },
    });

    expect(checks.find((check) => check.name === "config: codexLifecycle")).toMatchObject({
      status: "pass",
      detail: expect.stringContaining("mode=auto"),
    });
    expect(checks.find((check) => check.name === "config: codexLifecycle")).toMatchObject({
      detail: expect.stringContaining("model=gpt-5.4"),
    });
    expect(checks.find((check) => check.name === "config: codexLifecycle triggers")?.detail)
      .toContain("postCodeApply=true");
    expect(checks.find((check) => check.name === "config: codexLifecycle thresholds")?.detail)
      .toContain("failedAttempts=3");
    expect(checks.find((check) => check.name === "config: codexLifecycle fallback")).toMatchObject({
      status: "pass",
      detail: expect.stringContaining("reviewerClaude>reviewer"),
    });
  });

  it("reports oraclePlanner configuration status", () => {
    const withoutOraclePlanner = buildConfigChecks(BASE_CONFIG);

    expect(withoutOraclePlanner.find((check) => check.name === "config: oraclePlanner")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("not configured"),
    });

    const withOraclePlanner = buildConfigChecks({
      ...BASE_CONFIG,
      roles: {
        ...BASE_CONFIG.roles,
        oraclePlanner: { provider: "cli", cli: ["oracle"] },
      },
    });

    expect(withOraclePlanner.find((check) => check.name === "config: oraclePlanner")).toMatchObject({
      status: "pass",
      detail: expect.stringContaining("roles.oraclePlanner"),
    });
  });
});

describe("doctor oracle runtime check", () => {
  it("fails when oracle runs under a bad Node major and oraclePlanner is configured", () => {
    const check = classifyOracleNode({ oracleFound: true, nodeVersion: "v26.3.0", oraclePlannerConfigured: true });
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("Node v26.3.0");
    expect(check.detail).toContain("Node 24 LTS");
  });

  it("warns (not fails) on a bad Node major when oraclePlanner is not configured", () => {
    const check = classifyOracleNode({ oracleFound: true, nodeVersion: "v26.3.0", oraclePlannerConfigured: false });
    expect(check.status).toBe("warn");
  });

  it("passes on Node 24 LTS", () => {
    const check = classifyOracleNode({ oracleFound: true, nodeVersion: "v24.16.0", oraclePlannerConfigured: true });
    expect(check.status).toBe("pass");
    expect(check.detail).toContain("v24.16.0");
  });

  it("fails when oracle is not found and oraclePlanner is configured", () => {
    const check = classifyOracleNode({ oracleFound: false, nodeVersion: null, oraclePlannerConfigured: true });
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("roles.oraclePlanner is configured");
  });

  it("warns when oracle is not found and oraclePlanner is not configured", () => {
    const check = classifyOracleNode({ oracleFound: false, nodeVersion: null, oraclePlannerConfigured: false });
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("not found");
  });

  it("warns when the Node runtime cannot be determined", () => {
    const check = classifyOracleNode({ oracleFound: true, nodeVersion: null, oraclePlannerConfigured: true });
    expect(check.status).toBe("warn");
  });
});

describe("doctor pre-commit jq check", () => {
  it("fails when a fail-closed gate is configured and jq is missing", () => {
    const check = classifyPreCommitJq({ gateFailClosedEnabled: true, jqAvailable: false });

    expect(check.status).toBe("fail");
    expect(check.detail).toContain("fail OPEN");
  });

  it("passes when a fail-closed gate is configured and jq is present", () => {
    const check = classifyPreCommitJq({ gateFailClosedEnabled: true, jqAvailable: true });

    expect(check.status).toBe("pass");
  });

  it("passes when jq is missing but the fail-closed gate is not configured", () => {
    const check = classifyPreCommitJq({ gateFailClosedEnabled: false, jqAvailable: false });

    expect(check.status).toBe("pass");
    expect(check.detail).toContain("only required");
  });
});

describe("doctor git pre-commit hook check", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "composer-doctor-git-"));
    const result = spawnSync("git", ["init"], { cwd: tmp, encoding: "utf8" });
    expect(result.status).toBe(0);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("fails when forced Codex pre-commit review lacks a Git hook", () => {
    const check = checkGitPreCommitHook(tmp, {
      ...BASE_CONFIG,
      codexReview: {
        enabled: true,
        preCommitHook: { enabled: true },
      },
    });

    expect(check).toMatchObject({
      name: "git: pre-commit hook",
      status: "fail",
      detail: expect.stringContaining("not covered"),
    });
  });

  it("warns when the Git hook calls Composer's Codex review gate without git-hook mode", () => {
    const hookPath = join(tmp, ".git", "hooks", "pre-commit");
    writeFileSync(
      hookPath,
      "#!/usr/bin/env bash\nexec \"$PWD/scripts/precommit_codex_review.sh\"\n",
      "utf8",
    );
    chmodSync(hookPath, 0o755);

    const check = checkGitPreCommitHook(tmp, {
      ...BASE_CONFIG,
      codexReview: {
        enabled: true,
        preCommitHook: { enabled: true },
      },
    });

    expect(check).toMatchObject({
      name: "git: pre-commit hook",
      status: "warn",
      detail: expect.stringContaining("NOT in --git-hook mode"),
    });
  });

  it("passes when the Git hook calls Composer's Codex review gate in git-hook mode", () => {
    const hookPath = join(tmp, ".git", "hooks", "pre-commit");
    writeFileSync(
      hookPath,
      "#!/usr/bin/env bash\nexec \"$PWD/scripts/precommit_codex_review.sh\" --git-hook\n",
      "utf8",
    );
    chmodSync(hookPath, 0o755);

    const check = checkGitPreCommitHook(tmp, {
      ...BASE_CONFIG,
      codexReview: {
        enabled: true,
        preCommitHook: { enabled: true },
      },
    });

    expect(check).toMatchObject({
      name: "git: pre-commit hook",
      status: "pass",
      detail: expect.stringContaining("terminal git commit gated"),
    });
  });

  it("resolves the Git hook from a repository subdirectory", () => {
    const subdir = join(tmp, "src");
    mkdirSync(subdir);
    const hookPath = join(tmp, ".git", "hooks", "pre-commit");
    writeFileSync(
      hookPath,
      "#!/usr/bin/env bash\nexec \"$PWD/scripts/precommit_codex_review.sh\" --git-hook\n",
      "utf8",
    );
    chmodSync(hookPath, 0o755);

    const check = checkGitPreCommitHook(subdir, {
      ...BASE_CONFIG,
      codexReview: {
        enabled: true,
        preCommitHook: { enabled: true },
      },
    });

    expect(check).toMatchObject({
      name: "git: pre-commit hook",
      status: "pass",
      detail: expect.stringContaining("terminal git commit gated"),
    });
  });
});

describe("doctor health", () => {
  it("marks a report unhealthy when any check fails", () => {
    expect(isHealthy([
      passCheck(),
      { name: "codex CLI", status: "fail", detail: "missing" },
    ])).toBe(false);
  });

  it("marks a report healthy when checks are only pass or warn", () => {
    expect(isHealthy([
      passCheck(),
      { name: "codex review", status: "warn", detail: "optional off" },
    ])).toBe(true);
  });
});

function writeFakeCodexPlugin(root: string, version: string): void {
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ version }), "utf8");
  writeFileSync(join(root, "scripts", "codex-companion.mjs"), "", "utf8");
  expect(existsSync(join(root, "scripts", "codex-companion.mjs"))).toBe(true);
}

function passCheck(): DoctorCheck {
  return { name: "ok", status: "pass", detail: "ok" };
}
