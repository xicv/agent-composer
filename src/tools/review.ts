import { z } from "zod";
import { withProgress } from "../server/progress.js";
import { contextWithHandoff } from "../server/handoffContext.js";
import { computeReviewDiff } from "../util/reviewDiff.js";
import {
  COMPOSER_REVIEW,
  COMPOSER_REVIEW_CLAUDE,
  REVIEW_DESCRIPTION,
  REVIEW_CLAUDE_DESCRIPTION,
} from "../server/toolDescriptions.js";
import type { ServerToolContext } from "./context.js";

export function registerReviewTools(ctx: ServerToolContext): void {
  const { server, registry, root } = ctx;

  server.registerTool(
    COMPOSER_REVIEW,
    {
      description: REVIEW_DESCRIPTION,
      inputSchema: {
        prompt: z.string().min(1),
        diff: z.string().min(1).optional(),
        handoffPath: z.string().optional(),
        reviewScope: z.enum(["staged", "unstaged", "working-tree", "branch"]).optional(),
        reviewFiles: z.array(z.string().min(1)).optional(),
        base: z.string().min(1).optional(),
      },
      annotations: {
        title: "Composer Review",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ prompt, diff, handoffPath, reviewScope, reviewFiles, base }, extra) => {
      const effectiveDiff =
        reviewScope !== undefined
          ? computeReviewDiff(root, reviewScope, { base, files: reviewFiles })
          : diff;
      if (!effectiveDiff) {
        throw new Error("composer_review: provide either `diff` or `reviewScope`.");
      }
      const provider = registry.getProviderForRole("reviewer");
      const result = await withProgress(extra, COMPOSER_REVIEW, () =>
        provider.execute({
          prompt,
          context: contextWithHandoff(root, effectiveDiff, handoffPath),
          signal: extra.signal,
        }),
        { tracker: ctx.activeRuns },
      );
      return { content: [{ type: "text", text: result.text }] };
    },
  );

  server.registerTool(
    COMPOSER_REVIEW_CLAUDE,
    {
      description: REVIEW_CLAUDE_DESCRIPTION,
      inputSchema: {
        prompt: z.string().min(1),
        diff: z.string().min(1).optional(),
        handoffPath: z.string().optional(),
        reviewScope: z.enum(["staged", "unstaged", "working-tree", "branch"]).optional(),
        reviewFiles: z.array(z.string().min(1)).optional(),
        base: z.string().min(1).optional(),
      },
      annotations: {
        title: "Composer Review (Claude Premium)",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ prompt, diff, handoffPath, reviewScope, reviewFiles, base }, extra) => {
      const effectiveDiff =
        reviewScope !== undefined
          ? computeReviewDiff(root, reviewScope, { base, files: reviewFiles })
          : diff;
      if (!effectiveDiff) {
        throw new Error("composer_review_claude: provide either `diff` or `reviewScope`.");
      }
      const provider = registry.getProviderForRole("reviewerClaude");
      const result = await withProgress(extra, COMPOSER_REVIEW_CLAUDE, () =>
        provider.execute({
          prompt,
          context: contextWithHandoff(root, effectiveDiff, handoffPath),
          cwd: root,
          signal: extra.signal,
        }),
        { tracker: ctx.activeRuns },
      );
      return { content: [{ type: "text", text: result.text }] };
    },
  );
}
