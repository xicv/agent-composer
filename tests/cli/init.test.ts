import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../src/cli/init.js";

const ORACLE_SCRIPTS = [
  "oracle-pro-safe.sh",
  "oracle-plan-mcp.sh",
  "composer-oracle-router-safe.sh",
  "oracle-codex-handoff-safe.sh",
];

describe("composer init", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "composer-init-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("creates .claude/ when missing", () => {
    const r = runInit({ cwd, verbose: false });
    expect(existsSync(join(cwd, ".claude"))).toBe(true);
    expect(r.steps.find((s) => s.name === ".claude/ directory")?.status).toBe("created");
  });

  it("skips .claude/ when already present", () => {
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    const r = runInit({ cwd, verbose: false });
    expect(r.steps.find((s) => s.name === ".claude/ directory")?.status).toBe("skipped");
  });

  it("writes composer.config.json with default roles + spendAuthorization", () => {
    runInit({ cwd, verbose: false });
    const cfg = JSON.parse(readFileSync(join(cwd, "composer.config.json"), "utf8"));
    expect(cfg.roles.coder.provider).toBe("anthropic");
    expect(cfg.roles.researcher.provider).toBe("cli");
    expect(cfg.roles.researcher.cli).toEqual([
      "codex",
      "--search",
      "--ask-for-approval",
      "never",
      "exec",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "-c",
      "model=\"gpt-5.4-mini\"",
    ]);
    expect(cfg.roles.researcher.timeoutMs).toBe(180000);
    expect(cfg.roles.researcher.retries).toBe(0);
    expect(cfg.roles.coderCli.provider).toBe("cli");
    expect(cfg.roles.coderCli.cli).toEqual([
      "codex",
      "exec",
      "--ephemeral",
      "--sandbox",
      "workspace-write",
      "-c",
      "approval_policy=\"never\"",
      "-c",
      "model_reasoning_effort=\"medium\"",
    ]);
    expect(cfg.roles.coderCli.timeoutMs).toBe(900000);
    expect(cfg.roles.coderCli.retries).toBe(0);
    expect(cfg.roles.reviewer.provider).toBe("cli");
    expect(cfg.roles.reviewer.cli).toContain("--print-timeout");
    expect(cfg.roles.reviewer.cli).toContain("110s");
    expect(cfg.roles.reviewer.timeoutMs).toBe(120000);
    expect(cfg.roles.reviewer.retries).toBe(1);
    expect(cfg.roles.reviewerClaude).toBeDefined();
    expect(cfg.roles.reviewerClaude?.provider).toBe("cli");
    expect(cfg.roles.reviewerClaude?.cli).toContain("claude");
    expect(cfg.roles.reviewerClaude?.cli).toContain("--max-budget-usd");
    expect(cfg.roles.reviewerClaude?.timeoutMs).toBe(300000);
    expect(cfg.roles.reviewerClaude?.retries).toBe(0);
    expect(cfg.spendAuthorization.mode).toBe("interactive");
    expect(cfg.spendAuthorization.maxUsdPerCall).toBe(0.5);
    expect(cfg.codexReview.preCommitCommand).toBe("adversarial-review");
    expect(cfg.codexReview.model).toBe("gpt-5.5");
    expect(cfg.codexLifecycle.enabled).toBe(false);
    expect(cfg.codexLifecycle.mode).toBe("ask");
    expect(cfg.codexLifecycle.triggers.postCodeApply).toBe(true);
    expect(cfg.codexLifecycle.triggers.stopWarm).toBe(false);
    expect(cfg.codexLifecycle.thresholds.minScore).toBe(60);
    expect(cfg.codexLifecycle.fallback.enabled).toBe(false);
    expect(cfg.codexLifecycle.fallback.order).toEqual(["reviewerClaude", "reviewer", "coder"]);
  });

  it("does not install Oracle scripts or role by default", () => {
    runInit({ cwd, verbose: false });
    const cfg = JSON.parse(readFileSync(join(cwd, "composer.config.json"), "utf8"));
    expect(cfg.roles.oraclePlanner).toBeUndefined();
    expect(existsSync(join(cwd, "scripts"))).toBe(false);
  });

  it("installs Oracle scripts and adds oraclePlanner when requested", () => {
    const oracleSourceDir = mkdtempSync(join(tmpdir(), "composer-oracle-source-"));
    try {
      for (const name of ORACLE_SCRIPTS) {
        writeFileSync(join(oracleSourceDir, name), "stub\n", "utf8");
      }

      runInit({ cwd, installOracle: true, oracleSourceDir, verbose: false });

      for (const name of ORACLE_SCRIPTS) {
        expect(existsSync(join(cwd, "scripts", name))).toBe(true);
      }
      const cfg = JSON.parse(readFileSync(join(cwd, "composer.config.json"), "utf8"));
      expect(cfg.roles.oraclePlanner.cli[0]).toBe("bash");
      expect(cfg.roles.oraclePlanner.cli).toContain("scripts/oracle-plan-mcp.sh");
      const ig = readFileSync(join(cwd, ".gitignore"), "utf8");
      expect(ig).toContain(".composer/oracle/");
      expect(ig).toContain(".composer/results/");
    } finally {
      rmSync(oracleSourceDir, { recursive: true, force: true });
    }
  });

  it("does NOT overwrite an existing composer.config.json", () => {
    writeFileSync(join(cwd, "composer.config.json"), '{"custom": true}', "utf8");
    const r = runInit({ cwd, verbose: false });
    expect(r.steps.find((s) => s.name === "composer.config.json")?.status).toBe("skipped");
    expect(JSON.parse(readFileSync(join(cwd, "composer.config.json"), "utf8"))).toEqual({ custom: true });
  });

  it("writes .env.json placeholder when missing", () => {
    runInit({ cwd, verbose: false });
    const env = JSON.parse(readFileSync(join(cwd, ".env.json"), "utf8"));
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic");
    expect(env.ANTHROPIC_AUTH_TOKEN).toContain("replace-with");
  });

  it("does NOT overwrite an existing .env.json", () => {
    writeFileSync(join(cwd, ".env.json"), '{"secret": "real-token"}', "utf8");
    runInit({ cwd, verbose: false });
    expect(JSON.parse(readFileSync(join(cwd, ".env.json"), "utf8"))).toEqual({ secret: "real-token" });
  });

  it("creates .gitignore with base runtime entries when missing", () => {
    runInit({ cwd, verbose: false });
    const ig = readFileSync(join(cwd, ".gitignore"), "utf8");
    expect(ig).toContain(".env.json");
    expect(ig).toContain(".composer/handoffs/");
    expect(ig).toContain(".composer/codex-lifecycle/");
  });

  it("appends base runtime entries to existing .gitignore without erasing prior entries", () => {
    writeFileSync(join(cwd, ".gitignore"), "node_modules/\ndist/\n", "utf8");
    runInit({ cwd, verbose: false });
    const ig = readFileSync(join(cwd, ".gitignore"), "utf8");
    expect(ig).toContain("node_modules/");
    expect(ig).toContain("dist/");
    expect(ig).toContain(".env.json");
    expect(ig).toContain(".composer/handoffs/");
    expect(ig).toContain(".composer/codex-lifecycle/");
  });

  it("does not duplicate runtime entries in .gitignore on re-run", () => {
    runInit({ cwd, verbose: false });
    runInit({ cwd, verbose: false });
    const ig = readFileSync(join(cwd, ".gitignore"), "utf8");
    const lines = ig.split(/\r?\n/).map((l) => l.trim());
    expect(lines.filter((l) => l === ".env.json")).toHaveLength(1);
    expect(lines.filter((l) => l === ".composer/handoffs/")).toHaveLength(1);
    expect(lines.filter((l) => l === ".composer/codex-lifecycle/")).toHaveLength(1);
  });

  it("writes .claude/settings.json with mcpServers.composer entry", () => {
    runInit({ cwd, verbose: false });
    const s = JSON.parse(readFileSync(join(cwd, ".claude", "settings.json"), "utf8"));
    expect(s.mcpServers.composer.command).toBe("npx");
    expect(s.mcpServers.composer.args).toContain("agent-composer");
  });

  it("merges mcpServers.composer into existing settings.json without erasing other settings", () => {
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(
      join(cwd, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: ["Read"] }, mcpServers: { other: { command: "x" } } }, null, 2),
      "utf8",
    );
    const r = runInit({ cwd, verbose: false });
    const s = JSON.parse(readFileSync(join(cwd, ".claude", "settings.json"), "utf8"));
    expect(s.permissions.allow).toContain("Read");
    expect(s.mcpServers.other).toBeDefined();
    expect(s.mcpServers.composer).toBeDefined();
    expect(r.steps.find((s2) => s2.name === ".claude/settings.json")?.status).toBe("updated");
  });

  it("skips mcpServers.composer wire when already present", () => {
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(
      join(cwd, ".claude", "settings.json"),
      JSON.stringify({ mcpServers: { composer: { command: "custom" } } }, null, 2),
      "utf8",
    );
    const r = runInit({ cwd, verbose: false });
    expect(r.steps.find((s) => s.name === ".claude/settings.json")?.status).toBe("skipped");
    const s = JSON.parse(readFileSync(join(cwd, ".claude", "settings.json"), "utf8"));
    expect(s.mcpServers.composer.command).toBe("custom"); // user's customization preserved
  });

  it("is fully idempotent — second run produces only skipped steps", () => {
    runInit({ cwd, verbose: false });
    const r = runInit({ cwd, verbose: false });
    for (const s of r.steps) {
      expect(s.status).toBe("skipped");
    }
  });

  it("honors defaultBaseUrl + defaultAuthToken overrides", () => {
    runInit({ cwd, verbose: false, defaultBaseUrl: "https://custom.example", defaultAuthToken: "secret-123" });
    const env = JSON.parse(readFileSync(join(cwd, ".env.json"), "utf8"));
    expect(env.ANTHROPIC_BASE_URL).toBe("https://custom.example");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("secret-123");
  });
});
