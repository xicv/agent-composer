// Wave 4 0.1.2 — user-level plugin asset install.
//
// Drops composer-mastermind assets (SKILL.md, subagents, /evolve command,
// boundary_guard hook) into the user's ~/.claude/ tree so Claude Code
// auto-discovers them in every project. Companion to runGlobalInit().
//
// Source assets ship in the npm tarball under plugin/composer-mastermind/
// (added to package.json files whitelist in 0.1.2).

import { existsSync, mkdirSync, copyFileSync, chmodSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { InitStep } from "./init.js";

/**
 * Resolve the plugin source directory shipped with this package.
 * dist/cli/install-plugin.js (3 levels up) → package root → plugin/composer-mastermind/
 */
export function defaultPluginSourceDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "plugin", "composer-mastermind");
}

export interface InstallPluginOptions {
  /** Claude Code user home (defaults to $HOME/.claude). Tests inject a tmpdir. */
  claudeHome: string;
  /** Plugin source directory (defaults to defaultPluginSourceDir()). Tests inject. */
  pluginSourceDir?: string;
}

/**
 * Copy plugin assets into Claude Code user-level directories so they
 * auto-load in every project. User-authored SKILL.md stays preserved; packaged
 * agents, commands, and hooks refresh so stale installs pick up tool allowlists.
 *
 * Layout written:
 *   <claudeHome>/skills/composer-mastermind/SKILL.md
 *   <claudeHome>/agents/{coder,researcher,reviewer,reviewer-claude}.md
 *   <claudeHome>/commands/evolve.md
 *   <claudeHome>/hooks/composer-boundary_guard.sh
 *   <claudeHome>/settings.json — patched with PreToolUse entry
 */
export function installPluginAssets(opts: InstallPluginOptions): InitStep[] {
  const src = opts.pluginSourceDir ?? defaultPluginSourceDir();
  const claudeHome = opts.claudeHome;
  const steps: InitStep[] = [];

  steps.push(copyOne(
    join(src, "skills/composer-mastermind/SKILL.md"),
    join(claudeHome, "skills/composer-mastermind/SKILL.md"),
    "composer-mastermind SKILL.md",
  ));

  const agentsSrc = join(src, "agents");
  if (existsSync(agentsSrc)) {
    for (const file of readdirSync(agentsSrc).sort()) {
      if (!file.endsWith(".md")) continue;
      steps.push(copyOne(
        join(agentsSrc, file),
        join(claudeHome, "agents", file),
        `agent ${file}`,
        { overwrite: true },
      ));
    }
  }

  const commandsSrc = join(src, "commands");
  if (existsSync(commandsSrc)) {
    for (const file of readdirSync(commandsSrc).sort()) {
      if (!file.endsWith(".md")) continue;
      steps.push(copyOne(
        join(commandsSrc, file),
        join(claudeHome, "commands", file),
        `command /${file.replace(/\.md$/, "")}`,
        { overwrite: true },
      ));
    }
  }

  // Boundary hook — copy script + register in settings.json
  const hookSrc = join(src, "hooks", "boundary_guard.sh");
  const hookDest = join(claudeHome, "hooks", "composer-boundary_guard.sh");
  steps.push(copyOne(hookSrc, hookDest, "composer boundary_guard.sh hook script", { exec: true, overwrite: true }));
  steps.push(wireBoundaryHook(claudeHome, hookDest));

  return steps;
}

interface CopyOpts { exec?: boolean; overwrite?: boolean }

function copyOne(srcPath: string, destPath: string, label: string, opts: CopyOpts = {}): InitStep {
  if (!existsSync(srcPath)) {
    return { name: label, status: "skipped", reason: `source missing: ${srcPath}` };
  }
  if (existsSync(destPath)) {
    if (!opts.overwrite) {
      return { name: label, status: "skipped", path: destPath, reason: "already present; not overwritten" };
    }
    if (readFileSync(destPath, "utf8") === readFileSync(srcPath, "utf8")) {
      if (opts.exec) chmodSync(destPath, 0o755);
      return { name: label, status: "skipped", path: destPath, reason: "already current" };
    }
    copyFileSync(srcPath, destPath);
    if (opts.exec) chmodSync(destPath, 0o755);
    return { name: label, status: "updated", path: destPath, reason: "refreshed from packaged plugin asset" };
  }
  mkdirSync(dirname(destPath), { recursive: true });
  copyFileSync(srcPath, destPath);
  if (opts.exec) chmodSync(destPath, 0o755);
  return { name: label, status: "created", path: destPath };
}

/**
 * Patch <claudeHome>/settings.json hooks.PreToolUse with a composer
 * boundary entry. Skip if an entry already references composer-boundary_guard.
 */
function wireBoundaryHook(claudeHome: string, hookScriptPath: string): InitStep {
  const settingsPath = join(claudeHome, "settings.json");
  const matcher = "Bash|Edit|Update|Write|NotebookEdit";
  const entry = {
    matcher,
    hooks: [{ type: "command", command: hookScriptPath }],
  };

  let current: Record<string, unknown>;
  if (existsSync(settingsPath)) {
    try {
      current = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    } catch {
      return {
        name: "~/.claude/settings.json boundary hook",
        status: "skipped",
        path: settingsPath,
        reason: "settings.json not valid JSON; refusing to patch",
      };
    }
  } else {
    mkdirSync(dirname(settingsPath), { recursive: true });
    current = {};
  }

  const hooks = (current["hooks"] as Record<string, unknown> | undefined) ?? {};
  const preToolUse = (hooks["PreToolUse"] as Array<{ matcher?: string; hooks?: Array<{ command?: string }> }> | undefined) ?? [];

  // Idempotency: skip if any existing PreToolUse entry already references our script.
  const alreadyWired = preToolUse.some((e) => e.hooks?.some((h) => h.command === hookScriptPath));
  if (alreadyWired) {
    return {
      name: "~/.claude/settings.json boundary hook",
      status: "skipped",
      path: settingsPath,
      reason: "composer-boundary_guard already registered",
    };
  }

  const nextPreToolUse = [...preToolUse, entry];
  const nextHooks = { ...hooks, PreToolUse: nextPreToolUse };
  const next = { ...current, hooks: nextHooks };
  writeFileSync(settingsPath, JSON.stringify(next, null, 2) + "\n", "utf8");
  return {
    name: "~/.claude/settings.json boundary hook",
    status: "updated",
    path: settingsPath,
    reason: `appended PreToolUse entry → ${hookScriptPath}`,
  };
}
