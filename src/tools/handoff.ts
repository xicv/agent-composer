import { z } from "zod";
import path from "node:path";
import {
  COMPOSER_HANDOFF_CREATE,
  HANDOFF_CREATE_DESCRIPTION,
} from "../server/toolDescriptions.js";
import {
  HANDOFF_DIR,
  newHandoffPacket,
  writeHandoffPacket,
  type HandoffArtifact,
} from "../util/handoff.js";
import type { ServerToolContext } from "./context.js";

export function registerHandoffTools(ctx: ServerToolContext): void {
  const { server, root } = ctx;

  server.registerTool(
    COMPOSER_HANDOFF_CREATE,
    {
      description: HANDOFF_CREATE_DESCRIPTION,
      inputSchema: {
        objective: z.string().min(1),
        contextSummary: z.string().optional(),
        constraints: z.array(z.string().min(1)).optional(),
        relevantFiles: z.array(z.string().min(1)).optional(),
        acceptanceCriteria: z.array(z.string().min(1)).optional(),
        decisions: z.array(z.string().min(1)).optional(),
        openQuestions: z.array(z.string().min(1)).optional(),
        artifacts: z
          .array(
            z.object({
              kind: z.enum(["research", "code", "review", "test", "note"]),
              summary: z.string().min(1),
              path: z.string().min(1).optional(),
              source: z.string().min(1).optional(),
            }),
          )
          .optional(),
        briefPath: z.string().optional(),
      },
      annotations: {
        title: "Composer Handoff Create",
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({
      objective,
      contextSummary,
      constraints,
      relevantFiles,
      acceptanceCriteria,
      decisions,
      openQuestions,
      artifacts,
      briefPath,
    }) => {
      const packet = newHandoffPacket({
        objective,
        contextSummary,
        constraints,
        relevantFiles,
        acceptanceCriteria,
        decisions,
        openQuestions,
        artifacts: artifacts as HandoffArtifact[] | undefined,
        briefPath,
      });
      const handoffPath = writeHandoffPacket(
        packet,
        path.resolve(root, HANDOFF_DIR),
      );
      const response = {
        runId: packet.runId,
        handoffPath,
        objective: packet.objective,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    },
  );
}
