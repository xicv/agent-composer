// Optional Codex review-gate diagnostics.
//
// The doctor is intentionally resilient: missing optional integrations are
// reported as checks instead of throwing out of the CLI.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../config/loader.js";
import type { CodexRescue, CodexReview, ComposerConfig } from "../config/schema.js";
import { DEFAULT_ANTHROPIC_MODEL } from "../registry.js";
import { resolveCodexLifecycle } from "../util/codexLifecycle.js";

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
  model?: string;
  preCommitHook: {
    enabled: boolean;
    blockOnSeverity: "critical" | "high" | "medium" | "low";
    timeoutMs: number;
    failClosed: boolean;
    maxConsecutiveBlocks: number;
  };
  warmCache: {
    enabled: boolean;
    maxAgeMinutes: number;
    timeoutMs: number;
  };
  notify: {
    desktop: boolean;
  };
}

interface ResolvedCodexRescue {
  enabled: boolean;
  mode: "ask" | "auto";
  model: string;
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
    timeoutMs: 900000,
    failClosed: false,
    maxConsecutiveBlocks: 0,
  },
  warmCache: {
    enabled: false,
    maxAgeMinutes: 30,
    timeoutMs: 300000,
  },
  notify: {
    desktop: false,
  },
};

const DEFAULT_CODEX_RESCUE: ResolvedCodexRescue = {
  enabled: true,
  mode: "ask",
  model: "gpt-5.4-mini",
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
  const rescue = resolveCodexRescue(config.codexRescue);
  const lifecycle = resolveCodexLifecycle(config.codexLifecycle);
  const coderModel = config.roles.coder.model ?? DEFAULT_ANTHROPIC_MODEL;
  const coderBaseUrl = config.roles.coder.baseUrl ?? "";
  const coderIsZai = coderBaseUrl.includes("api.z.ai");
  const coderIsGlm52 = coderModel.startsWith("glm-5.2");
  const coderModelStatus = coderIsGlm52 && !coderIsZai ? "warn" as const : "pass" as const;
  const coderModelDetail = coderIsGlm52
    ? coderIsZai
      ? `model=${coderModel} (requires a z.ai GLM Coding Plan token; standalone API pending)`
      : `model=${coderModel} but roles.coder.baseUrl is not a z.ai endpoint (${coderBaseUrl || "unset"}); glm-5.2 may require a z.ai GLM Coding Plan — verify your provider supports it`
    : `model=${coderModel}`;
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
        `scope=${resolved.scope}, base=${resolved.base}, ` +
        `model=${resolved.model ?? "unset"}`,
    },
    preCommitHookCheck(resolved),
    preCommitCommandCheck(resolved),
    warmCacheCheck(resolved),
    {
      name: "config: codexReview notify",
      status: "pass",
      detail: `desktop=${resolved.notify.desktop ? "on" : "off"}`,
    },
    {
      name: "config: codexRescue",
      status: "pass",
      detail: `enabled=${rescue.enabled}, mode=${rescue.mode}, model=${rescue.model}`,
    },
    {
      name: "config: coder model",
      status: coderModelStatus,
      detail: coderModelDetail,
    },
    {
      name: "config: codexLifecycle",
      status: lifecycle.enabled ? "pass" : "warn",
      detail:
        `enabled=${lifecycle.enabled}, mode=${lifecycle.mode}, ` +
        `execution=${lifecycle.execution}, model=${lifecycle.model}`,
    },
    {
      name: "config: codexLifecycle triggers",
      status: "pass",
      detail:
        `postResearch=${lifecycle.triggers.postResearch}, ` +
        `postPlan=${lifecycle.triggers.postPlan}, ` +
        `postCodeApply=${lifecycle.triggers.postCodeApply}, ` +
        `postTestFailure=${lifecycle.triggers.postTestFailure}, ` +
        `afterFailedAttempts=${lifecycle.triggers.afterFailedAttempts}, ` +
        `preCommit=${lifecycle.triggers.preCommit}, ` +
        `stopWarm=${lifecycle.triggers.stopWarm}`,
    },
    {
      name: "config: codexLifecycle thresholds",
      status: "pass",
      detail:
        `minScore=${lifecycle.thresholds.minScore}, ` +
        `minExpectedOutputTokens=${lifecycle.thresholds.minExpectedOutputTokens}, ` +
        `minChangedFiles=${lifecycle.thresholds.minChangedFiles}, ` +
        `minDiffLines=${lifecycle.thresholds.minDiffLines}, ` +
        `failedAttempts=${lifecycle.thresholds.failedAttempts}`,
    },
    {
      name: "config: codexLifecycle fallback",
      status: lifecycle.fallback.enabled ? "pass" : "warn",
      detail:
        `enabled=${lifecycle.fallback.enabled}, ` +
        `order=${lifecycle.fallback.order.join(">")}`,
    },
    {
      name: "config: oraclePlanner",
      status: config.roles?.oraclePlanner ? "pass" : "warn",
      detail: config.roles?.oraclePlanner
        ? "Oracle planning lane configured (roles.oraclePlanner)"
        : "Oracle planning lane not configured (optional; composer_oracle_plan needs roles.oraclePlanner)",
    },
  ];
}

export function isHealthy(checks: DoctorCheck[]): boolean {
  return checks.every((check) => check.status !== "fail");
}

export const ORACLE_BAD_NODE_MAJORS = [26];

export function classifyOracleNode(input: {
  oracleFound: boolean;
  nodeVersion: string | null;
  oraclePlannerConfigured: boolean;
}): DoctorCheck {
  if (!input.oracleFound) {
    return {
      name: "oracle runtime",
      status: input.oraclePlannerConfigured ? "fail" : "warn",
      detail: input.oraclePlannerConfigured
        ? "roles.oraclePlanner is configured but the oracle CLI is not on PATH — composer_oracle_plan and the async Oracle job tools cannot run; install oracle (npm install -g @steipete/oracle) or remove roles.oraclePlanner"
        : "oracle CLI not found (optional; needed only for composer_oracle_plan / roles.oraclePlanner)",
    };
  }
  const parsed = input.nodeVersion
    ? parseSemver(input.nodeVersion.replace(/^v/, ""))
    : null;
  if (!parsed) {
    return {
      name: "oracle runtime",
      status: "warn",
      detail: `oracle found, but its Node runtime could not be determined${
        input.nodeVersion ? ` (${input.nodeVersion})` : ""
      }`,
    };
  }
  const version = `v${parsed.join(".")}`;
  if (ORACLE_BAD_NODE_MAJORS.includes(parsed[0])) {
    const remedy =
      "reinstall under Node 24 LTS: brew uninstall oracle && npm install -g @steipete/oracle";
    return {
      name: "oracle runtime",
      // Fail only when the feature is actually configured; otherwise warn.
      status: input.oraclePlannerConfigured ? "fail" : "warn",
      detail:
        `oracle runs under Node ${version}, which has the undici setTypeOfService ` +
        `EINVAL crash on uploads — ${remedy}`,
    };
  }
  return {
    name: "oracle runtime",
    status: "pass",
    detail: `oracle runs under Node ${version}`,
  };
}

export function classifyPreCommitJq(input: {
  gateFailClosedEnabled: boolean;
  jqAvailable: boolean;
}): DoctorCheck {
  if (!input.gateFailClosedEnabled) {
    return {
      name: "pre-commit jq",
      status: "pass",
      detail: input.jqAvailable
        ? "jq present"
        : "jq not found (only required for a fail-closed Codex pre-commit gate)",
    };
  }
  return input.jqAvailable
    ? { name: "pre-commit jq", status: "pass", detail: "jq present for the fail-closed Codex gate" }
    : {
        name: "pre-commit jq",
        status: "fail",
        detail:
          "codexReview.preCommitHook.failClosed=true but jq is not on PATH — the gate would fail OPEN; install jq (brew install jq)",
      };
}

function detectOracleNodeVersion(): { oracleFound: boolean; nodeVersion: string | null } {
  const locator = process.platform === "win32" ? "where" : "which";
  const located = spawnSync(locator, ["oracle"], { encoding: "utf8", timeout: 10000 });
  if (located.error || located.status !== 0) return { oracleFound: false, nodeVersion: null };
  const oraclePath = located.stdout.split(/\r?\n/)[0]?.trim();
  if (!oraclePath || !existsSync(oraclePath)) return { oracleFound: false, nodeVersion: null };

  let nodeBin = "node";
  try {
    const firstLine = readFileSync(oraclePath, "utf8").split(/\r?\n/)[0] ?? "";
    const match = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(firstLine);
    if (match) {
      const interp = match[1] ?? "";
      if (interp.endsWith("/env")) nodeBin = match[2] ?? "node";
      else if (/node/.test(interp)) nodeBin = interp;
    }
  } catch {
    // Unreadable shebang (e.g. compiled binary) — fall back to PATH node.
  }

  const version = spawnSync(nodeBin, ["--version"], { encoding: "utf8", timeout: 10000 });
  if (version.error || version.status !== 0) return { oracleFound: true, nodeVersion: null };
  return { oracleFound: true, nodeVersion: version.stdout.trim() || null };
}

export function checkOracleRuntime(config: ComposerConfig | null): DoctorCheck {
  const detected = detectOracleNodeVersion();
  return classifyOracleNode({
    ...detected,
    oraclePlannerConfigured: Boolean(config?.roles?.oraclePlanner),
  });
}

function detectJqAvailable(): boolean {
  try {
    const r = spawnSync("jq", ["--version"], { encoding: "utf8", timeout: 10000 });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

export async function runDoctor(opts: { cwd: string; verbose?: boolean }): Promise<DoctorReport> {
  const config = loadConfigCheck(opts.cwd);
  const codexCli = checkCodexCli();
  const pluginRoot = resolveCodexPluginRoot(join(homedir(), ".claude", "plugins"));
  const pluginCheck = checkCodexPluginRoot(pluginRoot);
  const setupChecks = pluginRoot ? queryCodexSetup(pluginRoot.root) : [];
  const configChecks = config.ok ? buildConfigChecks(config.config) : [config.check];
  const gitHookChecks = config.ok ? [checkGitPreCommitHook(opts.cwd, config.config)] : [];
  const oracleRuntime = checkOracleRuntime(config.ok ? config.config : null);
  const jqAvailable = detectJqAvailable();
  const review = config.ok ? resolveCodexReview(config.config.codexReview) : undefined;
  const jqCheck = classifyPreCommitJq({
    gateFailClosedEnabled: Boolean(review?.enabled && review?.preCommitHook.enabled && review?.preCommitHook.failClosed),
    jqAvailable,
  });
  const checks = [codexCli, pluginCheck, ...setupChecks, ...configChecks, ...gitHookChecks, oracleRuntime, jqCheck];
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
    model: codexReview?.model ?? DEFAULT_CODEX_REVIEW.model,
    preCommitHook: {
      enabled: codexReview?.preCommitHook?.enabled ?? DEFAULT_CODEX_REVIEW.preCommitHook.enabled,
      blockOnSeverity:
        codexReview?.preCommitHook?.blockOnSeverity ?? DEFAULT_CODEX_REVIEW.preCommitHook.blockOnSeverity,
      timeoutMs: codexReview?.preCommitHook?.timeoutMs ?? DEFAULT_CODEX_REVIEW.preCommitHook.timeoutMs,
      failClosed: codexReview?.preCommitHook?.failClosed ?? DEFAULT_CODEX_REVIEW.preCommitHook.failClosed,
      maxConsecutiveBlocks:
        codexReview?.preCommitHook?.maxConsecutiveBlocks ??
        DEFAULT_CODEX_REVIEW.preCommitHook.maxConsecutiveBlocks,
    },
    warmCache: {
      enabled: codexReview?.warmCache?.enabled ?? DEFAULT_CODEX_REVIEW.warmCache.enabled,
      maxAgeMinutes: codexReview?.warmCache?.maxAgeMinutes ?? DEFAULT_CODEX_REVIEW.warmCache.maxAgeMinutes,
      timeoutMs: codexReview?.warmCache?.timeoutMs ?? DEFAULT_CODEX_REVIEW.warmCache.timeoutMs,
    },
    notify: {
      desktop: codexReview?.notify?.desktop ?? DEFAULT_CODEX_REVIEW.notify.desktop,
    },
  };
}

function resolveCodexRescue(codexRescue: CodexRescue | undefined): ResolvedCodexRescue {
  return {
    enabled: codexRescue?.enabled ?? DEFAULT_CODEX_RESCUE.enabled,
    mode: codexRescue?.mode ?? DEFAULT_CODEX_RESCUE.mode,
    model: codexRescue?.model ?? DEFAULT_CODEX_RESCUE.model,
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
          `blockOnSeverity=${hook.blockOnSeverity}, failClosed=${hook.failClosed}, ` +
          `maxConsecutiveBlocks=${hook.maxConsecutiveBlocks > 0 ? hook.maxConsecutiveBlocks : "off"}`,
      }
    : {
        name: "config: codexReview preCommitHook",
        status: "warn",
        detail: "mechanical pre-commit gate OFF",
      };
}

function preCommitCommandCheck(resolved: ResolvedCodexReview): DoctorCheck {
  if (resolved.preCommitHook.enabled && resolved.preCommitCommand === "review") {
    return {
      name: "config: codexReview preCommitCommand",
      status: "warn",
      detail:
        "preCommitCommand 'review' returns free-text only — the mechanical gate cannot extract a verdict; use 'adversarial-review'",
    };
  }
  return {
    name: "config: codexReview preCommitCommand",
    status: "pass",
    detail: `preCommitCommand=${resolved.preCommitCommand}`,
  };
}

function warmCacheCheck(resolved: ResolvedCodexReview): DoctorCheck {
  const warmCache = resolved.warmCache;
  if (warmCache.enabled && !resolved.preCommitHook.enabled) {
    return {
      name: "config: codexReview warmCache",
      status: "warn",
      detail: `warm cache is inert without preCommitHook, maxAgeMinutes=${warmCache.maxAgeMinutes}`,
    };
  }
  if (warmCache.enabled && !resolved.enabled) {
    return {
      name: "config: codexReview warmCache",
      status: "warn",
      detail: `on but inert because codexReview.enabled=false, maxAgeMinutes=${warmCache.maxAgeMinutes}`,
    };
  }
  return {
    name: "config: codexReview warmCache",
    status: "pass",
    detail: `${warmCache.enabled ? "on" : "off"}, maxAgeMinutes=${warmCache.maxAgeMinutes}`,
  };
}

export function checkGitPreCommitHook(cwd: string, config: ComposerConfig): DoctorCheck {
  const resolved = resolveCodexReview(config.codexReview);
  const hookPath = resolveGitHookPath(cwd);
  const required = resolved.enabled && resolved.preCommitHook.enabled;

  if (!hookPath) {
    return {
      name: "git: pre-commit hook",
      status: required ? "fail" : "warn",
      detail: "not a git repository or hook path could not be resolved",
    };
  }

  const installed = inspectComposerGitHook(hookPath);
  if (!required) {
    return {
      name: "git: pre-commit hook",
      status: "warn",
      detail: installed.ok
        ? `installed at ${hookPath}, but codexReview.preCommitHook.enabled=false`
        : `not required while codexReview/preCommitHook is off (${installed.reason})`,
    };
  }

  return installed.ok
    ? installed.gitHookMode
      ? {
          name: "git: pre-commit hook",
          status: "pass",
          detail: `terminal git commit gated by ${hookPath} (--git-hook mode)`,
        }
      : {
          name: "git: pre-commit hook",
          status: "warn",
          detail:
            `${hookPath} calls scripts/precommit_codex_review.sh but NOT in --git-hook mode — ` +
            `it only gates Claude-issued PreToolUse commits, not a terminal \`git commit\`. ` +
            `Make the hook run \`precommit_codex_review.sh --git-hook\` to block terminal commits.`,
        }
    : {
        name: "git: pre-commit hook",
        status: "fail",
        detail: `manual Terminal commits are not covered: ${installed.reason}`,
      };
}

function resolveGitHookPath(cwd: string): string | null {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--git-path", "hooks/pre-commit"], {
    encoding: "utf8",
    timeout: 10000,
  });
  if (result.error || result.status !== 0) return null;
  const hookPath = result.stdout.trim();
  return hookPath.length > 0 ? resolve(cwd, hookPath) : null;
}

function inspectComposerGitHook(
  hookPath: string,
): { ok: true; gitHookMode: boolean } | { ok: false; reason: string } {
  if (!existsSync(hookPath)) return { ok: false, reason: `${hookPath} is missing` };

  try {
    const stat = statSync(hookPath);
    if (!stat.isFile()) return { ok: false, reason: `${hookPath} is not a file` };
    if ((stat.mode & 0o111) === 0) return { ok: false, reason: `${hookPath} is not executable` };
    const text = readFileSync(hookPath, "utf8");
    if (!text.includes("scripts/precommit_codex_review.sh")) {
      return { ok: false, reason: `${hookPath} does not call scripts/precommit_codex_review.sh` };
    }
    const gitHookMode = text.includes("--git-hook") || text.includes("COMPOSER_PRECOMMIT_GITHOOK");
    return { ok: true, gitHookMode };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
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
