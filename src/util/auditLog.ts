import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { COMPOSER_STATE_DIR_ENV } from "./codexLifecycleJob.js";

export const AuditEventSchema = z.object({
  ts: z.string(),
  kind: z.enum(["route-decision", "tool-call", "review", "test", "outcome", "note"]),
  runId: z.string().optional(),
  objective: z.string().max(500).optional(),
  taskClass: z.string().max(120).optional(),
  route: z.string().max(120).optional(),
  tool: z.string().max(120).optional(),
  provider: z.string().max(120).optional(),
  expectedOutputTokens: z.number().int().nonnegative().optional(),
  changedFiles: z.number().int().nonnegative().optional(),
  diffLines: z.number().int().nonnegative().optional(),
  reviewVerdict: z.string().max(120).optional(),
  testsPassed: z.boolean().optional(),
  userCorrection: z.boolean().optional(),
  status: z.enum(["succeeded", "failed", "partial"]).optional(),
  note: z.string().max(2000).optional(),
}).strict();

export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type AuditEventInput = Omit<AuditEvent, "ts">;

function capStr(v: string | undefined, max: number): string | undefined {
  if (v === undefined) return undefined;
  return v.length > max ? v.slice(0, max) : v;
}

export function appendAuditEvent(root: string, input: AuditEventInput): AuditEvent {
  const capped: AuditEventInput = {
    ...input,
    objective: capStr(input.objective, 500),
    note: capStr(input.note, 2000),
    route: capStr(input.route, 120),
    tool: capStr(input.tool, 120),
    provider: capStr(input.provider, 120),
    taskClass: capStr(input.taskClass, 120),
    reviewVerdict: capStr(input.reviewVerdict, 120),
  };
  const event = AuditEventSchema.parse({
    ts: new Date().toISOString(),
    ...capped,
  });
  ensureAuditDir(root);
  appendFileSync(auditLogPath(root), `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600, flag: "a" });
  return event;
}

export function readAuditEvents(root: string, opts?: { limit?: number; runId?: string }): AuditEvent[] {
  const filePath = auditLogPath(root);
  if (!existsSync(filePath)) return [];

  const events = readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [AuditEventSchema.parse(JSON.parse(line))];
      } catch {
        return [];
      }
    })
    .filter((event) => opts?.runId === undefined || event.runId === opts.runId);

  const limit = opts?.limit ?? 100;
  if (limit <= 0) return [];
  return events.slice(-limit);
}

export function readRecentAuditEvents(root: string, limit: number): AuditEvent[] {
  if (limit <= 0) return [];
  const filePath = auditLogPath(root);
  if (!existsSync(filePath)) return [];

  const maxBufferBytes = 1024 * 1024;
  const chunkSize = 64 * 1024;
  let fd: number | undefined;
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return [];
    if (stat.size <= chunkSize) {
      return readAuditEvents(root, { limit });
    }

    fd = openSync(filePath, "r");
    let offset = stat.size;
    let raw = "";
    let parsed: AuditEvent[] = [];
    while (offset > 0 && Buffer.byteLength(raw, "utf8") < maxBufferBytes) {
      const readLength = Math.min(chunkSize, offset);
      offset -= readLength;
      const buffer = Buffer.allocUnsafe(readLength);
      readSync(fd, buffer, 0, readLength, offset);
      raw = `${buffer.toString("utf8")}${raw}`;
      parsed = parseAuditTail(raw, limit);
      if (parsed.length >= limit) return parsed.slice(-limit);
    }
    if (offset > 0 && parsed.length < limit) {
      return readAuditEvents(root, { limit });
    }
    return parsed.slice(-limit);
  } catch {
    return readAuditEvents(root, { limit });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function readAuditFailures(root: string, opts?: { limit?: number }): AuditEvent[] {
  const failures = readAuditEvents(root, { limit: Number.MAX_SAFE_INTEGER })
    .filter((event) => event.status === "failed" || event.userCorrection === true);
  const limit = opts?.limit ?? 100;
  if (limit <= 0) return [];
  return failures.slice(-limit);
}

export interface AuditSummary {
  total: number;
  byKind: Record<string, number>;
  byStatus: Record<string, number>;
  byRoute: Record<string, number>;
  reviewVerdicts: Record<string, number>;
  tests: { passed: number; failed: number };
  userCorrections: number;
  recentFailures: AuditEvent[];
}

export function summarizeAudit(events: AuditEvent[]): AuditSummary {
  const summary: AuditSummary = {
    total: events.length,
    byKind: {}, byStatus: {}, byRoute: {}, reviewVerdicts: {},
    tests: { passed: 0, failed: 0 },
    userCorrections: 0,
    recentFailures: [],
  };
  for (const e of events) {
    summary.byKind[e.kind] = (summary.byKind[e.kind] ?? 0) + 1;
    if (e.status) summary.byStatus[e.status] = (summary.byStatus[e.status] ?? 0) + 1;
    if (e.route) summary.byRoute[e.route] = (summary.byRoute[e.route] ?? 0) + 1;
    if (e.reviewVerdict) summary.reviewVerdicts[e.reviewVerdict] = (summary.reviewVerdicts[e.reviewVerdict] ?? 0) + 1;
    if (e.testsPassed === true) summary.tests.passed += 1;
    if (e.testsPassed === false) summary.tests.failed += 1;
    if (e.userCorrection === true) summary.userCorrections += 1;
  }
  summary.recentFailures = events
    .filter((e) => e.status === "failed" || e.userCorrection === true)
    .slice(-5);
  return summary;
}

export function renderAuditMarkdown(events: AuditEvent[]): string {
  if (events.length === 0) return "# Composer Audit Trail\n\n_No audit events._\n";

  const groups = new Map<string, AuditEvent[]>();
  for (const event of events) {
    const runId = event.runId ?? "(no run)";
    groups.set(runId, [...(groups.get(runId) ?? []), event]);
  }

  const lines = ["# Composer Audit Trail", ""];
  for (const [runId, runEvents] of groups) {
    lines.push(`## ${runId}`);
    for (const event of runEvents) {
      const fields = [
        ["ts", event.ts],
        ["objective", event.objective],
        ["taskClass", event.taskClass],
        ["route", event.route],
        ["tool", event.tool],
        ["provider", event.provider],
        ["expectedOutputTokens", event.expectedOutputTokens],
        ["changedFiles", event.changedFiles],
        ["diffLines", event.diffLines],
        ["reviewVerdict", event.reviewVerdict],
        ["testsPassed", event.testsPassed],
        ["userCorrection", event.userCorrection],
        ["status", event.status],
        ["note", event.note],
      ]
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join("; ");
      lines.push(`- ${event.kind}${fields ? `: ${fields}` : ""}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function auditStateRoot(): string {
  const override = process.env[COMPOSER_STATE_DIR_ENV]?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".local", "state", "composer");
}

function auditLogPath(root: string): string {
  return path.join(auditStateRoot(), "audit", `${projectStateKey(realpathSync(root))}.jsonl`);
}

function parseAuditTail(raw: string, limit: number): AuditEvent[] {
  const lines = raw
    .split("\n")
    .filter((line, index, array) => {
      if (index === 0 && !raw.startsWith("{")) return false;
      if (index === array.length - 1 && line.trim().length === 0) return false;
      return line.trim().length > 0;
    });
  const events: AuditEvent[] = [];
  for (let i = lines.length - 1; i >= 0 && events.length < limit; i -= 1) {
    try {
      events.push(AuditEventSchema.parse(JSON.parse(lines[i]!)));
    } catch {
      continue;
    }
  }
  return events.reverse();
}

function ensureAuditDir(root: string): void {
  const stateRoot = auditStateRoot();
  const auditDir = path.join(stateRoot, "audit");
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  mkdirSync(auditDir, { recursive: true, mode: 0o700 });
  if (lstatSync(auditDir).isSymbolicLink()) {
    throw new Error("Composer audit directory must not be a symlink");
  }
  projectStateKey(realpathSync(root));
}

function projectStateKey(rootReal: string): string {
  const basename = path.basename(rootReal).replace(/[^A-Za-z0-9._-]+/g, "-") || "project";
  const slug = basename.slice(0, 48);
  const digest = createHash("sha256").update(rootReal).digest("hex").slice(0, 24);
  return `${slug}-${digest}`;
}
