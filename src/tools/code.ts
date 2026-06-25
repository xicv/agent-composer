import { z } from "zod";
import { withProgress } from "../server/progress.js";
import { contextWithHandoff } from "../server/handoffContext.js";
import { resolveProjectDir } from "../util/projectDir.js";
import { createDeadlineSignal } from "../util/asyncControl.js";
import {
  COMPOSER_CODE_CLI,
  CODE_CLI_DESCRIPTION,
} from "../server/toolDescriptions.js";
import type { ServerToolContext } from "./context.js";

const DEFAULT_CODER_CLI_TIMEOUT_MS = 240_000;

export function registerCodeTools(ctx: ServerToolContext): void {
  const { server, registry, root } = ctx;

  server.registerTool(
    COMPOSER_CODE_CLI,
    {
      description: CODE_CLI_DESCRIPTION,
      inputSchema: {
        prompt: z.string().min(1),
        context: z.string().optional(),
        handoffPath: z.string().optional(),
        projectDir: z.string().optional(),
        profile: z.string().min(1).optional(),
      },
      annotations: {
        title: "Composer Code (CLI apply)",
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({ prompt, context, handoffPath, projectDir, profile }, extra) => {
      ctx.refreshConfigIfChanged();
      const targetRoot = resolveProjectDir(projectDir, root);
      const profiles = ctx.getActiveConfig()?.codexProfiles;
      const effectiveProfile = profile ?? ctx.getSession().profile;
      let profileModel: string | undefined;
      let profileReasoning: "low" | "medium" | "high" | undefined;
      let profileSandbox: "read-only" | "workspace-write" | undefined;
      if (effectiveProfile !== undefined) {
        const prof = profiles?.[effectiveProfile];
        if (!prof) {
          throw new Error(
            `composer_code_cli: unknown profile "${effectiveProfile}" — define it under codexProfiles in composer.config.json.`,
          );
        }
        profileModel = prof.model;
        profileReasoning = prof.reasoningEffort;
        profileSandbox = prof.sandbox;
      }
      const provider = registry.getProviderForRole("coderCli");
      const toolSignal = createBoundedSignal(
        COMPOSER_CODE_CLI,
        resolveRoleTimeoutMs(
          ctx.getActiveConfig()?.roles.coderCli?.timeoutMs,
          DEFAULT_CODER_CLI_TIMEOUT_MS,
        ),
        extra.signal,
      );
      try {
        const result = await withProgress(extra, COMPOSER_CODE_CLI, (onProgress) =>
          provider.execute({
            prompt,
            context: contextWithHandoff(root, context, handoffPath),
            cwd: root,
            projectDir: projectDir === undefined ? undefined : targetRoot,
            model: profileModel,
            reasoningEffort: profileReasoning,
            sandbox: profileSandbox,
            onProgress,
            signal: toolSignal.signal,
          }),
          { tracker: ctx.activeRuns, providerLabel: provider.modelLabel, providerRole: "coderCli" },
        );
        return { content: [{ type: "text", text: result.text }] };
      } finally {
        toolSignal.cleanup();
      }
    },
  );
}

function resolveRoleTimeoutMs(configuredTimeoutMs: unknown, fallbackMs: number): number {
  return typeof configuredTimeoutMs === "number" &&
    Number.isFinite(configuredTimeoutMs) &&
    configuredTimeoutMs > 0
    ? configuredTimeoutMs
    : fallbackMs;
}

function createBoundedSignal(label: string, timeoutMs: number, callerSignal?: AbortSignal): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  return createDeadlineSignal(label, timeoutMs, callerSignal);
}
