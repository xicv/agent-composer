import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { COMPOSER_STATE_DIR_ENV } from "./codexLifecycleJob.js";

export const AuditEventSchema = z.object({
  ts: z.string(),
  kind: z.enum(["route-decision", "tool-call", "review", "test", "outcome", "note"]),
  runId: z.string().optional(),
  objective: z.string().optional(),
  taskClass: z.string().optional(),
  route: z.string().optional(),
  tool: z.string().optional(),
  provider: z.string().optional(),
  expectedOutputTokens: z.number().int().nonnegative().optional(),
  changedFiles: z.number().int().nonnegative().optional(),
  diffLines: z.number().int().nonnegative().optional(),
  reviewVerdict: z.string().optional(),
  testsPassed: z.boolean().optional(),
  userCorrection: z.boolean().optional(),
  status: z.enum(["succeeded", "failed", "partial"]).optional(),
  note: z.string().optional(),
}).strict();

export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type AuditEventInput = Omit<AuditEvent, "ts">;

export function appendAuditEvent(root: string, input: AuditEventInput): AuditEvent {
  const event = AuditEventSchema.parse({
    ts: new Date().toISOString(),
    ...input,
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

export function readAuditFailures(root: string, opts?: { limit?: number }): AuditEvent[] {
  const failures = readAuditEvents(root, { limit: Number.MAX_SAFE_INTEGER })
    .filter((event) => event.status === "failed" || event.userCorrection === true);
  const limit = opts?.limit ?? 100;
  if (limit <= 0) return [];
  return failures.slice(-limit);
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
