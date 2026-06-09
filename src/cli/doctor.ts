// Optional Codex review-gate diagnostics.
//
// The doctor is intentionally resilient: missing optional integrations are
// reported as checks instead of throwing out of the CLI.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../config/loader.js";
import type { CodexReview, ComposerConfig } from "../config/schema.js";

export interface CodexPluginRoot {
  root: string;
  version: string | null;
}

export interface DoctorCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  healthy: boolean;
}

interface ResolvedCodexReview {
  enabled: boolean;
  triggers: {
    preCommit: boolean;
    postPlan: boolean;
  };
  preCommitCommand: "review" | "adversarial-review";
  postPlanCommand: "review" | "adversarial-review";
  mode: "ask" | "auto";
  execution: "foreground" | "background";
  scope: "auto" | "working-tree" | "branch";
  base: string;
  preCommitHook: {
    enabled: boolean;
    blockOnSeverity: "critical" | "high" | "medium" | "low";
    timeoutMs: number;
    failClosed: boolean;
  };
}

const DEFAULT_CODEX_REVIEW: ResolvedCodexReview = {
  enabled: false,
  triggers: {
    preCommit: false,
    postPlan: false,
  },
  preCommitCommand: "review",
  postPlanCommand: "adversarial-review",
  mode: "ask",
  execution: "background",
  scope: "auto",
  base: "main",
  preCommitHook: {
    enabled: false,
    blockOnSeverity: "high",
    timeoutMs: 120000,
    failClosed: false,
  },
};

export function resolveCodexPluginRoot(pluginsDir: string): CodexPluginRoot | null {
  const marketplaceRoot = join(pluginsDir, "marketplaces", "openai-codex", "plugins", "codex");
  const marketplace = readCodexPluginRoot(marketplaceRoot);
  if (marketplace) return marketplace;

  const cacheBase = join(pluginsDir, "cache", "openai-codex", "codex");
  const cacheRoots = listSemverDirectories(cacheBase)
    .sort((a, b) => compareSemver(b.version, a.version))
    .map((entry) => readCodexPluginRoot(entry.root))
    .filter((entry): entry is CodexPluginRoot => entry !== null);
  return cacheRoots[0] ?? null;
}

export function buildConfigChecks(config: ComposerConfig): DoctorCheck[] {
  const codexReview = config.codexReview;
  const resolved = resolveCodexReview(codexReview);
  const enabledCheck = codexReview
    ? reviewEnabledCheck(resolved)
    : {
        name: "config: codexReview",
        status: "warn" as const,
        detail: "Codex review-gate is OFF (optional)",
      };
  return [
    enabledCheck,
    {
      name: "config: codexReview triggers",
      status: "pass",
      detail: `preCommit=${resolved.triggers.preCommit}, postPlan=${resolved.triggers.postPlan}`,
    },
    {
      name: "config: codexReview defaults",
      status: "pass",
      detail:
        `preCommitCommand=${resolved.preCommitCommand}, ` +
        `postPlanCommand=${resolved.postPlanCommand}, ` +
        `mode=${resolved.mode}, execution=${resolved.execution}, ` +
        `scope=${resolved.scope}, base=${resolved.base}`,
    },
    preCommitHookCheck(resolved),
  ];
}

export function isHealthy(checks: DoctorCheck[]): boolean {
  return checks.every((check) => check.status !== "fail");
}

export async function runDoctor(opts: { cwd: string; verbose?: boolean }): Promise<DoctorReport> {
  const config = loadConfigCheck(opts.cwd);
  const codexCli = checkCodexCli();
  const pluginRoot = resolveCodexPluginRoot(join(homedir(), ".claude", "plugins"));
  const pluginCheck = checkCodexPluginRoot(pluginRoot);
  const setupChecks = pluginRoot ? queryCodexSetup(pluginRoot.root) : [];
  const configChecks = config.ok ? buildConfigChecks(config.config) : [config.check];
  const checks = [codexCli, pluginCheck, ...setupChecks, ...configChecks];
  const report = { checks, healthy: isHealthy(checks) };

  if (opts.verbose !== false) printReport(report);
  return report;
}

function readCodexPluginRoot(root: string): CodexPluginRoot | null {
  const pluginJson = join(root, ".claude-plugin", "plugin.json");
  const companion = join(root, "scripts", "codex-companion.mjs");
  if (!existsSync(pluginJson) || !existsSync(companion)) return null;
  return { root, version: readPluginVersion(pluginJson) };
}

function readPluginVersion(pluginJson: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(pluginJson, "utf8"));
    if (isRecord(parsed) && typeof parsed["version"] === "string") return parsed["version"];
    return null;
  } catch {
    return null;
  }
}

function listSemverDirectories(base: string): Array<{ root: string; version: string }> {
  try {
    if (!existsSync(base)) return [];
    return readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && parseSemver(entry.name) !== null)
      .map((entry) => ({ root: join(base, entry.name), version: entry.name }));
  } catch {
    return [];
  }
}

function parseSemver(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return null;
  return [major, minor, patch];
}

function compareSemver(a: string, b: string): number {
  const left = parseSemver(a) ?? [0, 0, 0];
  const right = parseSemver(b) ?? [0, 0, 0];
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2] || a.localeCompare(b);
}

function resolveCodexReview(codexReview: CodexReview | undefined): ResolvedCodexReview {
  return {
    enabled: codexReview?.enabled ?? DEFAULT_CODEX_REVIEW.enabled,
    triggers: {
      preCommit: codexReview?.triggers?.preCommit ?? DEFAULT_CODEX_REVIEW.triggers.preCommit,
      postPlan: codexReview?.triggers?.postPlan ?? DEFAULT_CODEX_REVIEW.triggers.postPlan,
    },
    preCommitCommand: codexReview?.preCommitCommand ?? DEFAULT_CODEX_REVIEW.preCommitCommand,
    postPlanCommand: codexReview?.postPlanCommand ?? DEFAULT_CODEX_REVIEW.postPlanCommand,
    mode: codexReview?.mode ?? DEFAULT_CODEX_REVIEW.mode,
    execution: codexReview?.execution ?? DEFAULT_CODEX_REVIEW.execution,
    scope: codexReview?.scope ?? DEFAULT_CODEX_REVIEW.scope,
    base: codexReview?.base ?? DEFAULT_CODEX_REVIEW.base,
    preCommitHook: {
      enabled: codexReview?.preCommitHook?.enabled ?? DEFAULT_CODEX_REVIEW.preCommitHook.enabled,
      blockOnSeverity:
        codexReview?.preCommitHook?.blockOnSeverity ?? DEFAULT_CODEX_REVIEW.preCommitHook.blockOnSeverity,
      timeoutMs: codexReview?.preCommitHook?.timeoutMs ?? DEFAULT_CODEX_REVIEW.preCommitHook.timeoutMs,
      failClosed: codexReview?.preCommitHook?.failClosed ?? DEFAULT_CODEX_REVIEW.preCommitHook.failClosed,
    },
  };
}

function reviewEnabledCheck(resolved: ResolvedCodexReview): DoctorCheck {
  return resolved.enabled
    ? {
        name: "config: codexReview",
        status: "pass",
        detail: "Codex review-gate is ON",
      }
    : {
        name: "config: codexReview",
        status: "warn",
        detail: "Codex review-gate is OFF (optional)",
      };
}

function preCommitHookCheck(resolved: ResolvedCodexReview): DoctorCheck {
  const hook = resolved.preCommitHook;
  return hook.enabled
    ? {
        name: "config: codexReview preCommitHook",
        status: "pass",
        detail:
          `mechanical gate enabled=${hook.enabled}, ` +
          `blockOnSeverity=${hook.blockOnSeverity}, failClosed=${hook.failClosed}`,
      }
    : {
        name: "config: codexReview preCommitHook",
        status: "warn",
        detail: "mechanical pre-commit gate OFF",
      };
}

function loadConfigCheck(cwd: string): { ok: true; config: ComposerConfig } | { ok: false; check: DoctorCheck } {
  const previousCwd = process.cwd();
  try {
    process.chdir(resolve(cwd));
    const configPath = process.env["COMPOSER_CONFIG"] ?? "composer.config.json";
    return { ok: true, config: loadConfig(configPath) };
  } catch (error) {
    return {
      ok: false,
      check: {
        name: "config",
        status: "fail",
        detail: `config: ${errorMessage(error)}`,
      },
    };
  } finally {
    process.chdir(previousCwd);
  }
}

function checkCodexCli(): DoctorCheck {
  try {
    const result = spawnSync("codex", ["--version"], { encoding: "utf8", timeout: 10000 });
    if (result.error || result.status !== 0) return codexCliMissingCheck();
    const version = result.stdout.trim() || result.stderr.trim() || "version reported";
    return { name: "codex CLI", status: "pass", detail: version };
  } catch {
    return codexCliMissingCheck();
  }
}

function codexCliMissingCheck(): DoctorCheck {
  return {
    name: "codex CLI",
    status: "fail",
    detail: "codex CLI not found — install with: npm install -g @openai/codex",
  };
}

function checkCodexPluginRoot(pluginRoot: CodexPluginRoot | null): DoctorCheck {
  if (!pluginRoot) {
    return {
      name: "codex plugin",
      status: "fail",
      detail: "codex plugin for Claude Code not found",
    };
  }
  const version = pluginRoot.version ? `v${pluginRoot.version}` : "unknown version";
  return {
    name: "codex plugin",
    status: "pass",
    detail: `codex plugin ${version} at ${pluginRoot.root}`,
  };
}

function queryCodexSetup(pluginRoot: string): DoctorCheck[] {
  try {
    const script = join(pluginRoot, "scripts", "codex-companion.mjs");
    const result = spawnSync("node", [script, "setup", "--json"], { encoding: "utf8", timeout: 30000 });
    if (result.error || result.status !== 0) return [codexSetupWarn(result.stderr || result.error?.message || "command failed")];
    const parsed: unknown = JSON.parse(result.stdout);
    return [authCheck(parsed), reviewGateCheck(parsed)];
  } catch (error) {
    return [codexSetupWarn(errorMessage(error))];
  }
}

function codexSetupWarn(reason: string): DoctorCheck {
  return {
    name: "codex setup",
    status: "warn",
    detail: `could not query codex setup: ${reason}`,
  };
}

function authCheck(payload: unknown): DoctorCheck {
  const authenticated = findBoolean(payload, ["authenticated", "codexAuthenticated", "loggedIn"]);
  if (authenticated === undefined) {
    return {
      name: "codex auth",
      status: "warn",
      detail: "could not determine auth state",
    };
  }
  return authenticated
    ? { name: "codex auth", status: "pass", detail: "codex authenticated" }
    : { name: "codex auth", status: "warn", detail: "codex is not authenticated" };
}

function reviewGateCheck(payload: unknown): DoctorCheck {
  const enabled = findBoolean(payload, ["reviewGateEnabled"]);
  const state = enabled === undefined ? "unknown" : enabled ? "enabled" : "disabled";
  return {
    name: "codex plugin reviewGateEnabled",
    status: "warn",
    detail: `plugin global stop-gate is ${state}; composer drives review at its own trigger points, so it is not required`,
  };
}

function findBoolean(value: unknown, keys: string[]): boolean | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    if (typeof value[key] === "boolean") return value[key];
  }
  for (const nested of Object.values(value)) {
    const found = findBoolean(nested, keys);
    if (found !== undefined) return found;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printReport(report: DoctorReport): void {
  process.stdout.write("composer doctor\n");
  for (const check of report.checks) {
    process.stdout.write(`${check.status.toUpperCase()} ${check.name}: ${check.detail}\n`);
  }
  process.stdout.write(`summary: ${report.healthy ? "healthy" : "unhealthy"} (${report.checks.length} checks)\n`);
}
