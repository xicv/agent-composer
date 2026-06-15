#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const fixturePath = new URL("../tests/fixtures/large-audit-10k.jsonl", import.meta.url);
const baseTime = Date.parse("2026-06-15T00:00:00.000Z");
const tools = ["composer_status", "composer_route_decide", "composer_review_job_start"];

export function makeAuditEvents(count) {
  return Array.from({ length: count }, (_, i) => {
    const ts = new Date(baseTime + i * 1000).toISOString();
    switch (i % 5) {
      case 0:
        return { ts, kind: "route-decision", route: "composer-code-cli", taskClass: "simple-code" };
      case 1: {
        const tool = tools[Math.floor(i / 5) % tools.length];
        return { ts, kind: "tool-call", tool, durationMs: 5 + (i % 97) };
      }
      case 2:
        return { ts, kind: "review", reviewVerdict: i % 10 === 2 ? "needs-attention" : "approved" };
      case 3:
        return { ts, kind: "test", testsPassed: i % 20 !== 3 };
      default:
        return { ts, kind: "outcome", status: i % 25 === 4 ? "partial" : "succeeded" };
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const events = makeAuditEvents(10000);
  mkdirSync(dirname(fileURLToPath(fixturePath)), { recursive: true });
  writeFileSync(fixturePath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
}
