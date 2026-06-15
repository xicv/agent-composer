import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AuditEventSchema, summarizeAudit } from "../../src/util/auditLog.js";

const fixturePath = resolve(__dirname, "..", "fixtures", "large-audit-10k.jsonl");

describe("large audit state", () => {
  it("summarizes the 10k audit fixture and includes latency p95 by tool", () => {
    const events = readFileSync(fixturePath, "utf8")
      .trim()
      .split("\n")
      .map((line) => AuditEventSchema.parse(JSON.parse(line)));

    const summary = summarizeAudit(events);

    expect(summary.total).toBe(10000);
    expect(summary.latencyByTool["composer_status"]?.count).toBeGreaterThan(0);
    expect(summary.latencyByTool["composer_status"]?.p95).toBeGreaterThan(0);
    expect(summary.latencyByTool["composer_review_job_start"]?.p95).toBeGreaterThan(0);
  });
});
