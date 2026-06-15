import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bench, describe } from "vitest";
import { classifyDispatch } from "../src/util/dispatchHint.ts";
import { planWorkflow } from "../src/util/workflowPlan.ts";
import { AuditEventSchema, summarizeAudit } from "../src/util/auditLog.ts";

const auditFixturePath = resolve(import.meta.dirname, "..", "tests", "fixtures", "large-audit-10k.jsonl");
const auditEvents = readFileSync(auditFixturePath, "utf8")
  .trim()
  .split("\n")
  .map((line) => AuditEventSchema.parse(JSON.parse(line)));

describe("composer hot paths", () => {
  bench("classifyDispatch", () => {
    classifyDispatch({
      prompt: "Fix src/cli/status.ts to add a compact --fast status line and tests.",
      description: "small local implementation",
    });
  });

  bench("planWorkflow", () => {
    planWorkflow({
      goal: "add session restore",
      workflow: "feature",
      mode: "fast",
      risk: "low",
      needsCurrentDocs: false,
    });
  });

  bench("summarizeAudit 10k events", () => {
    summarizeAudit(auditEvents);
  });
});
