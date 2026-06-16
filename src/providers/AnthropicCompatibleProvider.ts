// Wave 1 F1.1 — Anthropic-SDK-shaped provider, used against GLM's
// Anthropic-compatible endpoint and any future compatible host.
// Real network calls happen here; tests inject a fake via clientFactory.
//
// Uses messages.stream().finalMessage() so long/extended-thinking operations
// are not refused by the SDK's 10-minute non-streaming guard.

import Anthropic from "@anthropic-ai/sdk";
import type {
  IProvider,
  IProviderExecuteInput,
  IProviderExecuteOutput,
  ProviderId,
} from "./IProvider.js";

/** Minimal shape we need from the Anthropic client — eases DI in tests. */
export interface AnthropicMessageStream {
  finalMessage: () => Promise<AnthropicCreateResult>;
  abort?: () => void;
  cancel?: () => void | Promise<void>;
  destroy?: () => void;
}
export interface AnthropicLike {
  messages: {
    stream: (
      params: AnthropicCreateParams,
      options?: { signal?: AbortSignal },
    ) => AnthropicMessageStream;
  };
}

export type ThinkingParam =
  | { type: "enabled"; budget_tokens: number }
  | { type: "disabled" };

export interface AnthropicCreateParams {
  model: string;
  max_tokens: number;
  messages: ReadonlyArray<{
    role: "user" | "assistant";
    content: ReadonlyArray<{ type: "text"; text: string }>;
  }>;
  thinking?: ThinkingParam;
}

export interface AnthropicCreateResult {
  content: ReadonlyArray<{ type: string; text?: string }>;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export interface AnthropicCompatibleProviderOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  defaultMaxTokens?: number;
  /** Hard per-request deadline. Defaults to 180s so compatible streaming calls are always bounded. */
  timeoutMs?: number;
  /** Extended-thinking knob; omit to disable. When type=enabled, budgetTokens is required. */
  thinking?: { type: "enabled"; budgetTokens: number } | { type: "disabled" };
  /** Override Anthropic SDK construction. Used by tests. */
  clientFactory?: (opts: { baseURL: string; apiKey: string }) => AnthropicLike;
}

const DEFAULT_FACTORY = ({ baseURL, apiKey }: { baseURL: string; apiKey: string }): AnthropicLike =>
  new Anthropic({ baseURL, apiKey }) as unknown as AnthropicLike;

const DEFAULT_MAX_TOKENS = 4096;
export const DEFAULT_ANTHROPIC_TIMEOUT_MS = 180_000;

export class AnthropicCompatibleProvider implements IProvider {
  readonly id: ProviderId = "anthropic";
  readonly modelLabel: string;

  private readonly client: AnthropicLike;
  private readonly defaultMaxTokens: number;
  private readonly timeoutMs: number;
  private readonly thinking?: ThinkingParam;

  constructor(opts: AnthropicCompatibleProviderOptions) {
    if (!opts.baseUrl) throw new Error("AnthropicCompatibleProvider: baseUrl required");
    if (!opts.apiKey) throw new Error("AnthropicCompatibleProvider: apiKey required");
    if (!opts.model) throw new Error("AnthropicCompatibleProvider: model required");
    this.modelLabel = opts.model;
    this.defaultMaxTokens = opts.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_ANTHROPIC_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("AnthropicCompatibleProvider: timeoutMs must be a positive finite number");
    }
    if (opts.thinking) {
      if (opts.thinking.type === "enabled") {
        if (typeof opts.thinking.budgetTokens !== "number" || opts.thinking.budgetTokens < 1024) {
          throw new Error(
            "AnthropicCompatibleProvider: thinking.budgetTokens must be >=1024 when type=enabled (Anthropic SDK minimum)",
          );
        }
        if (opts.thinking.budgetTokens >= this.defaultMaxTokens) {
          throw new Error(
            `AnthropicCompatibleProvider: thinking.budgetTokens (${opts.thinking.budgetTokens}) must be less than max_tokens (${this.defaultMaxTokens}); set role.maxTokens higher`,
          );
        }
        this.thinking = { type: "enabled", budget_tokens: opts.thinking.budgetTokens };
      } else {
        this.thinking = { type: "disabled" };
      }
    }
    const factory = opts.clientFactory ?? DEFAULT_FACTORY;
    this.client = factory({ baseURL: opts.baseUrl, apiKey: opts.apiKey });
  }

  async healthCheck(): Promise<boolean> {
    // SDK construction is the only cheap signal; a real ping would burn
    // tokens. Wave-2 may add a `models.list()` probe.
    return true;
  }

  async execute(
    input: IProviderExecuteInput,
  ): Promise<IProviderExecuteOutput> {
    const userContent: Array<{ type: "text"; text: string }> = [];
    if (input.context) {
      userContent.push({ type: "text", text: `Context:\n${input.context}` });
    }
    userContent.push({ type: "text", text: input.prompt });

    const params: AnthropicCreateParams = {
      model: this.modelLabel,
      max_tokens: input.maxTokens ?? this.defaultMaxTokens,
      messages: [{ role: "user", content: userContent }],
    };
    if (this.thinking) params.thinking = this.thinking;

    const startedAt = Date.now();
    const executionSignal = createTimeoutBoundSignal({
      callerSignal: input.signal,
      timeoutMs: this.timeoutMs,
      timeoutMessage: `AnthropicCompatibleProvider: request timed out after ${this.timeoutMs}ms`,
    });
    let durationMs = 0;
    let msg: AnthropicCreateResult;
    try {
      const stream = this.client.messages.stream(params, { signal: executionSignal.signal });
      msg = await finalMessageWithAbort(stream, executionSignal.signal);
      durationMs = Date.now() - startedAt;
    } finally {
      executionSignal.cleanup();
    }

    // Best-effort GLM cache-hit telemetry
    if (!process.env["VITEST"]) {
      try {
        const fs = await import("node:fs");
        const entry = {
          ts: new Date().toISOString(),
          model: this.modelLabel,
          input_tokens: msg.usage.input_tokens,
          output_tokens: msg.usage.output_tokens,
          cache_creation_input_tokens: msg.usage.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? 0,
          duration_ms: durationMs,
        };
        fs.appendFileSync("/tmp/composer-glm-usage.jsonl", JSON.stringify(entry) + "\n");
      } catch {
        // best-effort telemetry; never break the provider on log failure
      }
    }

    const text = msg.content
      .map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : ""))
      .join("");

    return {
      text,
      tokensIn: msg.usage.input_tokens,
      tokensOut: msg.usage.output_tokens,
    };
  }
}

function createTimeoutBoundSignal(input: {
  callerSignal?: AbortSignal;
  timeoutMs: number;
  timeoutMessage: string;
}): { signal: AbortSignal; cleanup: () => void } {
  const timeoutController = new AbortController();
  const combinedController = new AbortController();
  const timeoutError = new Error(input.timeoutMessage);
  timeoutError.name = "TimeoutError";

  const timer = setTimeout(() => {
    timeoutController.abort(timeoutError);
  }, input.timeoutMs);
  timer.unref?.();

  const abortFrom = (source: AbortSignal) => {
    if (combinedController.signal.aborted) return;
    combinedController.abort(abortReason(source));
  };
  const onCallerAbort = () => {
    if (input.callerSignal) abortFrom(input.callerSignal);
  };
  const onTimeoutAbort = () => abortFrom(timeoutController.signal);

  if (input.callerSignal?.aborted) {
    abortFrom(input.callerSignal);
  } else {
    input.callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  }

  timeoutController.signal.addEventListener("abort", onTimeoutAbort, { once: true });

  return {
    signal: combinedController.signal,
    cleanup: () => {
      clearTimeout(timer);
      input.callerSignal?.removeEventListener("abort", onCallerAbort);
      timeoutController.signal.removeEventListener("abort", onTimeoutAbort);
    },
  };
}

async function finalMessageWithAbort(
  stream: AnthropicMessageStream,
  signal: AbortSignal,
): Promise<AnthropicCreateResult> {
  const cleanupStream = () => {
    try {
      stream.abort?.();
    } catch {
      // best-effort cancellation; the abort promise below still rejects the call
    }
    try {
      const cancelResult = stream.cancel?.();
      if (cancelResult && typeof cancelResult.catch === "function") {
        void cancelResult.catch(() => {
          // best-effort cancellation; the abort promise below still rejects the call
        });
      }
    } catch {
      // best-effort cancellation; the abort promise below still rejects the call
    }
    try {
      stream.destroy?.();
    } catch {
      // best-effort cancellation; the abort promise below still rejects the call
    }
  };

  if (signal.aborted) {
    cleanupStream();
    throw abortReason(signal);
  }

  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => {
      cleanupStream();
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([stream.finalMessage(), abortPromise]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function abortReason(signal: AbortSignal): Error {
  const reason = signal.reason as unknown;
  if (reason instanceof Error) return reason;
  const message =
    typeof reason === "string" && reason.length > 0
      ? reason
      : "AnthropicCompatibleProvider: request aborted";
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}
