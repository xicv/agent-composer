import { z } from "zod";
import { COMPOSER_ROUTE_DECIDE, ROUTE_DECIDE_DESCRIPTION } from "../server/toolDescriptions.js";
import { classifyDispatch } from "../util/dispatchHint.js";
import type { ServerToolContext } from "./context.js";

export function registerRouteTools(ctx: ServerToolContext): void {
  const { server } = ctx;
  server.registerTool(
    COMPOSER_ROUTE_DECIDE,
    {
      description: ROUTE_DECIDE_DESCRIPTION,
      inputSchema: {
        prompt: z.string().min(1),
        description: z.string().optional(),
        subagentType: z.string().optional(),
      },
      annotations: {
        title: "Composer Route Decide",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ prompt, description, subagentType }) => {
      const hint = classifyDispatch({ prompt, description, subagentType });
      const isOracle = hint.route.target === "composer-oracle-plan" || hint.route.target === "composer-oracle-job-start";
      const oracleEscalation =
        !isOracle && hint.signals.complexityScore >= 0.6
          ? {
              recommended: "composer-oracle-plan",
              reason: "High complexity — consider the opt-in Oracle planning lane (tag [oracle:plan]).",
            }
          : null;
      return {
        content: [{ type: "text", text: JSON.stringify({ ...hint, oracleEscalation }, null, 2) }],
      };
    },
  );
}
