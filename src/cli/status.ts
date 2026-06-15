import { existsSync, statSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../config/loader.js";
import type { ComposerConfig } from "../config/schema.js";
import { globalConfigDir } from "../config/paths.js";
import { readLatestOracleJob } from "../util/oracleJob.js";
import { readLatestCodexLifecycleJob } from "../util/codexLifecycleJob.js";
import { readAuditEvents } from "../util/auditLog.js";
import { isComposerDisabled } from "../util/composerDisabled.js";
import { readActiveGoal } from "../util/goal.js";

export interface ComposerStatus {
  config: {
    path: string;
    exists: boolean;
    mode: "fast" | "balanced" | "strict" | null;
    oracleDefaultMode?: string;
    oracleRequireExplicitTag?: boolean;
  };
  session?: {
    mode?: string;
    oracle?: { enabled?: boolean; defaultMode?: string; requireExplicitTag?: boolean };
    profile?: string;
  };
  integrations: {
    codexReview: boolean;
    codexLifecycle: boolean;
    oraclePlanner: boolean;
    gitHook: "off" | "warn" | "on";
    gitHookInstalled: boolean;
    composerDisabled: boolean;
  };
  active: {
    oracleJob?: { jobId: string; status: string; mode: string; ageSeconds: number };
    codexJob?: { jobId: string; status: string; event: string; ageSeconds: number };
    foreground?: Array<{ tool: string; providerRole?: string; ageSeconds: number }>;
  };
  latestJob: {
    oracleJob?: { jobId: string; status: string; mode: string; ageSeconds: number };
    codexJob?: { jobId: string; status: string; event: string; ageSeconds: number };
  };
  latest: {
    route?: string;
    taskClass?: string;
    tool?: string;
    reviewVerdict?: string;
    testsPassed?: boolean;
    auditStatus?: string;
  };
  recommendation: {
    nextAction?: string;
    reason?: string;
  };
  goal?: {
    goalId: string;
    state: string;
    turns: number;
    nextReason?: string;
  };
}

function ageSeconds(iso: string | undefined, nowMs: number): number {
  return iso ? Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 1000)) : 0;
}

function deriveMode(config: ComposerConfig | undefined): "fast" | "balanced" | "strict" | null {
  if (!config) return null;
  const review = config.codexReview?.enabled;
  const lc = config.codexLifecycle?.enabled;
  const failClosed = config.codexReview?.preCommitHook?.failClosed;
  const lcMode = config.codexLifecycle?.mode;
  if (!review && !lc) return "fast";
  if (review && lc && failClosed && lcMode === "auto") return "strict";
  if (review && lc) return "balanced";
  return null;
}

function recommend(params: {
  exists: boolean;
  integrations: ComposerStatus["integrations"];
  active: ComposerStatus["active"];
  goal?: ComposerStatus["goal"];
}): ComposerStatus["recommendation"] {
  const { exists, active, goal } = params;
  if (!exists) {
    return { nextAction: "agent-composer init", reason: "no composer.config.json found" };
  }
  if (
    active.oracleJob &&
    (active.oracleJob.status === "queued" || active.oracleJob.status === "running")
  ) {
    return { nextAction: "composer_oracle_job_result", reason: "an Oracle job is in progress" };
  }
  if (goal?.state === "blocked") {
    return {
      nextAction: "composer_goal_step",
      reason: "goal is blocked; extend budget, report check results, or clear",
    };
  }
  if (goal?.state === "active") {
    return { nextAction: "composer_goal_step", reason: "active goal; advance the goal loop" };
  }
  return {
    nextAction: "composer_route_decide",
    reason: "ask Composer which lane fits the next task",
  };
}

function detectGitHook(root: string): "off" | "warn" | "on" {
  const result = spawnSync("git", ["-C", root, "rev-parse", "--git-path", "hooks/pre-commit"], {
    encoding: "utf8",
    timeout: 10000,
  });
  let hookPath: string;
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    hookPath = resolve(root, ".git", "hooks", "pre-commit");
  } else {
    hookPath = resolve(root, result.stdout.trim());
  }
  if (!existsSync(hookPath)) return "off";
  try {
    const stat = statSync(hookPath);
    if (!stat.isFile()) return "off";
    const isExecutable = (stat.mode & 0o111) !== 0;
    if (!isExecutable) return "off";
    const text = readFileSync(hookPath, "utf8");
    if (!text.includes("precommit_codex_review.sh")) return "off";
    if (text.includes("--git-hook") || text.includes("COMPOSER_PRECOMMIT_GITHOOK")) return "on";
    return "warn";
  } catch {
    return "off";
  }
}

function resolveStatusConfigPath(cwd: string): string | null {
  const explicit = process.env["COMPOSER_CONFIG"];
  if (explicit) {
    const r = resolve(cwd, explicit);
    if (existsSync(r)) return r;
  }
  const name = "composer.config.json";
  const local = resolve(cwd, name);
  if (existsSync(local)) return local;
  const global = join(globalConfigDir(), name);
  if (existsSync(global)) return global;
  return null;
}

export function buildStatus(cwd: string, opts: { nowMs?: number } = {}): ComposerStatus {
  const nowMs = opts.nowMs ?? Date.now();
  const resolvedPath = resolveStatusConfigPath(cwd);
  let exists = resolvedPath !== null;
  const configPath = resolvedPath ?? resolve(cwd, process.env["COMPOSER_CONFIG"] ?? "composer.config.json");
  const root = resolve(cwd);

  let config: ComposerConfig | undefined;
  if (resolvedPath) {
    try {
      config = loadConfig(resolvedPath);
    } catch {
      exists = false;
      config = undefined;
    }
  }

  const composerDisabled = isComposerDisabled({ projectDir: root });

  const gitHook = detectGitHook(root);
  const integrations: ComposerStatus["integrations"] = {
    codexReview: Boolean(config?.codexReview?.enabled),
    codexLifecycle: Boolean(config?.codexLifecycle?.enabled),
    oraclePlanner: Boolean(config?.roles?.oraclePlanner),
    gitHook,
    gitHookInstalled: gitHook !== "off",
    composerDisabled,
  };

  const mode = deriveMode(config);

  const active: ComposerStatus["active"] = {};
  const latestJob: ComposerStatus["latestJob"] = {};
  try {
    const oj = readLatestOracleJob(root);
    if (oj) {
      const e = {
        jobId: oj.jobId,
        status: oj.status,
        mode: oj.mode,
        ageSeconds: ageSeconds(oj.startedAt ?? oj.createdAt, nowMs),
      };
      latestJob.oracleJob = e;
      if (oj.status === "running" || oj.status === "queued") {
        active.oracleJob = e;
      }
    }
  } catch {
    // ignore
  }
  try {
    const cj = readLatestCodexLifecycleJob(root);
    if (cj) {
      const e = {
        jobId: cj.jobId,
        status: cj.status,
        event: cj.event,
        ageSeconds: ageSeconds(cj.startedAt ?? cj.createdAt, nowMs),
      };
      latestJob.codexJob = e;
      if (cj.status === "running" || cj.status === "queued") {
        active.codexJob = e;
      }
    }
  } catch {
    // ignore
  }

  const latest: ComposerStatus["latest"] = {};
  try {
    const recent = readAuditEvents(root, { limit: 50 });
    const findLast = (pred: (e: (typeof recent)[number]) => boolean) => {
      for (let i = recent.length - 1; i >= 0; i--) {
        if (pred(recent[i]!)) return recent[i]!;
      }
      return undefined;
    };
    const routeEv = findLast((e) => e.kind === "route-decision");
    latest.route = routeEv?.route;
    latest.taskClass = routeEv?.taskClass;
    latest.tool = findLast((e) => e.kind === "tool-call")?.tool;
    latest.reviewVerdict = findLast((e) => e.kind === "review")?.reviewVerdict;
    latest.testsPassed = findLast((e) => e.kind === "test")?.testsPassed;
    latest.auditStatus = findLast((e) => e.kind === "outcome")?.status;
  } catch {
    // ignore
  }

  let goal: ComposerStatus["goal"];
  try {
    const activeGoal = readActiveGoal(root);
    if (activeGoal) {
      goal = {
        goalId: activeGoal.goalId,
        state: activeGoal.state,
        turns: activeGoal.turns,
        nextReason: activeGoal.lastReason,
      };
    }
  } catch {
    // ignore
  }

  const recommendation = recommend({ exists, integrations, active, goal });

  return {
    config: {
      path: configPath,
      exists,
      mode,
      oracleDefaultMode: config?.oracle?.defaultMode,
      oracleRequireExplicitTag: config?.oracle?.requireExplicitTag,
    },
    integrations,
    active,
    latestJob,
    latest,
    recommendation,
    goal,
  };
}

export interface StatusSessionView {
  mode?: string;
  oracle?: { enabled?: boolean; defaultMode?: string; requireExplicitTag?: boolean };
  profile?: string;
}

export function renderStatusLine(s: ComposerStatus, session?: StatusSessionView): string {
  const mode = session?.mode ?? s.config.mode ?? (s.config.exists ? "custom" : "no-config");
  const R = s.integrations.codexReview ? "on" : "off";
  const L = s.integrations.codexLifecycle ? "on" : "off";
  const oJob = s.active.oracleJob;
  let O: string;
  if (oJob && (oJob.status === "running" || oJob.status === "queued")) {
    O = `busy ${Math.round(oJob.ageSeconds / 60)}m`;
  } else if (session?.oracle?.enabled === true) {
    O = "idle";
  } else if (session?.oracle?.enabled === false) {
    O = "off";
  } else if (s.integrations.oraclePlanner) {
    O = "idle";
  } else {
    O = "off";
  }
  const H = s.integrations.gitHook;

  const lastParts = [
    s.latest.tool ? `tool=${s.latest.tool}` : null,
    s.latest.reviewVerdict ? `review=${s.latest.reviewVerdict}` : null,
    s.latest.testsPassed !== undefined
      ? `tests=${s.latest.testsPassed ? "pass" : "fail"}`
      : null,
  ].filter(Boolean);

  const last =
    lastParts.length > 0
      ? lastParts.join(" ")
      : s.recommendation.nextAction
        ? `next=${s.recommendation.nextAction}`
        : "-";

  const disabledPart = s.integrations.composerDisabled ? " · DISABLED" : "";
  const next = s.recommendation.nextAction ?? "-";
  const profilePart = session?.profile ? ` · P:${session.profile}` : "";
  const goalPart = s.goal
    ? ` · goal:${s.goal.state} ${s.goal.turns}t${s.goal.nextReason ? ` · next:${shortStatusText(s.goal.nextReason)}` : ""}`
    : "";
  const fg = s.active.foreground;
  const activeSeg =
    fg && fg.length > 0
      ? `active:${fg[0]!.tool.replace(/^composer_/, "")} ${fg[0]!.ageSeconds < 60 ? fg[0]!.ageSeconds + "s" : Math.round(fg[0]!.ageSeconds / 60) + "m"}`
      : "active:none";
  return `CMP ${mode}${profilePart} · R:${R} · L:${L} · O:${O} · H:${H}${disabledPart}${goalPart} · ${activeSeg} · last:${last} · next:${next}`;
}

function shortStatusText(value: string): string {
  return value.length > 32 ? `${value.slice(0, 29)}...` : value;
}

export function renderStatusHuman(s: ComposerStatus): string {
  const lines: string[] = [];
  lines.push("composer status");
  lines.push(`  config:           ${s.config.path} (${s.config.exists ? "found" : "missing"})`);
  lines.push(`  mode:             ${s.config.mode ?? (s.config.exists ? "custom" : "no-config")}`);
  if (s.config.exists) {
    lines.push(`  codexReview:      ${s.integrations.codexReview ? "enabled" : "disabled"}`);
    lines.push(`  codexLifecycle:   ${s.integrations.codexLifecycle ? "enabled" : "disabled"}`);
    lines.push(`  oraclePlanner:    ${s.integrations.oraclePlanner ? "configured" : "not configured"}`);
    if (s.config.oracleDefaultMode !== undefined) {
      lines.push(`  oracle.defaultMode: ${s.config.oracleDefaultMode}`);
    }
    if (s.config.oracleRequireExplicitTag !== undefined) {
      lines.push(`  oracle.requireExplicitTag: ${String(s.config.oracleRequireExplicitTag)}`);
    }
  }
  const gitHookLabel =
    s.integrations.gitHook === "on"
      ? "installed, blocking (--git-hook)"
      : s.integrations.gitHook === "warn"
        ? "installed, NOT --git-hook (Claude PreToolUse only)"
        : "not installed";
  lines.push(`  git pre-commit:   ${gitHookLabel}`);
  if (s.integrations.composerDisabled) {
    lines.push("  COMPOSER_DISABLED: true");
  }
  if (s.active.oracleJob) {
    const j = s.active.oracleJob;
    lines.push(`  oracle job:       ${j.jobId.slice(0, 8)}… status=${j.status} mode=${j.mode} age=${j.ageSeconds}s`);
  }
  if (s.active.codexJob) {
    const j = s.active.codexJob;
    lines.push(`  codex job:        ${j.jobId.slice(0, 8)}… status=${j.status} event=${j.event} age=${j.ageSeconds}s`);
  }
  const fgRuns = s.active.foreground;
  if (fgRuns && fgRuns.length > 0) {
    lines.push(`  active:           ${fgRuns.map((r) => `${r.tool} ${r.ageSeconds}s`).join(", ")}`);
  } else {
    lines.push("  active:           none");
  }
  if (s.latest.route || s.latest.tool || s.latest.reviewVerdict) {
    const parts = [
      s.latest.route && `route=${s.latest.route}`,
      s.latest.tool && `tool=${s.latest.tool}`,
      s.latest.reviewVerdict && `review=${s.latest.reviewVerdict}`,
      s.latest.testsPassed !== undefined && `tests=${s.latest.testsPassed ? "pass" : "fail"}`,
    ]
      .filter(Boolean)
      .join(" ");
    lines.push(`  last audit:       ${parts}`);
  }
  if (s.recommendation.nextAction) {
    lines.push(`  next:             ${s.recommendation.nextAction} — ${s.recommendation.reason ?? ""}`);
  }
  return lines.join("\n") + "\n";
}

export function statusEnvelope(
  status: ComposerStatus,
  session?: StatusSessionView,
): { version: number; line: string } & ComposerStatus {
  return { version: 1, ...status, line: renderStatusLine(status, session) };
}

export function runStatus(
  cwd: string,
  opts: { json?: boolean; line?: boolean; watch?: boolean; replace?: boolean } = {},
): void {
  if (opts.watch) {
    if (opts.replace) {
      let prevLen = 0;
      const tick = () => {
        const line = renderStatusLine(buildStatus(cwd));
        const padded = line.padEnd(prevLen);
        prevLen = line.length;
        process.stdout.write(`\r${padded}`);
      };
      const cleanup = () => {
        process.stdout.write("\n");
        process.exit(0);
      };
      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);
      tick();
      setInterval(tick, 2000);
    } else {
      process.stdout.write(renderStatusLine(buildStatus(cwd)) + "\n");
      setInterval(() => {
        process.stdout.write(renderStatusLine(buildStatus(cwd)) + "\n");
      }, 2000);
    }
    return;
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(statusEnvelope(buildStatus(cwd)), null, 2) + "\n");
    return;
  }
  if (opts.line) {
    process.stdout.write(renderStatusLine(buildStatus(cwd)) + "\n");
    return;
  }
  process.stdout.write(renderStatusHuman(buildStatus(cwd)));
}
