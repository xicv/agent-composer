import type { ServerToolContext } from "./context.js";
import { buildStatus, statusEnvelope } from "../cli/status.js";
import { COMPOSER_STATUS, STATUS_DESCRIPTION } from "../server/toolDescriptions.js";

export function registerStatusTools(ctx: ServerToolContext): void {
  ctx.server.registerTool(
    COMPOSER_STATUS,
    {
      description: STATUS_DESCRIPTION,
      inputSchema: {},
      annotations: {
        title: "Composer Status",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    async () => {
      const status = buildStatus(ctx.root);
      const nowMs = Date.now();
      status.active.foreground = ctx.activeRuns.list().map((r) => ({
        tool: r.tool,
        providerRole: r.providerRole,
        ageSeconds: Math.max(0, Math.floor((nowMs - Date.parse(r.startedAt)) / 1000)),
      }));
      const session = ctx.getSession();
      const sv = Object.keys(session).length > 0 ? session : undefined;
      const result = {
        ...statusEnvelope(status, sv),
        session: sv,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
