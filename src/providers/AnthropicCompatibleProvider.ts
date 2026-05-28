// Wave 1 F1.1 — Anthropic-SDK-shaped provider, used against GLM's
// Anthropic-compatible endpoint and any future compatible host.
// Real network calls happen here; tests inject a fake via clientFactory.
//
// KNOWN BUG: provider uses non-streaming messages.create. The Anthropic SDK
// refuses non-streaming requests when configured size suggests >10 min
// duration ("Streaming is required for operations that may take longer than
// 10 minutes"). Workaround: keep role.maxTokens ≲ 16k and
// role.thinking.budgetTokens ≲ 8k. Proper fix: switch to .stream()
// (or .create({stream:true})) and aggregate events — requires updating
// AnthropicLike interface + test mocks.

import Anthropic from "@anthropic-ai/sdk";
import type {
  IProvider,
  IProviderExecuteInput,
  IProviderExecuteOutput,
  ProviderId,
} from "./IProvider.js";

/** Minimal shape we need from the Anthropic client — eases DI in tests. */
export interface AnthropicLike {
  messages: {
    create: (params: AnthropicCreateParams) => Promise<AnthropicCreateResult>;
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
  /** Extended-thinking knob; omit to disable. When type=enabled, budgetTokens is required. */
  thinking?: { type: "enabled"; budgetTokens: number } | { type: "disabled" };
  /** Override Anthropic SDK construction. Used by tests. */
  clientFactory?: (opts: { baseURL: string; apiKey: string }) => AnthropicLike;
}

const DEFAULT_FACTORY = ({ baseURL, apiKey }: { baseURL: string; apiKey: string }): AnthropicLike =>
  new Anthropic({ baseURL, apiKey }) as unknown as AnthropicLike;

const DEFAULT_MAX_TOKENS = 4096;

export class AnthropicCompatibleProvider implements IProvider {
  readonly id: ProviderId = "anthropic";
  readonly modelLabel: string;

  private readonly client: AnthropicLike;
  private readonly defaultMaxTokens: number;
  private readonly thinking?: ThinkingParam;

  constructor(opts: AnthropicCompatibleProviderOptions) {
    if (!opts.baseUrl) throw new Error("AnthropicCompatibleProvider: baseUrl required");
    if (!opts.apiKey) throw new Error("AnthropicCompatibleProvider: apiKey required");
    if (!opts.model) throw new Error("AnthropicCompatibleProvider: model required");
    this.modelLabel = opts.model;
    this.defaultMaxTokens = opts.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
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

    const msg = await this.client.messages.create(params);

    // Best-effort GLM cache-hit telemetry
    try {
      const fs = await import("node:fs");
      const entry = {
        ts: new Date().toISOString(),
        model: this.modelLabel,
        input_tokens: msg.usage.input_tokens,
        output_tokens: msg.usage.output_tokens,
        cache_creation_input_tokens: msg.usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? 0,
      };
      fs.appendFileSync("/tmp/composer-glm-usage.jsonl", JSON.stringify(entry) + "\n");
    } catch {
      // best-effort telemetry; never break the provider on log failure
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
