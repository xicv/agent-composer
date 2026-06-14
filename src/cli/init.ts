// Wave 4 M0.3 — composer init bootstrap CLI.
//
// Scaffolds a consumer project so it can launch the composer MCP server:
//   - .claude/ directory
//   - composer.config.json (default roles + spendAuthorization caps)
//   - .env.json placeholder (gitignored)
//   - .gitignore entry for .env.json
//   - .claude/settings.json mcpServers["composer"] entry
//
// Idempotent: each step checks existing state and skips if already correct.
// Never overwrites a present, non-default file (no --force flag in this slice).

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { globalConfigDir } from "../config/paths.js";
import { ORACLE_PLANNER_ROLE } from "../config/oracleRole.js";
import { installPluginAssets } from "./install-plugin.js";

export type InitStepStatus = "created" | "updated" | "skipped";

export interface InitStep {
  name: string;
  status: InitStepStatus;
  path?: string;
  reason?: string;
}

export interface InitOptions {
  cwd: string;
  /** When false, do not print to stdout. Defaults true. */
  verbose?: boolean;
  /** Override the default base URL written into .env.json stub. */
  defaultBaseUrl?: string;
  /** Override the default auth token placeholder. */
  defaultAuthToken?: string;
  /** When true, copy Oracle adapter scripts + add an opt-in oraclePlanner role. */
  installOracle?: boolean;
  /** Override the Oracle scripts source dir (tests inject). */
  oracleSourceDir?: string;
}

export interface InitResult {
  steps: InitStep[];
}

const DEFAULT_COMPOSER_CONFIG = {
  roles: {
    researcher: {
      provider: "cli",
      cli: [
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
      ],
      timeoutMs: 180000,
      retries: 0,
    },
    coder: { provider: "anthropic", baseUrl: "https://api.z.ai/api/anthropic", apiKeyEnv: "ANTHROPIC_AUTH_TOKEN" },
    coderCli: {
      provider: "cli",
      cli: [
        "codex",
        "exec",
        "--ephemeral",
        "--sandbox",
        "workspace-write",
        "-c",
        "approval_policy=\"never\"",
        "-c",
        "model_reasoning_effort=\"medium\"",
      ],
      timeoutMs: 900000,
      retries: 0,
    },
    reviewer: {
      provider: "cli",
      cli: ["agy", "--dangerously-skip-permissions", "--print-timeout", "110s", "-p"],
      timeoutMs: 120000,
      retries: 1,
    },
    reviewerClaude: {
      provider: "cli",
      model: "claude-opus-4-8",
      cli: [
        "claude",
        "-p",
        "--model",
        "claude-opus-4-8",
        "--permission-mode",
        "bypassPermissions",
        "--setting-sources",
        "project",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--max-budget-usd",
        "0.50",
        "--tools",
        "Read,Glob,Grep,Bash",
        "--allowedTools",
        "Read,Glob,Grep,Bash(npx tsc --noEmit),Bash(npm test),Bash(npm run test:*),Bash(npx vitest*)",
      ],
      timeoutMs: 300000,
      retries: 0,
    },
  },
  spendAuthorization: {
    mode: "interactive",
    maxUsdPerCall: 0.5,
    maxUsdPerSession: 5.0,
  },
  codexReview: {
    enabled: false,
    triggers: {
      preCommit: true,
      postPlan: true,
    },
    preCommitCommand: "adversarial-review",
    postPlanCommand: "adversarial-review",
    mode: "ask",
    execution: "background",
    scope: "auto",
    base: "main",
    model: "gpt-5.5",
    preCommitHook: {
      enabled: false,
      blockOnSeverity: "high",
      timeoutMs: 900000,
      failClosed: false,
    },
    warmCache: {
      enabled: false,
      maxAgeMinutes: 30,
    },
    notify: {
      desktop: false,
    },
  },
  codexRescue: {
    enabled: true,
    mode: "ask",
    model: "gpt-5.4-mini",
  },
  codexLifecycle: {
    enabled: false,
    mode: "ask",
    execution: "background",
    model: "gpt-5.4-mini",
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
      minScore: 60,
      minExpectedOutputTokens: 500,
      minChangedFiles: 2,
      minDiffLines: 80,
      failedAttempts: 2,
    },
    fallback: {
      enabled: false,
      order: ["reviewerClaude", "reviewer", "coder"],
    },
  },
};

const DEFAULT_ENV_TEMPLATE = (baseUrl: string, token: string) => ({
  ANTHROPIC_BASE_URL: baseUrl,
  ANTHROPIC_AUTH_TOKEN: token,
});

const DEFAULT_BASE_URL = "https://api.z.ai/api/anthropic";
const DEFAULT_AUTH_TOKEN_PLACEHOLDER = "<replace-with-your-glm-or-anthropic-compatible-token>";
const BASE_GITIGNORE_ENTRIES = [".env.json", ".composer/handoffs/", ".composer/codex-lifecycle/"];
const ORACLE_GITIGNORE_ENTRIES = [".composer/oracle/", ".composer/results/"];

const DEFAULT_MCP_SETTINGS = {
  mcpServers: {
    composer: {
      command: "npx",
      args: ["-y", "agent-composer"],
    },
  },
};

const ORACLE_SCRIPTS = [
  "oracle-pro-safe.sh",
  "oracle-plan-mcp.sh",
  "composer-oracle-router-safe.sh",
  "oracle-codex-handoff-safe.sh",
];

export function defaultOracleSourceDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "scripts");
}

export function runInit(opts: InitOptions): InitResult {
  const cwd = resolve(opts.cwd);
  const steps: InitStep[] = [];
  const log = (...args: unknown[]) => {
    if (opts.verbose !== false) process.stdout.write(args.map(String).join(" ") + "\n");
  };

  steps.push(ensureClaudeDir(cwd));
  steps.push(writeComposerConfig(cwd));
  if (opts.installOracle) {
    steps.push(installOracleScripts(cwd, opts.oracleSourceDir ?? defaultOracleSourceDir()));
    steps.push(ensureOraclePlannerRole(cwd));
  }
  steps.push(
    writeEnvJsonStub(
      cwd,
      opts.defaultBaseUrl ?? DEFAULT_BASE_URL,
      opts.defaultAuthToken ?? DEFAULT_AUTH_TOKEN_PLACEHOLDER,
    ),
  );
  steps.push(ensureGitignoreEntries(cwd, BASE_GITIGNORE_ENTRIES));
  if (opts.installOracle) {
    steps.push(ensureGitignoreEntries(cwd, ORACLE_GITIGNORE_ENTRIES));
  }
  steps.push(wireMcpServer(cwd));

  for (const s of steps) {
    const tag = s.status === "created" ? "+" : s.status === "updated" ? "~" : "=";
    log(`  ${tag} ${s.name}${s.path ? ` (${s.path})` : ""}${s.reason ? ` — ${s.reason}` : ""}`);
  }
  log("");
  log("composer init: done.");
  log("");
  log("Next steps:");
  log("  1. Fill .env.json with real ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL.");
  log("  2. Launch Claude Code: claude");
  log("  3. Verify the orchestrator skill loads: /composer-mastermind");
  log("  4. Smoke-test the autoresearch loop: /evolve --eval-mode synthetic");

  return { steps };
}

export interface GlobalInitOptions {
  /** Override the global config dir (tests inject a tmpdir). Defaults to ~/.config/composer. */
  globalDir?: string;
  /** Override the user's Claude Code home dir (tests inject a tmpdir). Defaults to ~/.claude. */
  claudeHome?: string;
  verbose?: boolean;
  defaultBaseUrl?: string;
  defaultAuthToken?: string;
  /** Skip plugin asset install (default: false — assets ARE installed). */
  skipPluginAssets?: boolean;
  /** Override the plugin source directory (tests inject). */
  pluginSourceDir?: string;
}

/**
 * User-level (global) bootstrap. Writes composer.config.json and .env.json
 * to ~/.config/composer/ and patches ~/.claude/settings.json with the
 * mcpServers.composer entry so new projects work without per-project init.
 *
 * Runtime lookup chain (see src/config/paths.ts) makes the global files
 * apply automatically when a project has no local copy.
 */
export function runGlobalInit(opts: GlobalInitOptions = {}): InitResult {
  const dir = opts.globalDir ?? globalConfigDir();
  const claudeHome = opts.claudeHome ?? join(homedir(), ".claude");
  const steps: InitStep[] = [];
  const log = (...args: unknown[]) => {
    if (opts.verbose !== false) process.stdout.write(args.map(String).join(" ") + "\n");
  };

  steps.push(ensureDir(dir, "global config dir"));
  steps.push(writeGlobalComposerConfig(dir));
  steps.push(
    writeGlobalEnvJson(
      dir,
      opts.defaultBaseUrl ?? DEFAULT_BASE_URL,
      opts.defaultAuthToken ?? DEFAULT_AUTH_TOKEN_PLACEHOLDER,
    ),
  );
  steps.push(ensureDir(claudeHome, "~/.claude directory"));
  steps.push(wireGlobalMcpServer(claudeHome));

  // Wave 4 0.1.2: drop plugin assets at user-level so the orchestrator
  // skill + subagents + /evolve + boundary hook auto-load in every project.
  if (!opts.skipPluginAssets) {
    const pluginSteps = installPluginAssets({
      claudeHome,
      pluginSourceDir: opts.pluginSourceDir,
    });
    steps.push(...pluginSteps);
  }

  for (const s of steps) {
    const tag = s.status === "created" ? "+" : s.status === "updated" ? "~" : "=";
    log(`  ${tag} ${s.name}${s.path ? ` (${s.path})` : ""}${s.reason ? ` — ${s.reason}` : ""}`);
  }
  log("");
  log("composer init --global: done.");
  log("");
  log("Next steps:");
  log(`  1. Fill ${join(dir, ".env.json")} with real ANTHROPIC_AUTH_TOKEN.`);
  log("  2. Launch Claude Code from ANY project: claude");
  log("     (no per-project init required — runtime falls back to global config + env)");
  log("  3. Per-project overrides still work: drop composer.config.json or .env.json in cwd.");

  return { steps };
}

function ensureDir(dirPath: string, label: string): InitStep {
  if (existsSync(dirPath)) return { name: label, status: "skipped", path: dirPath, reason: "already exists" };
  mkdirSync(dirPath, { recursive: true });
  return { name: label, status: "created", path: dirPath };
}

function writeGlobalComposerConfig(dir: string): InitStep {
  const path = join(dir, "composer.config.json");
  if (existsSync(path)) {
    return { name: "global composer.config.json", status: "skipped", path, reason: "already exists; not overwritten" };
  }
  writeFileSync(path, JSON.stringify(DEFAULT_COMPOSER_CONFIG, null, 2) + "\n", "utf8");
  return { name: "global composer.config.json", status: "created", path };
}

function writeGlobalEnvJson(dir: string, baseUrl: string, token: string): InitStep {
  const path = join(dir, ".env.json");
  if (existsSync(path)) {
    return { name: "global .env.json", status: "skipped", path, reason: "already exists; not overwritten" };
  }
  writeFileSync(path, JSON.stringify(DEFAULT_ENV_TEMPLATE(baseUrl, token), null, 2) + "\n", "utf8");
  return { name: "global .env.json", status: "created", path, reason: "placeholder — fill with real token" };
}

function wireGlobalMcpServer(claudeHome: string): InitStep {
  const path = join(claudeHome, "settings.json");
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify(DEFAULT_MCP_SETTINGS, null, 2) + "\n", "utf8");
    return { name: "~/.claude/settings.json", status: "created", path, reason: "mcpServers.composer wired (user-level)" };
  }
  const current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const mcpServers = (current["mcpServers"] as Record<string, unknown> | undefined) ?? {};
  if (mcpServers["composer"]) {
    return { name: "~/.claude/settings.json", status: "skipped", path, reason: "mcpServers.composer already wired" };
  }
  const merged = {
    ...current,
    mcpServers: { ...mcpServers, composer: DEFAULT_MCP_SETTINGS.mcpServers.composer },
  };
  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n", "utf8");
  return { name: "~/.claude/settings.json", status: "updated", path, reason: "mcpServers.composer wired (user-level)" };
}

function ensureClaudeDir(cwd: string): InitStep {
  const path = join(cwd, ".claude");
  if (existsSync(path)) return { name: ".claude/ directory", status: "skipped", path, reason: "already exists" };
  mkdirSync(path, { recursive: true });
  return { name: ".claude/ directory", status: "created", path };
}

function writeComposerConfig(cwd: string): InitStep {
  const path = join(cwd, "composer.config.json");
  if (existsSync(path)) {
    return { name: "composer.config.json", status: "skipped", path, reason: "already exists; not overwritten" };
  }
  writeFileSync(path, JSON.stringify(DEFAULT_COMPOSER_CONFIG, null, 2) + "\n", "utf8");
  return { name: "composer.config.json", status: "created", path };
}

function installOracleScripts(cwd: string, sourceDir: string): InitStep {
  const destDir = join(cwd, "scripts");
  mkdirSync(destDir, { recursive: true });
  const copied: string[] = [];
  for (const name of ORACLE_SCRIPTS) {
    const dest = join(destDir, name);
    if (existsSync(dest)) continue;
    copyFileSync(join(sourceDir, name), dest);
    chmodSync(dest, 0o755);
    copied.push(name);
  }
  return copied.length > 0
    ? { name: "oracle scripts", status: "created", path: destDir, reason: `copied ${copied.length} script(s)` }
    : { name: "oracle scripts", status: "skipped", path: destDir, reason: "already present" };
}

function ensureOraclePlannerRole(cwd: string): InitStep {
  const path = join(cwd, "composer.config.json");
  if (!existsSync(path)) {
    return { name: "oraclePlanner role", status: "skipped", path, reason: "no composer.config.json" };
  }
  const config = JSON.parse(readFileSync(path, "utf8")) as { roles?: Record<string, unknown> };
  config.roles ??= {};
  if (config.roles["oraclePlanner"]) {
    return { name: "oraclePlanner role", status: "skipped", path, reason: "already present" };
  }
  config.roles["oraclePlanner"] = { ...ORACLE_PLANNER_ROLE, cli: [...ORACLE_PLANNER_ROLE.cli] };
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
  return { name: "oraclePlanner role", status: "updated", path, reason: "added opt-in Oracle role" };
}

function writeEnvJsonStub(cwd: string, baseUrl: string, token: string): InitStep {
  const path = join(cwd, ".env.json");
  if (existsSync(path)) {
    return { name: ".env.json", status: "skipped", path, reason: "already exists; not overwritten" };
  }
  writeFileSync(path, JSON.stringify(DEFAULT_ENV_TEMPLATE(baseUrl, token), null, 2) + "\n", "utf8");
  return { name: ".env.json", status: "created", path, reason: "placeholder — fill before launching claude" };
}

function ensureGitignoreEntries(cwd: string, entries: string[]): InitStep {
  const path = join(cwd, ".gitignore");
  let current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = current.split(/\r?\n/).map((l) => l.trim());
  const missing = entries.filter((e) => !lines.includes(e));
  if (missing.length === 0) {
    return { name: ".gitignore", status: "skipped", path, reason: "entries already present" };
  }
  if (current.length > 0 && !current.endsWith("\n")) current += "\n";
  current += missing.join("\n") + "\n";
  const created = !existsSync(path);
  writeFileSync(path, current, "utf8");
  return { name: ".gitignore", status: created ? "created" : "updated", path, reason: `added ${missing.join(", ")}` };
}

function wireMcpServer(cwd: string): InitStep {
  const path = join(cwd, ".claude", "settings.json");
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify(DEFAULT_MCP_SETTINGS, null, 2) + "\n", "utf8");
    return { name: ".claude/settings.json", status: "created", path, reason: "mcpServers.composer wired" };
  }
  const current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const mcpServers = (current["mcpServers"] as Record<string, unknown> | undefined) ?? {};
  if (mcpServers["composer"]) {
    return { name: ".claude/settings.json", status: "skipped", path, reason: "mcpServers.composer already wired" };
  }
  const merged = {
    ...current,
    mcpServers: { ...mcpServers, composer: DEFAULT_MCP_SETTINGS.mcpServers.composer },
  };
  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n", "utf8");
  return { name: ".claude/settings.json", status: "updated", path, reason: "mcpServers.composer wired" };
}
