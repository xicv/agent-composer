import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";

import { z } from "zod";

import {
  CodexLifecycleEventSchema,
  CodexLifecycleExecutionSchema,
  type CodexLifecycleEvent,
  RoleNameSchema,
} from "../config/schema.js";
import type { CodexLifecycleDecision } from "./codexLifecycle.js";

export const CODEX_LIFECYCLE_JOB_DIR = "codex-lifecycle";
export const CODEX_LIFECYCLE_JOB_VERSION = 1;
export const COMPOSER_STATE_DIR_ENV = "COMPOSER_STATE_DIR";
const LATEST_CODEX_LIFECYCLE_JOB_POINTER = ".latest";

export const CodexLifecycleJobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "unavailable",
]);
export type CodexLifecycleJobStatus = z.infer<typeof CodexLifecycleJobStatusSchema>;

export const CodexLifecycleUnavailableReasonSchema = z.enum([
  "auth",
  "quota",
  "rate_limit",
  "timeout",
  "cancelled",
  "provider",
  "unknown",
]);
export type CodexLifecycleUnavailableReason = z.infer<
  typeof CodexLifecycleUnavailableReasonSchema
>;

export const CodexLifecycleProviderAttemptSchema = z
  .object({
    role: RoleNameSchema,
    status: z.enum(["succeeded", "unavailable"]),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    unavailableReason: CodexLifecycleUnavailableReasonSchema.optional(),
    error: z.string().optional(),
  })
  .strict();
export type CodexLifecycleProviderAttempt = z.infer<
  typeof CodexLifecycleProviderAttemptSchema
>;

export const CodexLifecycleDecisionSnapshotSchema = z
  .object({
    event: CodexLifecycleEventSchema,
    action: z.enum(["skip", "ask", "run"]),
    score: z.number(),
    threshold: z.number(),
    model: z.string().min(1),
    execution: CodexLifecycleExecutionSchema,
    reasons: z.array(z.string()),
  })
  .strict();

export const CodexLifecycleJobSchema = z
  .object({
    version: z.literal(CODEX_LIFECYCLE_JOB_VERSION),
    jobId: z.string().uuid(),
    event: CodexLifecycleEventSchema,
    status: CodexLifecycleJobStatusSchema,
    action: z.enum(["skip", "ask", "run"]),
    execution: CodexLifecycleExecutionSchema,
    model: z.string().min(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    resultPath: z.string().min(1),
    pid: z.number().int().optional(),
    handoffPath: z.string().min(1).optional(),
    objective: z.string().min(1).optional(),
    startedAt: z.string().datetime().optional(),
    completedAt: z.string().datetime().optional(),
    resultText: z.string().optional(),
    error: z.string().optional(),
    unavailableReason: CodexLifecycleUnavailableReasonSchema.optional(),
    providerRole: RoleNameSchema.optional(),
    fallbackUsed: RoleNameSchema.optional(),
    attempts: z.array(CodexLifecycleProviderAttemptSchema).default([]),
    decision: CodexLifecycleDecisionSnapshotSchema,
  })
  .strict();

export type CodexLifecycleJob = z.infer<typeof CodexLifecycleJobSchema>;

export interface NewCodexLifecycleJobInput {
  event: CodexLifecycleEvent;
  decision: CodexLifecycleDecision;
  execution: "foreground" | "background";
  handoffPath?: string;
  objective?: string;
}

export function newCodexLifecycleJob(
  root: string,
  input: NewCodexLifecycleJobInput,
): CodexLifecycleJob {
  const now = new Date().toISOString();
  const jobId = randomUUID();
  return CodexLifecycleJobSchema.parse({
    version: CODEX_LIFECYCLE_JOB_VERSION,
    jobId,
    event: input.event,
    status: "queued",
    action: input.decision.action,
    execution: input.execution,
    model: input.decision.model,
    createdAt: now,
    updatedAt: now,
    resultPath: codexLifecycleJobPath(root, jobId),
    pid: process.pid,
    handoffPath: input.handoffPath,
    objective: input.objective,
    attempts: [],
    decision: {
      ...input.decision,
      execution: input.execution,
    },
  });
}

export function writeCodexLifecycleJob(
  root: string,
  job: CodexLifecycleJob,
): CodexLifecycleJob {
  const validated = CodexLifecycleJobSchema.parse({
    ...job,
    resultPath: codexLifecycleJobPath(root, job.jobId),
  });
  const dir = ensureCodexLifecycleJobDir(root);
  const resultPath = path.join(dir, `${job.jobId}.json`);
  const next = CodexLifecycleJobSchema.parse({
    ...validated,
    resultPath,
  });
  writeJobFileAtomically(resultPath, `${JSON.stringify(next, null, 2)}\n`);
  writePointerFileAtomically(path.join(dir, LATEST_CODEX_LIFECYCLE_JOB_POINTER), `${next.jobId}\n`);
  return next;
}

export function updateCodexLifecycleJob(
  root: string,
  job: CodexLifecycleJob,
  patch: Partial<Omit<CodexLifecycleJob, "version" | "jobId" | "createdAt" | "resultPath">>,
): CodexLifecycleJob {
  return writeCodexLifecycleJob(
    root,
    CodexLifecycleJobSchema.parse({
      ...job,
      ...patch,
      updatedAt: new Date().toISOString(),
    }),
  );
}

export function readCodexLifecycleJob(root: string, jobId: string): CodexLifecycleJob | null {
  const parsed = z.string().uuid().safeParse(jobId);
  if (!parsed.success) return null;

  const dir = existingCodexLifecycleJobDir(root);
  if (!dir) return null;
  const filePath = path.join(dir, `${parsed.data}.json`);
  if (!existsSync(filePath)) return null;
  if (lstatSync(filePath).isSymbolicLink()) return null;
  const raw = readFileSync(filePath, "utf8");
  const parsedJob = CodexLifecycleJobSchema.parse(JSON.parse(raw));
  return reconcileCodexLifecycleJob(root, parsedJob);
}

export function readLatestCodexLifecycleJob(root: string): CodexLifecycleJob | null {
  const dir = existingCodexLifecycleJobDir(root);
  if (!dir) return null;

  const pointed = readLatestCodexLifecycleJobPointer(root, dir);
  if (pointed) return pointed;

  const candidates = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(dir, name))
    .filter((filePath) => {
      try {
        return !lstatSync(filePath).isSymbolicLink() && statSync(filePath).isFile();
      } catch {
        return false;
      }
    })
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

  for (const filePath of candidates) {
    try {
      const raw = readFileSync(filePath, "utf8");
      const job = CodexLifecycleJobSchema.parse(JSON.parse(raw));
      return reconcileCodexLifecycleJob(root, job);
    } catch {
      continue;
    }
  }
  return null;
}

function readLatestCodexLifecycleJobPointer(root: string, dir: string): CodexLifecycleJob | null {
  const pointerPath = path.join(dir, LATEST_CODEX_LIFECYCLE_JOB_POINTER);
  try {
    if (!existsSync(pointerPath)) return null;
    if (lstatSync(pointerPath).isSymbolicLink()) return null;
    const jobId = readFileSync(pointerPath, "utf8").trim();
    const parsed = z.string().uuid().safeParse(jobId);
    if (!parsed.success) return null;
    const filePath = path.join(dir, `${parsed.data}.json`);
    if (!existsSync(filePath)) return null;
    if (lstatSync(filePath).isSymbolicLink()) return null;
    if (!statSync(filePath).isFile()) return null;
    const raw = readFileSync(filePath, "utf8");
    const job = CodexLifecycleJobSchema.parse(JSON.parse(raw));
    if (job.jobId !== parsed.data || path.resolve(job.resultPath) !== path.resolve(filePath)) {
      return null;
    }
    return reconcileCodexLifecycleJob(root, job);
  } catch {
    return null;
  }
}

export function reconcileCodexLifecycleJob(
  root: string,
  job: CodexLifecycleJob,
): CodexLifecycleJob {
  const nonTerminal = job.status === "queued" || job.status === "running";
  if (
    nonTerminal &&
    typeof job.pid === "number" &&
    job.pid !== process.pid &&
    !isProcessAlive(job.pid)
  ) {
    return updateCodexLifecycleJob(root, job, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: `Codex lifecycle job orphaned: the server process (pid ${job.pid}) that started it is no longer running (likely a restart).`,
    });
  }
  return job;
}

export function codexLifecycleJobPath(root: string, jobId: string): string {
  return path.resolve(codexLifecycleJobDir(root), `${jobId}.json`);
}

export function classifyCodexLifecycleUnavailable(
  error: unknown,
): CodexLifecycleUnavailableReason {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  if (/\b(abort|aborted|cancelled|canceled)\b/.test(normalized)) {
    return "cancelled";
  }
  if (/\b(timed out|timeout|etimedout)\b/.test(normalized)) {
    return "timeout";
  }
  if (
    /\b(auth|authenticated|authentication|credential|credentials|login|logged in|unauthori[sz]ed|forbidden|access token|api key|401|403)\b/.test(
      normalized,
    )
  ) {
    return "auth";
  }
  if (
    /\b(quota|insufficient_quota|usage limit|credit|billing|out of tokens|token budget|token limit|tokens exhausted|limit reached|monthly limit)\b/.test(
      normalized,
    )
  ) {
    return "quota";
  }
  if (
    /\b(rate limit|rate-limit|too many requests|temporarily unavailable|overloaded|overloaded_error|econnreset|ecconnreset|econnrefused|enotfound|fetch failed|socket hang up|connection error|529|503|429)\b/.test(
      normalized,
    )
  ) {
    return "rate_limit";
  }
  if (/\b(provider|codex|cli)\b/.test(normalized)) {
    return "provider";
  }
  return "unknown";
}

function codexLifecycleJobDir(root: string): string {
  const rootReal = realpathSync(root);
  return path.join(codexLifecycleStateRoot(), CODEX_LIFECYCLE_JOB_DIR, projectStateKey(rootReal));
}

function ensureCodexLifecycleJobDir(root: string): string {
  const rootReal = realpathSync(root);
  const stateRoot = codexLifecycleStateRoot();
  const lifecycleRoot = path.join(stateRoot, CODEX_LIFECYCLE_JOB_DIR);
  const dir = path.join(lifecycleRoot, projectStateKey(rootReal));
  ensureDirectory(stateRoot, "Composer state root");
  ensureDirectory(lifecycleRoot, "Codex lifecycle state root");
  ensureDirectory(dir, "Codex lifecycle project state");
  return realpathSync(dir);
}

function existingCodexLifecycleJobDir(root: string): string | null {
  if (!existsSync(codexLifecycleJobDir(root))) return null;
  try {
    const dir = codexLifecycleJobDir(root);
    assertUsableDirectory(dir, "Codex lifecycle project state");
    return realpathSync(dir);
  } catch {
    return null;
  }
}

function codexLifecycleStateRoot(): string {
  const override = process.env[COMPOSER_STATE_DIR_ENV]?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".local", "state", "composer");
}

function projectStateKey(rootReal: string): string {
  const basename = path.basename(rootReal).replace(/[^A-Za-z0-9._-]+/g, "-") || "project";
  const slug = basename.slice(0, 48);
  const digest = createHash("sha256").update(rootReal).digest("hex").slice(0, 24);
  return `${slug}-${digest}`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = process exists but not signalable by us -> alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function ensureDirectory(dir: string, label: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  assertUsableDirectory(dir, label);
}

function assertUsableDirectory(dir: string, label: string): void {
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink()) {
    throw new Error(`Codex lifecycle job directory must not be a symlink: ${label}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Codex lifecycle job path must be a directory: ${label}`);
  }
}

function writeJobFileAtomically(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(tmp, filePath);
    chmodSync(filePath, 0o600);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

function writePointerFileAtomically(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(tmp, filePath);
    chmodSync(filePath, 0o600);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}
