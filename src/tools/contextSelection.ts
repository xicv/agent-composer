import { z } from "zod";

import {
  COMPOSER_CONTEXT_SELECT,
  CONTEXT_SELECT_DESCRIPTION,
} from "../server/toolDescriptions.js";
import {
  selectContext,
  writeContextSelectionBrief,
} from "../util/contextSelection.js";
import { SliceSchema } from "../util/brief.js";
import type { ServerToolContext } from "./context.js";

export function registerContextSelectionTools(ctx: ServerToolContext): void {
  ctx.server.registerTool(
    COMPOSER_CONTEXT_SELECT,
    {
      description: CONTEXT_SELECT_DESCRIPTION,
      inputSchema: {
        task: z.string().min(1),
        files: z.array(z.string().min(1)).optional(),
        symbols: z.array(z.string().min(1)).optional(),
        deps: z.array(z.string().min(1)).optional(),
        constraints: z.array(z.string().min(1)).optional(),
        acceptanceCriteria: z.array(z.string().min(1)).optional(),
        slices: z.array(SliceSchema).optional(),
        writeBrief: z.boolean().optional(),
      },
      annotations: {
        title: "Composer Context Select",
        readOnlyHint: false,
        idempotentHint: false,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    async ({
      task,
      files,
      symbols,
      deps,
      constraints,
      acceptanceCriteria,
      slices,
      writeBrief = true,
    }) => {
      const selection = selectContext({
        task,
        files,
        symbols,
        deps,
        constraints,
        acceptanceCriteria,
        slices,
      });
      const briefPath = writeBrief ? writeContextSelectionBrief(selection, ctx.root) : undefined;
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            runId: selection.brief.runId,
            briefPath,
            brief: selection.brief,
            metrics: selection.metrics,
          }, null, 2),
        }],
      };
    },
  );
}
