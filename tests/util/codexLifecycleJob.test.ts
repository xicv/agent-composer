import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";

import { describe, expect, it } from "vitest";

import type { CodexLifecycleDecision } from "../../src/util/codexLifecycle.js";
import {
  COMPOSER_STATE_DIR_ENV,
  classifyCodexLifecycleUnavailable,
  newCodexLifecycleJob,
  readLatestCodexLifecycleJob,
  readCodexLifecycleJob,
  writeCodexLifecycleJob,
} from "../../src/util/codexLifecycleJob.js";

const decision: CodexLifecycleDecision = {
  event: "postPlan",
  action: "run",
  score: 90,
  threshold: 60,
  model: "gpt-5.4-mini",
  execution: "background",
  reasons: ["test"],
};

describe("codex lifecycle job files", () => {
  it("stores resultPath in Composer state instead of the project worktree", () => {
    const root = mkdtempSync(join(tmpdir(), "composer-life-"));
    const state = mkdtempSync(join(tmpdir(), "composer-life-state-"));
    const previous = process.env[COMPOSER_STATE_DIR_ENV];
    process.env[COMPOSER_STATE_DIR_ENV] = state;
    try {
      const job = newCodexLifecycleJob(root, {
        event: "postPlan",
        decision,
        execution: "background",
      });
      const written = writeCodexLifecycleJob(root, {
        ...job,
        resultPath: "/tmp/unsafe.json",
      });

      expect(written.resultPath.startsWith(`${realpathSync(state)}${sep}`)).toBe(true);
      expect(written.resultPath.startsWith(`${realpathSync(root)}${sep}`)).toBe(false);
      expect(written.resultPath.endsWith(`${job.jobId}.json`)).toBe(true);
      expect(existsSync(written.resultPath)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env[COMPOSER_STATE_DIR_ENV];
      else process.env[COMPOSER_STATE_DIR_ENV] = previous;
      rmSync(root, { recursive: true, force: true });
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("persists lifecycle job files with owner-only permissions", () => {
    const root = mkdtempSync(join(tmpdir(), "composer-life-"));
    const state = mkdtempSync(join(tmpdir(), "composer-life-state-"));
    const previous = process.env[COMPOSER_STATE_DIR_ENV];
    process.env[COMPOSER_STATE_DIR_ENV] = state;
    try {
      const job = newCodexLifecycleJob(root, {
        event: "postPlan",
        decision,
        execution: "background",
      });
      const written = writeCodexLifecycleJob(root, job);

      expect(statSync(written.resultPath).mode & 0o777).toBe(0o600);
    } finally {
      if (previous === undefined) delete process.env[COMPOSER_STATE_DIR_ENV];
      else process.env[COMPOSER_STATE_DIR_ENV] = previous;
      rmSync(root, { recursive: true, force: true });
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("rejects symlinked lifecycle job state directories", () => {
    const root = mkdtempSync(join(tmpdir(), "composer-life-"));
    const state = mkdtempSync(join(tmpdir(), "composer-life-state-"));
    const outside = mkdtempSync(join(tmpdir(), "composer-life-outside-"));
    const previous = process.env[COMPOSER_STATE_DIR_ENV];
    process.env[COMPOSER_STATE_DIR_ENV] = state;
    try {
      const job = newCodexLifecycleJob(root, {
        event: "postPlan",
        decision,
        execution: "background",
      });
      const projectStateDir = dirname(job.resultPath);
      mkdirSync(dirname(projectStateDir), { recursive: true });
      symlinkSync(outside, projectStateDir);

      expect(() => writeCodexLifecycleJob(root, job)).toThrow(/must not be a symlink/);
    } finally {
      if (previous === undefined) delete process.env[COMPOSER_STATE_DIR_ENV];
      else process.env[COMPOSER_STATE_DIR_ENV] = previous;
      rmSync(root, { recursive: true, force: true });
      rmSync(state, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("classifies Codex auth, quota, rate-limit, and timeout failures", () => {
    expect(classifyCodexLifecycleUnavailable(new Error("not authenticated; please login"))).toBe(
      "auth",
    );
    expect(classifyCodexLifecycleUnavailable(new Error("usage limit reached"))).toBe(
      "quota",
    );
    expect(classifyCodexLifecycleUnavailable(new Error("429 rate limit exceeded"))).toBe(
      "rate_limit",
    );
    expect(classifyCodexLifecycleUnavailable(new Error("CLIProvider: codex timed out"))).toBe(
      "timeout",
    );
  });

  it("classifies Anthropic/GLM SDK error shapes", () => {
    expect(classifyCodexLifecycleUnavailable(new Error("Request timed out."))).toBe("timeout");
    expect(
      classifyCodexLifecycleUnavailable(
        Object.assign(new Error("Request was aborted."), { name: "AbortError" }),
      ),
    ).toBe("cancelled");
    expect(
      classifyCodexLifecycleUnavailable(new Error("529 overloaded_error: server is overloaded")),
    ).toBe("rate_limit");
    expect(classifyCodexLifecycleUnavailable(new Error("Connection error."))).toBe("rate_limit");
    expect(
      classifyCodexLifecycleUnavailable(new Error("getaddrinfo ENOTFOUND api.z.ai")),
    ).toBe("rate_limit");
    expect(
      classifyCodexLifecycleUnavailable(new Error("401 authentication_error: invalid x-api-key")),
    ).toBe("auth");
    expect(
      classifyCodexLifecycleUnavailable(
        new Error("insufficient_quota: billing hard limit reached"),
      ),
    ).toBe("quota");
  });

  it("round-trips queued jobs from the current process without reconciliation", () => {
    const root = mkdtempSync(join(tmpdir(), "composer-life-"));
    const state = mkdtempSync(join(tmpdir(), "composer-life-state-"));
    const previous = process.env[COMPOSER_STATE_DIR_ENV];
    process.env[COMPOSER_STATE_DIR_ENV] = state;
    try {
      const job = newCodexLifecycleJob(root, {
        event: "postPlan",
        decision,
        execution: "background",
      });
      writeCodexLifecycleJob(root, job);

      const read = readCodexLifecycleJob(root, job.jobId);

      expect(read?.status).toBe("queued");
      expect(read?.pid).toBe(process.pid);
    } finally {
      if (previous === undefined) delete process.env[COMPOSER_STATE_DIR_ENV];
      else process.env[COMPOSER_STATE_DIR_ENV] = previous;
      rmSync(root, { recursive: true, force: true });
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("readLatestCodexLifecycleJob uses a valid latest pointer", () => {
    const root = mkdtempSync(join(tmpdir(), "composer-life-"));
    const state = mkdtempSync(join(tmpdir(), "composer-life-state-"));
    const previous = process.env[COMPOSER_STATE_DIR_ENV];
    process.env[COMPOSER_STATE_DIR_ENV] = state;
    try {
      const first = writeCodexLifecycleJob(root, newCodexLifecycleJob(root, {
        event: "postPlan",
        decision,
        execution: "background",
      }));
      const second = writeCodexLifecycleJob(root, newCodexLifecycleJob(root, {
        event: "preCommit",
        decision: { ...decision, event: "preCommit" },
        execution: "background",
      }));

      expect(readLatestCodexLifecycleJob(root)?.jobId).toBe(second.jobId);
      expect(readLatestCodexLifecycleJob(root)?.jobId).not.toBe(first.jobId);
    } finally {
      if (previous === undefined) delete process.env[COMPOSER_STATE_DIR_ENV];
      else process.env[COMPOSER_STATE_DIR_ENV] = previous;
      rmSync(root, { recursive: true, force: true });
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("readLatestCodexLifecycleJob falls back to scan when the pointer target is deleted", () => {
    const root = mkdtempSync(join(tmpdir(), "composer-life-"));
    const state = mkdtempSync(join(tmpdir(), "composer-life-state-"));
    const previous = process.env[COMPOSER_STATE_DIR_ENV];
    process.env[COMPOSER_STATE_DIR_ENV] = state;
    try {
      const first = writeCodexLifecycleJob(root, newCodexLifecycleJob(root, {
        event: "postPlan",
        decision,
        execution: "background",
      }));
      const second = writeCodexLifecycleJob(root, newCodexLifecycleJob(root, {
        event: "preCommit",
        decision: { ...decision, event: "preCommit" },
        execution: "background",
      }));
      const newer = new Date(Date.now() + 10_000);
      utimesSync(first.resultPath, newer, newer);
      unlinkSync(second.resultPath);

      expect(readLatestCodexLifecycleJob(root)?.jobId).toBe(first.jobId);
    } finally {
      if (previous === undefined) delete process.env[COMPOSER_STATE_DIR_ENV];
      else process.env[COMPOSER_STATE_DIR_ENV] = previous;
      rmSync(root, { recursive: true, force: true });
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("readLatestCodexLifecycleJob falls back to scan when the pointer is corrupt", () => {
    const root = mkdtempSync(join(tmpdir(), "composer-life-"));
    const state = mkdtempSync(join(tmpdir(), "composer-life-state-"));
    const previous = process.env[COMPOSER_STATE_DIR_ENV];
    process.env[COMPOSER_STATE_DIR_ENV] = state;
    try {
      const first = writeCodexLifecycleJob(root, newCodexLifecycleJob(root, {
        event: "postPlan",
        decision,
        execution: "background",
      }));
      const second = writeCodexLifecycleJob(root, newCodexLifecycleJob(root, {
        event: "preCommit",
        decision: { ...decision, event: "preCommit" },
        execution: "background",
      }));
      const newer = new Date(Date.now() + 10_000);
      utimesSync(second.resultPath, newer, newer);
      writeFileSync(join(dirname(second.resultPath), ".latest"), "not-a-job-id\n", "utf8");

      expect(readLatestCodexLifecycleJob(root)?.jobId).toBe(second.jobId);
      expect(readLatestCodexLifecycleJob(root)?.jobId).not.toBe(first.jobId);
    } finally {
      if (previous === undefined) delete process.env[COMPOSER_STATE_DIR_ENV];
      else process.env[COMPOSER_STATE_DIR_ENV] = previous;
      rmSync(root, { recursive: true, force: true });
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("reconciles and persists orphaned foreign running lifecycle jobs", () => {
    const root = mkdtempSync(join(tmpdir(), "composer-life-"));
    const state = mkdtempSync(join(tmpdir(), "composer-life-state-"));
    const previous = process.env[COMPOSER_STATE_DIR_ENV];
    process.env[COMPOSER_STATE_DIR_ENV] = state;
    try {
      const job = newCodexLifecycleJob(root, {
        event: "postPlan",
        decision,
        execution: "background",
      });
      writeCodexLifecycleJob(root, {
        ...job,
        status: "running",
        pid: 2147483646,
      });

      const read = readCodexLifecycleJob(root, job.jobId);

      expect(read?.status).toBe("failed");
      expect(read?.error).toContain("orphaned");

      const reread = readCodexLifecycleJob(root, job.jobId);
      expect(reread?.status).toBe("failed");
    } finally {
      if (previous === undefined) delete process.env[COMPOSER_STATE_DIR_ENV];
      else process.env[COMPOSER_STATE_DIR_ENV] = previous;
      rmSync(root, { recursive: true, force: true });
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("does not reconcile running lifecycle jobs owned by the current process", () => {
    const root = mkdtempSync(join(tmpdir(), "composer-life-"));
    const state = mkdtempSync(join(tmpdir(), "composer-life-state-"));
    const previous = process.env[COMPOSER_STATE_DIR_ENV];
    process.env[COMPOSER_STATE_DIR_ENV] = state;
    try {
      const job = newCodexLifecycleJob(root, {
        event: "postPlan",
        decision,
        execution: "background",
      });
      writeCodexLifecycleJob(root, {
        ...job,
        status: "running",
        pid: process.pid,
      });

      const read = readCodexLifecycleJob(root, job.jobId);

      expect(read?.status).toBe("running");
      expect(read?.pid).toBe(process.pid);
    } finally {
      if (previous === undefined) delete process.env[COMPOSER_STATE_DIR_ENV];
      else process.env[COMPOSER_STATE_DIR_ENV] = previous;
      rmSync(root, { recursive: true, force: true });
      rmSync(state, { recursive: true, force: true });
    }
  });
});
