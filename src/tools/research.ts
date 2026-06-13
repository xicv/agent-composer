import { z } from "zod";
import { withProgress } from "../server/progress.js";
import { contextWithHandoff } from "../server/handoffContext.js";
import { applyFileBlocks, resolveProjectDir } from "../util/applyFileBlocks.js";
import { computeReviewDiff } from "../util/reviewDiff.js";
import {
  COMPOSER_RESEARCH,
  COMPOSER_CODE,
  COMPOSER_REVIEW,
  COMPOSER_REVIEW_CLAUDE,
  COMPOSER_CODE_CHAIN,
  COMPOSER_CODE_CLI,
  RESEARCH_DESCRIPTION,
  CODE_DESCRIPTION,
  REVIEW_DESCRIPTION,
  REVIEW_CLAUDE_DESCRIPTION,
  CODE_CHAIN_DESCRIPTION,
  CODE_CLI_DESCRIPTION,
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
      );
      return { content: [{ type: "text", text: result.text }] };
    },
  );

  server.registerTool(
    COMPOSER_CODE,
    {
      description: CODE_DESCRIPTION,
      inputSchema: {
        prompt: z.string().min(1),
        context: z.string().optional(),
        handoffPath: z.string().optional(),
      },
      annotations: {
        title: "Composer Code",
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ prompt, context, handoffPath }, extra) => {
      const provider = registry.getProviderForRole("coder");
      const result = await withProgress(extra, COMPOSER_CODE, () =>
        provider.execute({
          prompt,
          context: contextWithHandoff(root, context, handoffPath),
          signal: extra.signal,
        }),
      );
      return { content: [{ type: "text", text: result.text }] };
    },
  );

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
      );
      return { content: [{ type: "text", text: result.text }] };
    },
  );

  server.registerTool(
    COMPOSER_CODE_CHAIN,
    {
      description: CODE_CHAIN_DESCRIPTION,
      inputSchema: {
        prompt: z.string().min(1),
        context: z.string().optional(),
        handoffPath: z.string().optional(),
        projectDir: z.string().optional(),
      },
      annotations: {
        title: "Composer Code (GLM author -> CLI apply)",
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({ prompt, context, handoffPath, projectDir }, extra) => {
      const targetRoot = resolveProjectDir(projectDir, root);
      // Stage 1: GLM authors the code off-CC (returns full file contents).
      const gen = registry.getProviderForRole("coder");
      const genPrompt =
        prompt +
        `\n\nTARGET PROJECT DIR: ${targetRoot}. All FILE paths must be relative to this directory.` +
        "\n\nOUTPUT FORMAT: give the COMPLETE contents of every file to " +
        "create or modify. For each file, write a line `FILE: <relative/path>` " +
        "followed by a fenced code block with the full file content. Use " +
        "four-backtick fences when file content may contain triple-backtick " +
        "blocks. No " +
        "abbreviations, no placeholders, no commentary outside the blocks.";
      const authored = await withProgress(extra, COMPOSER_CODE_CHAIN, () =>
        gen.execute({
          prompt: genPrompt,
          context: contextWithHandoff(root, context, handoffPath),
          cwd: targetRoot,
          signal: extra.signal,
        }),
      );

      // Stage 2: server applies GLM's FILE: blocks deterministically (off-CC,
      // no LLM transcription step — an executor cannot fabricate the apply).
      const { files } = applyFileBlocks(authored.text, targetRoot);
      const changed = files.filter((file) => file.status === "changed");
      if (changed.length === 0) {
        throw new Error(
          `composer_code_chain: apply produced no changes — check projectDir (server cwd is ${process.cwd()}, target was ${targetRoot}); nothing was modified`,
        );
      }
      const summary =
        `GLM authored + applied off-CC in projectDir ${targetRoot}. ` +
        `Changed ${changed.length}/${files.length} file(s): ` +
        files.map((file) => `${file.path}=${file.status}`).join(", ") + ".";
      return { content: [{ type: "text", text: summary }] };
    },
  );

  server.registerTool(
    COMPOSER_CODE_CLI,
    {
      description: CODE_CLI_DESCRIPTION,
      inputSchema: {
        prompt: z.string().min(1),
        context: z.string().optional(),
        handoffPath: z.string().optional(),
        projectDir: z.string().optional(),
      },
      annotations: {
        title: "Composer Code (CLI apply)",
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({ prompt, context, handoffPath, projectDir }, extra) => {
      const targetRoot = resolveProjectDir(projectDir, root);
      const provider = registry.getProviderForRole("coderCli");
      const result = await withProgress(extra, COMPOSER_CODE_CLI, () =>
        provider.execute({
          prompt,
          context: contextWithHandoff(root, context, handoffPath),
          cwd: root,
          projectDir: projectDir === undefined ? undefined : targetRoot,
          signal: extra.signal,
        }),
      );
      return { content: [{ type: "text", text: result.text }] };
    },
  );
}
