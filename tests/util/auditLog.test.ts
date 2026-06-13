import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { appendFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPOSER_STATE_DIR_ENV } from "../../src/util/codexLifecycleJob.js";
import {
  appendAuditEvent,
  readAuditEvents,
  readAuditFailures,
  renderAuditMarkdown,
} from "../../src/util/auditLog.js";

describe("auditLog", () => {
  let stateDir: string | undefined;
  let prevStateDir: string | undefined;
  let projectRoot: string | undefined;

  beforeEach(() => {
    prevStateDir = process.env[COMPOSER_STATE_DIR_ENV];
    stateDir = mkdtempSync(join(tmpdir(), "composer-audit-state-"));
    projectRoot = mkdtempSync(join(tmpdir(), "composer-audit-root-"));
    process.env[COMPOSER_STATE_DIR_ENV] = stateDir;
  });

  afterEach(() => {
    if (prevStateDir === undefined) delete process.env[COMPOSER_STATE_DIR_ENV];
    else process.env[COMPOSER_STATE_DIR_ENV] = prevStateDir;
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
    stateDir = undefined;
    projectRoot = undefined;
    prevStateDir = undefined;
  });

  it("appendAuditEvent stamps ts and persists the event", () => {
    const before = Date.now();
    const event = appendAuditEvent(projectRoot!, { kind: "outcome", runId: "r1", status: "succeeded" });
    const after = Date.now();

    expect(event.kind).toBe("outcome");
    expect(event.runId).toBe("r1");
    expect(event.status).toBe("succeeded");
    expect(typeof event.ts).toBe("string");
    expect(new Date(event.ts).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(event.ts).getTime()).toBeLessThanOrEqual(after);

    const read = readAuditEvents(projectRoot!);
    expect(read).toHaveLength(1);
    expect(read[0]?.runId).toBe("r1");
  });

  it("readAuditEvents returns chronological order", () => {
    appendAuditEvent(projectRoot!, { kind: "route-decision", runId: "r1" });
    appendAuditEvent(projectRoot!, { kind: "outcome", runId: "r1", status: "succeeded" });
    appendAuditEvent(projectRoot!, { kind: "note", runId: "r2" });

    const all = readAuditEvents(projectRoot!);
    expect(all).toHaveLength(3);
    expect(all[0]?.kind).toBe("route-decision");
    expect(all[1]?.kind).toBe("outcome");
    expect(all[2]?.kind).toBe("note");
  });

  it("readAuditEvents respects limit", () => {
    appendAuditEvent(projectRoot!, { kind: "note" });
    appendAuditEvent(projectRoot!, { kind: "note" });
    appendAuditEvent(projectRoot!, { kind: "outcome", status: "succeeded" });

    const last2 = readAuditEvents(projectRoot!, { limit: 2 });
    expect(last2).toHaveLength(2);
    // last 2 in chronological order — index 0 is the second note, index 1 is outcome
    expect(last2[last2.length - 1]?.kind).toBe("outcome");
  });

  it("readAuditEvents filters by runId", () => {
    appendAuditEvent(projectRoot!, { kind: "note", runId: "r1" });
    appendAuditEvent(projectRoot!, { kind: "outcome", runId: "r2", status: "succeeded" });
    appendAuditEvent(projectRoot!, { kind: "note", runId: "r1" });

    const r1 = readAuditEvents(projectRoot!, { runId: "r1" });
    expect(r1).toHaveLength(2);
    expect(r1.every((e) => e.runId === "r1")).toBe(true);
  });

  it("readAuditEvents returns [] when log is missing", () => {
    const fresh = mkdtempSync(join(tmpdir(), "composer-audit-empty-"));
    try {
      const events = readAuditEvents(fresh);
      expect(events).toEqual([]);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("readAuditEvents skips malformed lines", () => {
    // Write one valid event then corrupt the JSONL manually
    appendAuditEvent(projectRoot!, { kind: "note", runId: "r1" });
    const auditDir = join(stateDir!, "audit");
    const files = readdirSync(auditDir);
    const logFile = join(auditDir, files[0]!);
    appendFileSync(logFile, "NOT_JSON\n", "utf8");
    appendFileSync(logFile, `${JSON.stringify({ ts: new Date().toISOString(), kind: "note", runId: "r1" })}\n`, "utf8");

    const events = readAuditEvents(projectRoot!);
    // Should have 2 valid events (skipping the malformed line)
    expect(events.length).toBe(2);
  });

  it("readAuditFailures returns only failed or userCorrection events", () => {
    appendAuditEvent(projectRoot!, { kind: "outcome", status: "succeeded" });
    appendAuditEvent(projectRoot!, { kind: "outcome", status: "failed" });
    appendAuditEvent(projectRoot!, { kind: "note", userCorrection: true });
    appendAuditEvent(projectRoot!, { kind: "outcome", status: "partial" });

    const failures = readAuditFailures(projectRoot!);
    expect(failures).toHaveLength(2);
    expect(failures.every((e) => e.status === "failed" || e.userCorrection === true)).toBe(true);
  });

  it("renderAuditMarkdown groups by runId and is non-empty", () => {
    appendAuditEvent(projectRoot!, { kind: "route-decision", runId: "r1", route: "composer_code_cli" });
    appendAuditEvent(projectRoot!, { kind: "outcome", runId: "r1", status: "succeeded", changedFiles: 3 });
    appendAuditEvent(projectRoot!, { kind: "note", note: "no run here" });

    const events = readAuditEvents(projectRoot!);
    const md = renderAuditMarkdown(events);
    expect(typeof md).toBe("string");
    expect(md.length).toBeGreaterThan(0);
    expect(md).toContain("r1");
    expect(md).toContain("(no run)");
  });
});
