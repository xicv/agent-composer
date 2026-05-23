// Wave 1 F1.1 — Anthropic-SDK-shaped provider, used against GLM's
// Anthropic-compatible endpoint and any future compatible host.
// Real network calls happen here; tests inject a fake via clientFactory.

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

export interface AnthropicCreateParams {
  model: string;
  max_tokens: number;
  messages: ReadonlyArray<{
    role: "user" | "assistant";
    content: ReadonlyArray<{ type: "text"; text: string }>;
  }>;
}

export interface AnthropicCreateResult {
  content: ReadonlyArray<{ type: string; text?: string }>;
  usage: { input_tokens: number; output_tokens: number };
}

export interface AnthropicCompatibleProviderOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  defaultMaxTokens?: number;
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

  constructor(opts: AnthropicCompatibleProviderOptions) {
    if (!opts.baseUrl) throw new Error("AnthropicCompatibleProvider: baseUrl required");
    if (!opts.apiKey) throw new Error("AnthropicCompatibleProvider: apiKey required");
    if (!opts.model) throw new Error("AnthropicCompatibleProvider: model required");
    this.modelLabel = opts.model;
    this.defaultMaxTokens = opts.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
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

    const msg = await this.client.messages.create({
      model: this.modelLabel,
      max_tokens: input.maxTokens ?? this.defaultMaxTokens,
      messages: [{ role: "user", content: userContent }],
    });

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
