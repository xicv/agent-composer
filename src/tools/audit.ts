import { z } from "zod";
import { appendAuditEvent, readAuditEvents, renderAuditMarkdown, summarizeAudit } from "../util/auditLog.js";
import { AUDIT_DESCRIPTION, COMPOSER_AUDIT } from "../server/toolDescriptions.js";
import type { ServerToolContext } from "./context.js";

export function registerAuditTools(ctx: ServerToolContext): void {
  const { server } = ctx;

  server.registerTool(
    COMPOSER_AUDIT,
    {
      description: AUDIT_DESCRIPTION,
      inputSchema: z.discriminatedUnion("action", [
        z.object({
          action: z.literal("record"),
          kind: z.enum(["route-decision", "tool-call", "review", "test", "outcome", "note"]),
          runId: z.string().optional(),
          objective: z.string().optional(),
          taskClass: z.string().optional(),
          route: z.string().optional(),
          tool: z.string().optional(),
          provider: z.string().optional(),
          expectedOutputTokens: z.number().int().nonnegative().optional(),
          changedFiles: z.number().int().nonnegative().optional(),
          diffLines: z.number().int().nonnegative().optional(),
          reviewVerdict: z.string().optional(),
          testsPassed: z.boolean().optional(),
          userCorrection: z.boolean().optional(),
          status: z.enum(["succeeded", "failed", "partial"]).optional(),
          note: z.string().optional(),
        }),
        z.object({
          action: z.literal("read"),
          runId: z.string().optional(),
          limit: z.number().int().min(1).max(1000).optional(),
          format: z.enum(["json", "markdown"]).optional(),
        }),
        z.object({
          action: z.literal("summary"),
          limit: z.number().int().min(1).max(10000).optional(),
        }),
      ]),
      annotations: {
        title: "Composer Audit",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      switch (input.action) {
        case "record": {
          const { action: _action, ...eventInput } = input;
          const event = appendAuditEvent(ctx.root, eventInput);
          return { content: [{ type: "text", text: JSON.stringify(event, null, 2) }] };
        }
        case "read": {
          const events = readAuditEvents(ctx.root, { limit: input.limit, runId: input.runId });
          const text = input.format === "markdown"
            ? renderAuditMarkdown(events)
            : JSON.stringify(events, null, 2);
          return { content: [{ type: "text", text }] };
        }
        case "summary": {
          const events = readAuditEvents(ctx.root, { limit: input.limit ?? 1000 });
          return { content: [{ type: "text", text: JSON.stringify(summarizeAudit(events), null, 2) }] };
        }
      }
    },
  );
}
