import { randomUUID } from "node:crypto";
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

import { z } from "zod";

export const REVIEW_JOB_DIR = "review-jobs";
const LATEST_REVIEW_JOB_POINTER = ".latest";

export const ReviewJobStatusSchema = z.enum(["queued", "running", "succeeded", "failed"]);
export type ReviewJobStatus = z.infer<typeof ReviewJobStatusSchema>;

export const ReviewJobScopeSchema = z.enum(["staged", "unstaged", "working-tree", "branch"]);
export type ReviewJobScope = z.infer<typeof ReviewJobScopeSchema>;

export const ReviewJobSchema = z
  .object({
    jobId: z.string().uuid(),
    status: ReviewJobStatusSchema,
    scope: ReviewJobScopeSchema.optional(),
    base: z.string().optional(),
    reviewFiles: z.array(z.string()).optional(),
    promptPreview: z.string(),
    claude: z.boolean().optional(),
    result: z
      .object({
        verdict: z.string().optional(),
        summary: z.string().optional(),
        text: z.string().optional(),
      })
      .optional(),
    error: z.string().optional(),
    createdAt: z.string().datetime(),
    startedAt: z.string().datetime().optional(),
    completedAt: z.string().datetime().optional(),
  })
  .strict();

export type ReviewJob = z.infer<typeof ReviewJobSchema>;

export function newReviewJob(
  input: {
    scope?: ReviewJobScope;
    base?: string;
    reviewFiles?: string[];
    promptPreview: string;
    claude?: boolean;
  },
): ReviewJob {
  return ReviewJobSchema.parse({
    jobId: randomUUID(),
    status: "queued",
    scope: input.scope,
    base: input.base,
    reviewFiles: input.reviewFiles,
    promptPreview: input.promptPreview,
    claude: input.claude,
    createdAt: new Date().toISOString(),
  });
}

export function writeReviewJob(root: string, job: ReviewJob): ReviewJob {
  const next = ReviewJobSchema.parse(job);
  const dir = ensureReviewJobDir(root);
  const resultPath = path.join(dir, `${next.jobId}.json`);
  writeFileAtomically(resultPath, `${JSON.stringify(next, null, 2)}\n`);
  writeFileAtomically(path.join(dir, LATEST_REVIEW_JOB_POINTER), `${next.jobId}\n`);
  return next;
}

export function updateReviewJob(
  root: string,
  job: ReviewJob,
  patch: Partial<Omit<ReviewJob, "jobId" | "createdAt">>,
): ReviewJob {
  return writeReviewJob(
    root,
    ReviewJobSchema.parse({
      ...job,
      ...patch,
    }),
  );
}

export function readReviewJob(root: string, jobId: string): ReviewJob | null {
  const parsed = z.string().uuid().safeParse(jobId);
  if (!parsed.success) return null;

  const dir = existingReviewJobDir(root);
  if (!dir) return null;
  const filePath = path.join(dir, `${parsed.data}.json`);
  try {
    if (!existsSync(filePath)) return null;
    if (lstatSync(filePath).isSymbolicLink()) return null;
    const raw = readFileSync(filePath, "utf8");
    return ReviewJobSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function readLatestReviewJob(root: string): ReviewJob | null {
  const dir = existingReviewJobDir(root);
  if (!dir) return null;

  const pointed = readLatestReviewJobPointer(root, dir);
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
      return ReviewJobSchema.parse(JSON.parse(raw));
    } catch {
      continue;
    }
  }
  return null;
}

function readLatestReviewJobPointer(root: string, dir: string): ReviewJob | null {
  const pointerPath = path.join(dir, LATEST_REVIEW_JOB_POINTER);
  try {
    if (!existsSync(pointerPath)) return null;
    if (lstatSync(pointerPath).isSymbolicLink()) return null;
    const jobId = readFileSync(pointerPath, "utf8").trim();
    const parsed = z.string().uuid().safeParse(jobId);
    if (!parsed.success) return null;
    const job = readReviewJob(root, parsed.data);
    if (!job || job.jobId !== parsed.data) return null;
    return job;
  } catch {
    return null;
  }
}

function reviewJobDir(root: string): string {
  return path.join(realpathSync(root), ".composer", REVIEW_JOB_DIR);
}

function ensureReviewJobDir(root: string): string {
  const composerDir = path.join(realpathSync(root), ".composer");
  const dir = path.join(composerDir, REVIEW_JOB_DIR);
  ensureDirectory(composerDir, "Composer project state");
  ensureDirectory(dir, "Review job state");
  return realpathSync(dir);
}

function existingReviewJobDir(root: string): string | null {
  if (!existsSync(reviewJobDir(root))) return null;
  try {
    const dir = reviewJobDir(root);
    assertUsableDirectory(dir, "Review job state");
    return realpathSync(dir);
  } catch {
    return null;
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
    throw new Error(`Review job directory must not be a symlink: ${label}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Review job path must be a directory: ${label}`);
  }
}

function writeFileAtomically(filePath: string, content: string): void {
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
