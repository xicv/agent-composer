import { z } from "zod";
import { COMPOSER_WORKFLOW_PLAN, WORKFLOW_PLAN_DESCRIPTION } from "../server/toolDescriptions.js";
import { planWorkflow } from "../util/workflowPlan.js";
import type { ServerToolContext } from "./context.js";

export function registerWorkflowTools(ctx: ServerToolContext): void {
  const { server } = ctx;

  server.registerTool(
    COMPOSER_WORKFLOW_PLAN,
    {
      description: WORKFLOW_PLAN_DESCRIPTION,
      inputSchema: {
        goal: z.string().min(1),
        workflow: z.enum(["feature", "debug", "review", "research"]).optional(),
        mode: z.enum(["fast", "balanced", "strict"]).optional(),
        risk: z.enum(["low", "medium", "high"]).optional(),
        needsCurrentDocs: z.boolean().optional(),
      },
      annotations: {
        title: "Composer Workflow Plan",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    async (input) => {
      const plan = planWorkflow(input);
      return { content: [{ type: "text", text: JSON.stringify(plan, null, 2) }] };
    },
  );
}
