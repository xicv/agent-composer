import type { ServerToolContext } from "./context.js";
import { buildStatus } from "../cli/status.js";
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
      const session = ctx.getSession();
      const result = {
        ...status,
        session: Object.keys(session).length > 0 ? session : undefined,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
