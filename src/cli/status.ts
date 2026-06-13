import { existsSync, statSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../config/loader.js";
import type { ComposerConfig } from "../config/schema.js";
import { readLatestOracleJob } from "../util/oracleJob.js";
import { readLatestCodexLifecycleJob } from "../util/codexLifecycleJob.js";
import { readAuditEvents } from "../util/auditLog.js";

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
    gitHookInstalled: boolean;
    composerDisabled: boolean;
  };
  active: {
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
}): ComposerStatus["recommendation"] {
  const { exists, active } = params;
  if (!exists) {
    return { nextAction: "agent-composer init", reason: "no composer.config.json found" };
  }
  if (
    active.oracleJob &&
    (active.oracleJob.status === "queued" || active.oracleJob.status === "running")
  ) {
    return { nextAction: "composer_oracle_job_result", reason: "an Oracle job is in progress" };
  }
  return {
    nextAction: "composer_route_decide",
    reason: "ask Composer which lane fits the next task",
  };
}

function detectGitHook(root: string): boolean {
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
  if (!existsSync(hookPath)) return false;
  try {
    const stat = statSync(hookPath);
    if (!stat.isFile()) return false;
    const text = readFileSync(hookPath, "utf8");
    return text.includes("precommit_codex_review.sh");
  } catch {
    return false;
  }
}

export function buildStatus(cwd: string, opts: { nowMs?: number } = {}): ComposerStatus {
  const nowMs = opts.nowMs ?? Date.now();
  const configRelPath = process.env["COMPOSER_CONFIG"] ?? "composer.config.json";
  const configPath = resolve(cwd, configRelPath);
  const root = resolve(cwd);

  let exists = existsSync(configPath);
  let config: ComposerConfig | undefined;
  if (exists) {
    try {
      config = loadConfig(configPath);
    } catch {
      exists = false;
    }
  }

  const composerDisabled =
    process.env["COMPOSER_DISABLED"] === "1" || process.env["COMPOSER_DISABLED"] === "true";

  const integrations: ComposerStatus["integrations"] = {
    codexReview: Boolean(config?.codexReview?.enabled),
    codexLifecycle: Boolean(config?.codexLifecycle?.enabled),
    oraclePlanner: Boolean(config?.roles?.oraclePlanner),
    gitHookInstalled: detectGitHook(root),
    composerDisabled,
  };

  const mode = deriveMode(config);

  const active: ComposerStatus["active"] = {};
  try {
    const oj = readLatestOracleJob(root);
    if (oj) {
      active.oracleJob = {
        jobId: oj.jobId,
        status: oj.status,
        mode: oj.mode,
        ageSeconds: ageSeconds(oj.startedAt ?? oj.createdAt, nowMs),
      };
    }
  } catch {
    // ignore
  }
  try {
    const cj = readLatestCodexLifecycleJob(root);
    if (cj) {
      active.codexJob = {
        jobId: cj.jobId,
        status: cj.status,
        event: cj.event,
        ageSeconds: ageSeconds(cj.startedAt ?? cj.createdAt, nowMs),
      };
    }
  } catch {
    // ignore
  }

  const latest: ComposerStatus["latest"] = {};
  try {
    const ev = readAuditEvents(root, { limit: 1 })[0];
    if (ev) {
      latest.route = ev.route;
      latest.taskClass = ev.taskClass;
      latest.tool = ev.tool;
      latest.reviewVerdict = ev.reviewVerdict;
      latest.testsPassed = ev.testsPassed;
      latest.auditStatus = ev.status;
    }
  } catch {
    // ignore
  }

  const recommendation = recommend({ exists, integrations, active });

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
    latest,
    recommendation,
  };
}

export function renderStatusLine(s: ComposerStatus): string {
  const mode = s.config.mode ?? (s.config.exists ? "custom" : "no-config");
  const R = s.integrations.codexReview ? "on" : "off";
  const L = s.integrations.codexLifecycle ? "on" : "off";
  const oJob = s.active.oracleJob;
  let O: string;
  if (oJob && (oJob.status === "running" || oJob.status === "queued")) {
    O = `busy ${Math.round(oJob.ageSeconds / 60)}m`;
  } else if (s.integrations.oraclePlanner) {
    O = "idle";
  } else {
    O = "off";
  }
  const H = s.integrations.gitHookInstalled ? "on" : "off";

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

  const disabledPart = s.integrations.composerDisabled ? "DISABLED · " : "";
  return `CMP ${mode} · R:${R} · L:${L} · O:${O} · H:${H} · ${disabledPart}last:${last}`;
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
  lines.push(`  git pre-commit:   ${s.integrations.gitHookInstalled ? "installed" : "not installed"}`);
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

export function runStatus(
  cwd: string,
  opts: { json?: boolean; line?: boolean; watch?: boolean } = {},
): void {
  if (opts.watch) {
    process.stdout.write(renderStatusLine(buildStatus(cwd)) + "\n");
    setInterval(() => {
      process.stdout.write(renderStatusLine(buildStatus(cwd)) + "\n");
    }, 2000);
    return;
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(buildStatus(cwd), null, 2) + "\n");
    return;
  }
  if (opts.line) {
    process.stdout.write(renderStatusLine(buildStatus(cwd)) + "\n");
    return;
  }
  process.stdout.write(renderStatusHuman(buildStatus(cwd)));
}
