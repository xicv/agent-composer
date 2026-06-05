import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGlobalInit } from "../../src/cli/init.js";

describe("composer init --global", () => {
  let tmp: string;
  let globalDir: string;
  let claudeHome: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "composer-init-global-test-"));
    globalDir = join(tmp, "config", "composer");
    claudeHome = join(tmp, "claude-home");
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates the global config dir and the ~/.claude dir", () => {
    runGlobalInit({ globalDir, claudeHome, verbose: false });
    expect(existsSync(globalDir)).toBe(true);
    expect(existsSync(claudeHome)).toBe(true);
  });

  it("writes composer.config.json under the global dir", () => {
    runGlobalInit({ globalDir, claudeHome, verbose: false });
    const cfg = JSON.parse(readFileSync(join(globalDir, "composer.config.json"), "utf8"));
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
    expect(cfg.roles.reviewerClaude).toBeDefined();
    expect(cfg.roles.reviewerClaude?.provider).toBe("cli");
    expect(cfg.roles.reviewerClaude?.cli).toContain("claude");
    expect(cfg.roles.reviewerClaude?.timeoutMs).toBe(300000);
    expect(cfg.roles.reviewerClaude?.retries).toBe(0);
    expect(cfg.spendAuthorization.mode).toBe("interactive");
  });

  it("writes .env.json placeholder under the global dir", () => {
    runGlobalInit({ globalDir, claudeHome, verbose: false });
    const env = JSON.parse(readFileSync(join(globalDir, ".env.json"), "utf8"));
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic");
    expect(env.ANTHROPIC_AUTH_TOKEN).toContain("replace-with");
  });

  it("creates ~/.claude/settings.json with mcpServers.composer entry when missing", () => {
    runGlobalInit({ globalDir, claudeHome, verbose: false });
    const settings = JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"));
    expect(settings.mcpServers.composer.command).toBe("npx");
    expect(settings.mcpServers.composer.args).toContain("agent-composer");
  });

  it("merges mcpServers.composer into existing ~/.claude/settings.json", () => {
    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(
      join(claudeHome, "settings.json"),
      JSON.stringify({ permissions: { allow: ["Read"] }, mcpServers: { other: { command: "x" } } }, null, 2),
      "utf8",
    );
    runGlobalInit({ globalDir, claudeHome, verbose: false });
    const s = JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"));
    expect(s.permissions.allow).toContain("Read");
    expect(s.mcpServers.other).toBeDefined();
    expect(s.mcpServers.composer).toBeDefined();
  });

  it("does NOT overwrite an existing global composer.config.json", () => {
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, "composer.config.json"), '{"custom": true}', "utf8");
    runGlobalInit({ globalDir, claudeHome, verbose: false });
    expect(JSON.parse(readFileSync(join(globalDir, "composer.config.json"), "utf8"))).toEqual({ custom: true });
  });

  it("does NOT overwrite an existing global .env.json", () => {
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, ".env.json"), '{"secret": "real-token"}', "utf8");
    runGlobalInit({ globalDir, claudeHome, verbose: false });
    expect(JSON.parse(readFileSync(join(globalDir, ".env.json"), "utf8"))).toEqual({ secret: "real-token" });
  });

  it("is idempotent — second run only skipped steps", () => {
    runGlobalInit({ globalDir, claudeHome, verbose: false });
    const r = runGlobalInit({ globalDir, claudeHome, verbose: false });
    for (const s of r.steps) expect(s.status).toBe("skipped");
  });

  it("preserves the composer entry in settings.json if user customized it", () => {
    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(
      join(claudeHome, "settings.json"),
      JSON.stringify({ mcpServers: { composer: { command: "custom-mcp" } } }, null, 2),
      "utf8",
    );
    const r = runGlobalInit({ globalDir, claudeHome, verbose: false });
    expect(r.steps.find((s) => s.name === "~/.claude/settings.json")?.status).toBe("skipped");
    const s = JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"));
    expect(s.mcpServers.composer.command).toBe("custom-mcp");
  });
});
