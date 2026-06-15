import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { appendFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPOSER_STATE_DIR_ENV } from "../../src/util/codexLifecycleJob.js";
import {
  AuditEventSchema,
  appendAuditEvent,
  readAuditEvents,
  readAuditFailures,
  readRecentAuditEvents,
  renderAuditMarkdown,
  summarizeAudit,
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

  it("readRecentAuditEvents returns the last N events in chronological order", () => {
    const written = Array.from({ length: 12 }, (_, i) =>
      appendAuditEvent(projectRoot!, { kind: "note", runId: `r-${i}`, note: `event-${i}` })
    );

    for (const limit of [0, 1, 3, 20]) {
      expect(readRecentAuditEvents(projectRoot!, limit)).toEqual(limit === 0 ? [] : written.slice(-limit));
    }
  });

  it("readRecentAuditEvents handles empty and short logs", () => {
    const fresh = mkdtempSync(join(tmpdir(), "composer-audit-recent-empty-"));
    try {
      expect(readRecentAuditEvents(fresh, 5)).toEqual([]);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }

    const event = appendAuditEvent(projectRoot!, { kind: "outcome", status: "succeeded" });
    expect(readRecentAuditEvents(projectRoot!, 5)).toEqual([event]);
  });

  it("readRecentAuditEvents skips malformed trailing lines and matches full-history slicing", () => {
    for (let i = 0; i < 90; i += 1) {
      appendAuditEvent(projectRoot!, {
        kind: "note",
        runId: `r-${i}`,
        note: `event-${i}-${"x".repeat(1000)}`,
      });
    }
    const auditDir = join(stateDir!, "audit");
    const files = readdirSync(auditDir);
    const logFile = join(auditDir, files[0]!);
    appendFileSync(logFile, "NOT_JSON\n", "utf8");

    const expected = readAuditEvents(projectRoot!, { limit: Number.MAX_SAFE_INTEGER }).slice(-5);

    expect(readRecentAuditEvents(projectRoot!, 5)).toEqual(expected);
  });

  it("appendAuditEvent caps oversized free-text fields before writing", () => {
    const longNote = "n".repeat(9999);
    const longObjective = "o".repeat(9999);
    const longRoute = "r".repeat(999);

    appendAuditEvent(projectRoot!, {
      kind: "note",
      runId: "r-cap",
      note: longNote,
      objective: longObjective,
      route: longRoute,
    });

    const events = readAuditEvents(projectRoot!, { runId: "r-cap" });
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.note?.length).toBe(2000);
    expect(ev.objective?.length).toBe(500);
    expect(ev.route?.length).toBe(120);
  });

  it("a 9999-char note is still readable after cap-on-append", () => {
    appendAuditEvent(projectRoot!, {
      kind: "note",
      runId: "r-readable",
      note: "x".repeat(9999),
    });
    const events = readAuditEvents(projectRoot!, { runId: "r-readable" });
    expect(events).toHaveLength(1);
    expect(events[0]!.note?.length).toBe(2000);
  });

  it("AuditEventSchema.safeParse rejects a raw object with a 600-char objective", () => {
    const result = AuditEventSchema.safeParse({
      ts: new Date().toISOString(),
      kind: "note",
      objective: "o".repeat(600),
    });
    expect(result.success).toBe(false);
  });

  it("AuditEventSchema accepts positive durationMs and rejects negative durationMs", () => {
    const positive = AuditEventSchema.safeParse({
      ts: new Date().toISOString(),
      kind: "tool-call",
      tool: "composer_status",
      durationMs: 12.5,
    });
    const negative = AuditEventSchema.safeParse({
      ts: new Date().toISOString(),
      kind: "tool-call",
      tool: "composer_status",
      durationMs: -1,
    });

    expect(positive.success).toBe(true);
    expect(negative.success).toBe(false);
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

  describe("summarizeAudit", () => {
    it("counts total, byKind, byStatus, byRoute correctly", () => {
      const events = [
        appendAuditEvent(projectRoot!, { kind: "route-decision", route: "composer_code_cli", status: "succeeded" }),
        appendAuditEvent(projectRoot!, { kind: "outcome", route: "composer_code_cli", status: "failed" }),
        appendAuditEvent(projectRoot!, { kind: "outcome", route: "composer_review", status: "succeeded" }),
      ];
      const summary = summarizeAudit(events);
      expect(summary.total).toBe(3);
      expect(summary.byKind["route-decision"]).toBe(1);
      expect(summary.byKind["outcome"]).toBe(2);
      expect(summary.byStatus["succeeded"]).toBe(2);
      expect(summary.byStatus["failed"]).toBe(1);
      expect(summary.byRoute["composer_code_cli"]).toBe(2);
      expect(summary.byRoute["composer_review"]).toBe(1);
    });

    it("counts testsPassed and testsFailed", () => {
      const events = [
        appendAuditEvent(projectRoot!, { kind: "test", testsPassed: true }),
        appendAuditEvent(projectRoot!, { kind: "test", testsPassed: true }),
        appendAuditEvent(projectRoot!, { kind: "test", testsPassed: false }),
      ];
      const summary = summarizeAudit(events);
      expect(summary.tests.passed).toBe(2);
      expect(summary.tests.failed).toBe(1);
    });

    it("counts userCorrections and includes them in recentFailures", () => {
      const events = [
        appendAuditEvent(projectRoot!, { kind: "note", userCorrection: true }),
        appendAuditEvent(projectRoot!, { kind: "outcome", status: "succeeded" }),
        appendAuditEvent(projectRoot!, { kind: "outcome", status: "failed" }),
      ];
      const summary = summarizeAudit(events);
      expect(summary.userCorrections).toBe(1);
      expect(summary.recentFailures).toHaveLength(2);
      expect(summary.recentFailures.every(
        (e) => e.status === "failed" || e.userCorrection === true
      )).toBe(true);
    });

    it("recentFailures contains at most 5 entries", () => {
      const many = Array.from({ length: 8 }, (_, i) =>
        appendAuditEvent(projectRoot!, { kind: "outcome", status: "failed", note: `fail-${i}` })
      );
      const summary = summarizeAudit(many);
      expect(summary.recentFailures).toHaveLength(5);
    });

    it("counts reviewVerdicts", () => {
      const events = [
        appendAuditEvent(projectRoot!, { kind: "review", reviewVerdict: "approved" }),
        appendAuditEvent(projectRoot!, { kind: "review", reviewVerdict: "approved" }),
        appendAuditEvent(projectRoot!, { kind: "review", reviewVerdict: "needs-attention" }),
      ];
      const summary = summarizeAudit(events);
      expect(summary.reviewVerdicts["approved"]).toBe(2);
      expect(summary.reviewVerdicts["needs-attention"]).toBe(1);
    });

    it("summarizes latency by tool from events with tool and durationMs", () => {
      const events = [
        appendAuditEvent(projectRoot!, { kind: "tool-call", tool: "composer_status", durationMs: 1 }),
        appendAuditEvent(projectRoot!, { kind: "tool-call", tool: "composer_status", durationMs: 3 }),
        appendAuditEvent(projectRoot!, { kind: "tool-call", tool: "composer_status", durationMs: 5 }),
        appendAuditEvent(projectRoot!, { kind: "tool-call", tool: "composer_route_decide", durationMs: 10 }),
        appendAuditEvent(projectRoot!, { kind: "tool-call", tool: "composer_status" }),
        appendAuditEvent(projectRoot!, { kind: "tool-call", durationMs: 100 }),
      ];

      const summary = summarizeAudit(events);

      expect(summary.latencyByTool["composer_status"]).toEqual({
        count: 3,
        p50: 3,
        p95: 5,
        p99: 5,
        max: 5,
      });
      expect(summary.latencyByTool["composer_route_decide"]?.p95).toBe(10);
      expect(summary.latencyByTool).not.toHaveProperty("undefined");
    });

    it("returns zeroed summary for empty events array", () => {
      const summary = summarizeAudit([]);
      expect(summary.total).toBe(0);
      expect(summary.byKind).toEqual({});
      expect(summary.byStatus).toEqual({});
      expect(summary.byRoute).toEqual({});
      expect(summary.reviewVerdicts).toEqual({});
      expect(summary.tests).toEqual({ passed: 0, failed: 0 });
      expect(summary.userCorrections).toBe(0);
      expect(summary.recentFailures).toEqual([]);
      expect(summary.latencyByTool).toEqual({});
    });
  });
});
