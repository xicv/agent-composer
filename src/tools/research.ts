import { z } from "zod";
import { withProgress } from "../server/progress.js";
import { contextWithHandoff } from "../server/handoffContext.js";
import {
  COMPOSER_RESEARCH,
  RESEARCH_DESCRIPTION,
} from "../server/toolDescriptions.js";
import type { ServerToolContext } from "./context.js";

export function registerResearchTools(ctx: ServerToolContext): void {
  const { server, registry, root } = ctx;

  server.registerTool(
    COMPOSER_RESEARCH,
    {
      description: RESEARCH_DESCRIPTION,
      inputSchema: {
        prompt: z.string().min(1),
        context: z.string().optional(),
        handoffPath: z.string().optional(),
      },
      annotations: {
        title: "Composer Research",
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ prompt, context, handoffPath }, extra) => {
      const provider = registry.getProviderForRole("researcher");
      const result = await withProgress(extra, COMPOSER_RESEARCH, () =>
        provider.execute({
          prompt,
          context: contextWithHandoff(root, context, handoffPath),
          signal: extra.signal,
        }),
        { tracker: ctx.activeRuns },
      );
      return { content: [{ type: "text", text: result.text }] };
    },
  );
}
