import { dirname, join } from "node:path";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  newReviewJob,
  readLatestReviewJob,
  readReviewJob,
  updateReviewJob,
  writeReviewJob,
} from "../../src/util/reviewJob.js";

describe("review job files", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function tempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "composer-review-job-"));
    roots.push(root);
    return root;
  }

  it("round-trips queued jobs", () => {
    const root = tempRoot();
    const job = newReviewJob({
      scope: "staged",
      base: "main",
      reviewFiles: ["src/a.ts"],
      promptPreview: "review this diff",
      claude: true,
    });
    writeReviewJob(root, job);

    const read = readReviewJob(root, job.jobId);

    expect(read).toMatchObject({
      jobId: job.jobId,
      status: "queued",
      scope: "staged",
      base: "main",
      reviewFiles: ["src/a.ts"],
      promptPreview: "review this diff",
      claude: true,
    });
  });

  it("persists job files with owner-only permissions", () => {
    const root = tempRoot();
    const job = writeReviewJob(root, newReviewJob({ promptPreview: "review" }));
    const filePath = join(root, ".composer", "review-jobs", `${job.jobId}.json`);

    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("round-trips completed result metadata", () => {
    const root = tempRoot();
    const job = writeReviewJob(root, newReviewJob({ promptPreview: "review" }));
    const updated = updateReviewJob(root, job, {
      status: "succeeded",
      completedAt: new Date().toISOString(),
      result: {
        verdict: "PASS",
        summary: "No blocking findings.",
        text: "VERDICT: PASS\nSUMMARY: No blocking findings.",
      },
    });

    const read = readReviewJob(root, updated.jobId);

    expect(read?.result?.verdict).toBe("PASS");
    expect(read?.result?.summary).toBe("No blocking findings.");
    expect(read?.result?.text).toContain("VERDICT: PASS");
  });

  it("readLatestReviewJob uses a valid latest pointer", () => {
    const root = tempRoot();
    const first = writeReviewJob(root, newReviewJob({ promptPreview: "first" }));
    const second = writeReviewJob(root, newReviewJob({ promptPreview: "second" }));

    expect(readLatestReviewJob(root)?.jobId).toBe(second.jobId);
    expect(readLatestReviewJob(root)?.jobId).not.toBe(first.jobId);
  });

  it("readLatestReviewJob falls back to scan when the pointer target is deleted", () => {
    const root = tempRoot();
    const first = writeReviewJob(root, newReviewJob({ promptPreview: "first" }));
    const second = writeReviewJob(root, newReviewJob({ promptPreview: "second" }));
    const firstPath = join(root, ".composer", "review-jobs", `${first.jobId}.json`);
    const secondPath = join(root, ".composer", "review-jobs", `${second.jobId}.json`);
    const newer = new Date(Date.now() + 10_000);
    utimesSync(firstPath, newer, newer);
    unlinkSync(secondPath);

    expect(readLatestReviewJob(root)?.jobId).toBe(first.jobId);
  });

  it("readLatestReviewJob falls back to scan when the pointer is corrupt", () => {
    const root = tempRoot();
    const first = writeReviewJob(root, newReviewJob({ promptPreview: "first" }));
    const second = writeReviewJob(root, newReviewJob({ promptPreview: "second" }));
    const secondPath = join(root, ".composer", "review-jobs", `${second.jobId}.json`);
    const newer = new Date(Date.now() + 10_000);
    utimesSync(secondPath, newer, newer);
    writeFileSync(join(dirname(secondPath), ".latest"), "not-a-job-id\n", "utf8");

    expect(readLatestReviewJob(root)?.jobId).toBe(second.jobId);
    expect(readLatestReviewJob(root)?.jobId).not.toBe(first.jobId);
  });

  it("skips corrupt job files during latest fallback", () => {
    const root = tempRoot();
    const valid = writeReviewJob(root, newReviewJob({ promptPreview: "valid" }));
    const validPath = join(root, ".composer", "review-jobs", `${valid.jobId}.json`);
    const corruptPath = join(root, ".composer", "review-jobs", "00000000-0000-4000-8000-000000000000.json");
    writeFileSync(corruptPath, "{not-json", "utf8");
    const newer = new Date(Date.now() + 10_000);
    utimesSync(corruptPath, newer, newer);
    writeFileSync(join(dirname(validPath), ".latest"), "not-a-job-id\n", "utf8");

    expect(readLatestReviewJob(root)?.jobId).toBe(valid.jobId);
    expect(readFileSync(validPath, "utf8")).toContain(valid.jobId);
  });
});
