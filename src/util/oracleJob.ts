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
import os from "node:os";
import path from "node:path";

import { z } from "zod";

import { COMPOSER_STATE_DIR_ENV } from "./codexLifecycleJob.js";

export const ORACLE_JOB_DIR = "oracle-jobs";
export const ORACLE_JOB_VERSION = 1;
const LATEST_ORACLE_JOB_POINTER = ".latest";

export const OracleJobModeSchema = z.enum([
  "auto",
  "quick",
  "standard",
  "deep",
  "plan",
  "review",
  "debug",
  "research",
]);
export type OracleJobMode = z.infer<typeof OracleJobModeSchema>;

export const OracleJobStatusSchema = z.enum(["queued", "running", "succeeded", "failed"]);
export type OracleJobStatus = z.infer<typeof OracleJobStatusSchema>;

export const OracleJobSchema = z
  .object({
    version: z.literal(ORACLE_JOB_VERSION),
    jobId: z.string().uuid(),
    mode: OracleJobModeSchema,
    status: OracleJobStatusSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    resultPath: z.string().min(1),
    pid: z.number().int().optional(),
    promptPreview: z.string().optional(),
    handoffPath: z.string().min(1).optional(),
    startedAt: z.string().datetime().optional(),
    completedAt: z.string().datetime().optional(),
    answerText: z.string().optional(),
    answerPath: z.string().optional(),
    oracleSlug: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();

export type OracleJob = z.infer<typeof OracleJobSchema>;

export function newOracleJob(
  root: string,
  input: { mode: OracleJobMode; promptPreview?: string; handoffPath?: string },
): OracleJob {
  const now = new Date().toISOString();
  const jobId = randomUUID();
  return OracleJobSchema.parse({
    version: ORACLE_JOB_VERSION,
    jobId,
    mode: input.mode,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    resultPath: oracleJobPath(root, jobId),
    pid: process.pid,
    promptPreview: input.promptPreview,
    handoffPath: input.handoffPath,
  });
}

export function writeOracleJob(root: string, job: OracleJob): OracleJob {
  const validated = OracleJobSchema.parse({
    ...job,
    resultPath: oracleJobPath(root, job.jobId),
  });
  const dir = ensureOracleJobDir(root);
  const resultPath = path.join(dir, `${job.jobId}.json`);
  const next = OracleJobSchema.parse({
    ...validated,
    resultPath,
  });
  writeJobFileAtomically(resultPath, `${JSON.stringify(next, null, 2)}\n`);
  writePointerFileAtomically(path.join(dir, LATEST_ORACLE_JOB_POINTER), `${next.jobId}\n`);
  return next;
}

export function updateOracleJob(
  root: string,
  job: OracleJob,
  patch: Partial<Omit<OracleJob, "version" | "jobId" | "createdAt" | "resultPath">>,
): OracleJob {
  return writeOracleJob(
    root,
    OracleJobSchema.parse({
      ...job,
      ...patch,
      updatedAt: new Date().toISOString(),
    }),
  );
}

export function readOracleJob(root: string, jobId: string): OracleJob | null {
  const parsed = z.string().uuid().safeParse(jobId);
  if (!parsed.success) return null;

  const dir = existingOracleJobDir(root);
  if (!dir) return null;
  const filePath = path.join(dir, `${parsed.data}.json`);
  if (!existsSync(filePath)) return null;
  if (lstatSync(filePath).isSymbolicLink()) return null;
  const raw = readFileSync(filePath, "utf8");
  const parsedJob = OracleJobSchema.parse(JSON.parse(raw));
  return reconcileOracleJob(root, parsedJob);
}

export function readLatestOracleJob(root: string): OracleJob | null {
  const dir = existingOracleJobDir(root);
  if (!dir) return null;

  const pointed = readLatestOracleJobPointer(root, dir);
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
      const job = OracleJobSchema.parse(JSON.parse(raw));
      return reconcileOracleJob(root, job);
    } catch {
      continue;
    }
  }
  return null;
}

export function failInFlightOracleJobs(root: string, error: string): number {
  const dir = existingOracleJobDir(root);
  if (!dir) return 0;
  let failed = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const filePath = path.join(dir, name);
    try {
      if (lstatSync(filePath).isSymbolicLink() || !statSync(filePath).isFile()) continue;
      const job = OracleJobSchema.parse(JSON.parse(readFileSync(filePath, "utf8")));
      if (job.status !== "queued" && job.status !== "running") continue;
      if (typeof job.pid === "number" && job.pid !== process.pid) continue;
      const next = OracleJobSchema.parse({
        ...job,
        status: "failed",
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        error,
      });
      writeJobFileAtomically(filePath, `${JSON.stringify(next, null, 2)}\n`);
      failed++;
    } catch {
      continue;
    }
  }
  return failed;
}

function readLatestOracleJobPointer(root: string, dir: string): OracleJob | null {
  const pointerPath = path.join(dir, LATEST_ORACLE_JOB_POINTER);
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
    const job = OracleJobSchema.parse(JSON.parse(raw));
    if (job.jobId !== parsed.data || path.resolve(job.resultPath) !== path.resolve(filePath)) {
      return null;
    }
    return reconcileOracleJob(root, job);
  } catch {
    return null;
  }
}

export function reconcileOracleJob(root: string, job: OracleJob): OracleJob {
  const nonTerminal = job.status === "queued" || job.status === "running";
  if (
    nonTerminal &&
    typeof job.pid === "number" &&
    job.pid !== process.pid &&
    !isProcessAlive(job.pid)
  ) {
    return updateOracleJob(root, job, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error:
        `Oracle job orphaned: the server process (pid ${job.pid}) that started it is no longer running ` +
        `(likely a restart). Re-run the request. Any completed answer is under .composer/oracle/answers/.`,
    });
  }
  return job;
}

export function oracleJobPath(root: string, jobId: string): string {
  return path.resolve(oracleJobDir(root), `${jobId}.json`);
}

function oracleJobDir(root: string): string {
  const rootReal = realpathSync(root);
  return path.join(oracleStateRoot(), ORACLE_JOB_DIR, projectStateKey(rootReal));
}

function ensureOracleJobDir(root: string): string {
  const rootReal = realpathSync(root);
  const stateRoot = oracleStateRoot();
  const oracleRoot = path.join(stateRoot, ORACLE_JOB_DIR);
  const dir = path.join(oracleRoot, projectStateKey(rootReal));
  ensureDirectory(stateRoot, "Composer state root");
  ensureDirectory(oracleRoot, "Oracle job state root");
  ensureDirectory(dir, "Oracle job project state");
  return realpathSync(dir);
}

function existingOracleJobDir(root: string): string | null {
  if (!existsSync(oracleJobDir(root))) return null;
  try {
    const dir = oracleJobDir(root);
    assertUsableDirectory(dir, "Oracle job project state");
    return realpathSync(dir);
  } catch {
    return null;
  }
}

function oracleStateRoot(): string {
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
    throw new Error(`Oracle job directory must not be a symlink: ${label}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Oracle job path must be a directory: ${label}`);
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
