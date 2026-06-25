import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installPluginAssets, defaultPluginSourceDir } from "../../src/cli/install-plugin.js";

const REPO_ROOT = resolve(__dirname, "..", "..");
const REAL_PLUGIN_SRC = join(REPO_ROOT, "plugin", "composer-mastermind");

describe("installPluginAssets", () => {
  let tmp: string;
  let claudeHome: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "composer-plugin-install-test-"));
    claudeHome = join(tmp, "claude-home");
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("copies SKILL.md to ~/.claude/skills/composer-mastermind/", () => {
    installPluginAssets({ claudeHome, pluginSourceDir: REAL_PLUGIN_SRC });
    expect(existsSync(join(claudeHome, "skills/composer-mastermind/SKILL.md"))).toBe(true);
  });

  it("copies all subagent .md files to ~/.claude/agents/", () => {
    installPluginAssets({ claudeHome, pluginSourceDir: REAL_PLUGIN_SRC });
    expect(existsSync(join(claudeHome, "agents/researcher.md"))).toBe(true);
    expect(existsSync(join(claudeHome, "agents/reviewer.md"))).toBe(true);
    expect(existsSync(join(claudeHome, "agents/reviewer-claude.md"))).toBe(true);
    expect(existsSync(join(claudeHome, "agents/explorer.md"))).toBe(true);
  });

  it("copies slash commands to ~/.claude/commands/", () => {
    installPluginAssets({ claudeHome, pluginSourceDir: REAL_PLUGIN_SRC });
    expect(existsSync(join(claudeHome, "commands/evolve.md"))).toBe(true);
  });

  it("copies boundary_guard.sh hook with executable bit preserved", () => {
    installPluginAssets({ claudeHome, pluginSourceDir: REAL_PLUGIN_SRC });
    const hookPath = join(claudeHome, "hooks/composer-boundary_guard.sh");
    expect(existsSync(hookPath)).toBe(true);
    const mode = statSync(hookPath).mode;
    expect((mode & 0o100) !== 0).toBe(true); // owner-execute bit
  });

  it("copies composer_disabled.lib.sh next to installed hooks", () => {
    installPluginAssets({ claudeHome, pluginSourceDir: REAL_PLUGIN_SRC });
    expect(existsSync(join(claudeHome, "hooks/composer_disabled.lib.sh"))).toBe(true);
  });

  it("writes settings.json hooks.PreToolUse entry pointing at the hook", () => {
    installPluginAssets({ claudeHome, pluginSourceDir: REAL_PLUGIN_SRC });
    const s = JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"));
    expect(s.hooks.PreToolUse).toBeDefined();
    expect(s.hooks.PreToolUse.length).toBeGreaterThan(0);
    const hasComposer = s.hooks.PreToolUse.some((e: { hooks?: Array<{ command?: string }> }) =>
      e.hooks?.some((h) => h.command?.includes("composer-boundary_guard.sh")),
    );
    expect(hasComposer).toBe(true);
    const composerEntry = s.hooks.PreToolUse.find((e: { hooks?: Array<{ command?: string }> }) =>
      e.hooks?.some((h) => h.command?.includes("composer-boundary_guard.sh")),
    );
    expect(composerEntry.matcher).toBe("Edit|Update|Write|NotebookEdit");
  });

  it("preserves existing PreToolUse entries when adding the composer hook", () => {
    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(
      join(claudeHome, "settings.json"),
      JSON.stringify(
        { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/existing/hook.sh" }] }] } },
        null,
        2,
      ),
      "utf8",
    );
    installPluginAssets({ claudeHome, pluginSourceDir: REAL_PLUGIN_SRC });
    const s = JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"));
    expect(s.hooks.PreToolUse.length).toBe(2);
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe("/existing/hook.sh");
    expect(s.hooks.PreToolUse[1].hooks[0].command).toContain("composer-boundary_guard.sh");
  });

  it("does NOT overwrite an existing SKILL.md (user customizations preserved)", () => {
    mkdirSync(join(claudeHome, "skills/composer-mastermind"), { recursive: true });
    writeFileSync(join(claudeHome, "skills/composer-mastermind/SKILL.md"), "USER-EDITED-SKILL", "utf8");
    installPluginAssets({ claudeHome, pluginSourceDir: REAL_PLUGIN_SRC });
    expect(readFileSync(join(claudeHome, "skills/composer-mastermind/SKILL.md"), "utf8")).toBe("USER-EDITED-SKILL");
  });

  it("refreshes stale packaged agent files on reinstall", () => {
    mkdirSync(join(claudeHome, "agents"), { recursive: true });
    writeFileSync(
      join(claudeHome, "agents/researcher.md"),
      "---\nname: researcher\ntools: mcp__composer__composer_research\n---\n",
      "utf8",
    );
    const steps = installPluginAssets({ claudeHome, pluginSourceDir: REAL_PLUGIN_SRC });
    expect(steps.find((s) => s.name === "agent researcher.md")?.status).toBe("updated");
    const researcher = readFileSync(join(claudeHome, "agents/researcher.md"), "utf8");
    expect(researcher).toContain("mcp__composer__composer_research");
    expect(researcher).toContain("Read");
  });

  it("does NOT duplicate the boundary hook entry on second run", () => {
    installPluginAssets({ claudeHome, pluginSourceDir: REAL_PLUGIN_SRC });
    installPluginAssets({ claudeHome, pluginSourceDir: REAL_PLUGIN_SRC });
    const s = JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"));
    const composerEntries = s.hooks.PreToolUse.filter((e: { hooks?: Array<{ command?: string }> }) =>
      e.hooks?.some((h) => h.command?.includes("composer-boundary_guard.sh")),
    );
    expect(composerEntries.length).toBe(1);
  });

  it("refreshes stale boundary hook matcher that still includes Bash", () => {
    mkdirSync(claudeHome, { recursive: true });
    const hookPath = join(claudeHome, "hooks/composer-boundary_guard.sh");
    writeFileSync(
      join(claudeHome, "settings.json"),
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              { matcher: "Bash|Edit|Update|Write|NotebookEdit", hooks: [{ type: "command", command: hookPath }] },
            ],
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    installPluginAssets({ claudeHome, pluginSourceDir: REAL_PLUGIN_SRC });
    const s = JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"));
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.hooks.PreToolUse[0].matcher).toBe("Edit|Update|Write|NotebookEdit");
  });

  it("returns step records with status created/skipped/updated for every action", () => {
    const steps = installPluginAssets({ claudeHome, pluginSourceDir: REAL_PLUGIN_SRC });
    expect(steps.length).toBeGreaterThan(0);
    for (const s of steps) {
      expect(["created", "updated", "skipped"]).toContain(s.status);
    }
  });

  it("defaultPluginSourceDir resolves to a real directory in this repo", () => {
    expect(existsSync(defaultPluginSourceDir())).toBe(true);
  });
});
