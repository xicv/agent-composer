import { z } from "zod";
import fs from "node:fs";
import {
  COMPOSER_CONFIG_GET,
  COMPOSER_CONFIG_SET,
  CONFIG_GET_DESCRIPTION,
  CONFIG_SET_DESCRIPTION,
} from "../server/toolDescriptions.js";
import {
  resolveComposerConfigTarget,
  applyComposerConfigPatch,
  assertSafeConfigWriteTarget,
  writeConfigFileAtomically,
  isGlobalComposerConfigPath,
} from "../server/configMutation.js";
import { parseConfig } from "../config/loader.js";
import { modePatch } from "../config/modes.js";
import type { ServerToolContext } from "./context.js";

export function registerConfigTools(ctx: ServerToolContext): void {
  const { server, root } = ctx;

  server.registerTool(
    COMPOSER_CONFIG_GET,
    {
      description: CONFIG_GET_DESCRIPTION,
      inputSchema: {
        scope: z.enum(["active", "project", "global"]).optional(),
      },
      annotations: {
        title: "Composer Config Get",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ scope }) => {
      const target = resolveComposerConfigTarget(root, ctx.options.configPath, scope ?? "active");
      const response = fs.existsSync(target.path)
        ? {
            ...target,
            exists: true,
            config: parseConfig(JSON.parse(fs.readFileSync(target.path, "utf8"))),
          }
        : {
            ...target,
            exists: false,
            config: null,
          };
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    },
  );

  server.registerTool(
    COMPOSER_CONFIG_SET,
    {
      description: CONFIG_SET_DESCRIPTION,
      inputSchema: {
        scope: z.enum(["active", "project", "global"]).optional(),
        dryRun: z.boolean().optional(),
        codexLifecycle: z
          .object({
            enabled: z.boolean().optional(),
            mode: z.enum(["ask", "auto"]).optional(),
            execution: z.enum(["foreground", "background"]).optional(),
            model: z.string().min(1).optional(),
            triggers: z
              .object({
                postResearch: z.boolean().optional(),
                postPlan: z.boolean().optional(),
                postCodeApply: z.boolean().optional(),
                postTestFailure: z.boolean().optional(),
                afterFailedAttempts: z.boolean().optional(),
                preCommit: z.boolean().optional(),
                stopWarm: z.boolean().optional(),
              })
              .strict()
              .optional(),
            thresholds: z
              .object({
                minScore: z.number().min(0).max(100).optional(),
                minExpectedOutputTokens: z.number().int().min(1).optional(),
                minChangedFiles: z.number().int().min(1).optional(),
                minDiffLines: z.number().int().min(1).optional(),
                failedAttempts: z.number().int().min(1).optional(),
              })
              .strict()
              .optional(),
            fallback: z
              .object({
                enabled: z.boolean().optional(),
                order: z
                  .array(z.enum(["researcher", "coder", "reviewer", "reviewerClaude", "coderCli"]))
                  .min(1)
                  .optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        codexReview: z
          .object({
            enabled: z.boolean().optional(),
            mode: z.enum(["ask", "auto"]).optional(),
            execution: z.enum(["foreground", "background"]).optional(),
            scope: z.enum(["auto", "working-tree", "branch"]).optional(),
            base: z.string().min(1).optional(),
            model: z.string().min(1).optional(),
            triggers: z
              .object({
                preCommit: z.boolean().optional(),
                postPlan: z.boolean().optional(),
              })
              .strict()
              .optional(),
            preCommitHook: z
              .object({
                enabled: z.boolean().optional(),
                blockOnSeverity: z.enum(["critical", "high", "medium", "low"]).optional(),
                timeoutMs: z.number().int().min(1).optional(),
                failClosed: z.boolean().optional(),
              })
              .strict()
              .optional(),
            warmCache: z
              .object({
                enabled: z.boolean().optional(),
                maxAgeMinutes: z.number().int().min(1).optional(),
                timeoutMs: z.number().int().min(1).optional(),
              })
              .strict()
              .optional(),
            notify: z
              .object({
                desktop: z.boolean().optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        oracle: z
          .object({
            enabled: z.boolean().optional(),
            defaultMode: z
              .enum(["auto", "quick", "standard", "deep", "plan", "review", "debug", "research"])
              .optional(),
            requireExplicitTag: z.boolean().optional(),
          })
          .strict()
          .optional(),
        mode: z.enum(["fast", "balanced", "strict"]).optional(),
      },
      annotations: {
        title: "Composer Config Set",
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ scope, dryRun, codexLifecycle, codexReview, oracle, mode }) => {
      const requestedScope = scope ?? "active";
      const target = resolveComposerConfigTarget(root, ctx.options.configPath, requestedScope);
      if (requestedScope === "active" && isGlobalComposerConfigPath(target.path)) {
        throw new Error(
          'Active Composer config resolves to the user-global config; use scope:"global" explicitly to mutate it.',
        );
      }
      if (!fs.existsSync(target.path)) {
        throw new Error(`Composer config target does not exist: ${target.path}`);
      }
      const beforeRaw = fs.readFileSync(target.path, "utf8");
      const before = JSON.parse(beforeRaw) as Record<string, unknown>;
      const preset = mode ? modePatch(mode) : undefined;
      const next = applyComposerConfigPatch(before, {
        codexLifecycle: codexLifecycle ?? preset?.codexLifecycle,
        codexReview: codexReview ?? preset?.codexReview,
        oracle,
      });
      const parsed = parseConfig(next);
      const nextRaw = `${JSON.stringify(parsed, null, 2)}\n`;
      const changed = beforeRaw !== nextRaw;
      const activeTarget = resolveComposerConfigTarget(root, ctx.options.configPath, "active");

      if (!dryRun && changed) {
        assertSafeConfigWriteTarget(root, target);
        writeConfigFileAtomically(target.path, nextRaw);
      }
      if (!dryRun && target.path === activeTarget.path) {
        ctx.setActiveConfig(parsed);
      }

      const response = {
        ...target,
        dryRun: dryRun === true,
        changed,
        config: parsed,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    },
  );
}
