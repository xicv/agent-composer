import { z } from "zod";
import { appendAuditEvent, readAuditEvents, renderAuditMarkdown, summarizeAudit } from "../util/auditLog.js";
import { COMPOSER_AUDIT_RECORD, COMPOSER_AUDIT_READ, AUDIT_RECORD_DESCRIPTION, AUDIT_READ_DESCRIPTION, COMPOSER_AUDIT_SUMMARY, AUDIT_SUMMARY_DESCRIPTION } from "../server/toolDescriptions.js";
import type { ServerToolContext } from "./context.js";

export function registerAuditTools(ctx: ServerToolContext): void {
  const { server } = ctx;

  server.registerTool(
    COMPOSER_AUDIT_RECORD,
    {
      description: AUDIT_RECORD_DESCRIPTION,
      inputSchema: {
        kind: z.enum(["route-decision", "tool-call", "review", "test", "outcome", "note"]),
        runId: z.string().optional(),
        objective: z.string().optional(),
        taskClass: z.string().optional(),
        route: z.string().optional(),
        tool: z.string().optional(),
        provider: z.string().optional(),
        expectedOutputTokens: z.number().int().nonnegative().optional(),
        durationMs: z.number().nonnegative().optional(),
        changedFiles: z.number().int().nonnegative().optional(),
        diffLines: z.number().int().nonnegative().optional(),
        reviewVerdict: z.string().optional(),
        testsPassed: z.boolean().optional(),
        userCorrection: z.boolean().optional(),
        status: z.enum(["succeeded", "failed", "partial"]).optional(),
        note: z.string().optional(),
      },
      annotations: {
        title: "Composer Audit Record",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const event = appendAuditEvent(ctx.root, input);
      return { content: [{ type: "text", text: JSON.stringify(event, null, 2) }] };
    },
  );

  server.registerTool(
    COMPOSER_AUDIT_READ,
    {
      description: AUDIT_READ_DESCRIPTION,
      inputSchema: {
        runId: z.string().optional(),
        limit: z.number().int().min(1).max(1000).optional(),
        format: z.enum(["json", "markdown"]).optional(),
      },
      annotations: {
        title: "Composer Audit Read",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    async ({ runId, limit, format }) => {
      const events = readAuditEvents(ctx.root, { limit, runId });
      const text = format === "markdown"
        ? renderAuditMarkdown(events)
        : JSON.stringify(events, null, 2);
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    COMPOSER_AUDIT_SUMMARY,
    {
      description: AUDIT_SUMMARY_DESCRIPTION,
      inputSchema: { limit: z.number().int().min(1).max(10000).optional() },
      annotations: { title: "Composer Audit Summary", readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ limit }) => {
      const events = readAuditEvents(ctx.root, { limit: limit ?? 1000 });
      return { content: [{ type: "text", text: JSON.stringify(summarizeAudit(events), null, 2) }] };
    },
  );
}
