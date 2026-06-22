import { z } from "zod";
import { withProgress } from "../server/progress.js";
import { contextWithHandoff } from "../server/handoffContext.js";
import {
  COMPOSER_RESEARCH,
  RESEARCH_DESCRIPTION,
} from "../server/toolDescriptions.js";
import { createDeadlineSignal } from "../util/asyncControl.js";
import { dispatchWithFallback, type DispatchFallbackSummary } from "../server/dispatchWithFallback.js";
import type { ServerToolContext } from "./context.js";

const DEFAULT_RESEARCHER_TIMEOUT_MS = 180_000;

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
      ctx.refreshConfigIfChanged();
      const toolSignal = createBoundedSignal(
        COMPOSER_RESEARCH,
        resolveRoleTimeoutMs(
          ctx.getActiveConfig()?.roles.researcher?.timeoutMs,
          DEFAULT_RESEARCHER_TIMEOUT_MS,
        ),
        extra.signal,
      );
      try {
        const result = await withProgress(extra, COMPOSER_RESEARCH, (onProgress) =>
          dispatchWithFallback(
            { registry, effectiveFallbacks: ctx.getEffectiveFallbacks() },
            "researcher",
            {
              prompt,
              context: contextWithHandoff(root, context, handoffPath),
              onProgress,
              signal: toolSignal.signal,
            },
          ),
          { tracker: ctx.activeRuns, providerLabel: "read-only-fallback", providerRole: "researcher" },
        );
        return { content: [{ type: "text", text: withFallbackSummary(result.output.text, result.summary) }] };
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

function withFallbackSummary(text: string, summary: DispatchFallbackSummary): string {
  return `${text}\n\nfallbackSummary: ${JSON.stringify(summary)}`;
}
