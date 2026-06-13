// C0.1 — Wave 0 frozen contract. See docs/adr/0001-contracts.md.
// Append-only during Wave 1: new optional fields OK; renames / removals NOT.

export type ProviderId = "anthropic" | "openai_compatible" | "cli" | "mock";

export interface IProviderExecuteInput {
  prompt: string;
  context?: string;
  maxTokens?: number;
  cwd?: string;
  projectDir?: string;
  readOnly?: boolean;
  /** Optional model override forwarded to model-aware CLIs (currently codex exec via -m). Ignored by providers that pin their own model. */
  model?: string;
  signal?: AbortSignal;
}

export interface IProviderExecuteOutput {
  text: string;
  tokensIn?: number;
  tokensOut?: number;
}

export interface IProvider {
  readonly id: ProviderId;
  readonly modelLabel: string;
  healthCheck(): Promise<boolean>;
  execute(input: IProviderExecuteInput): Promise<IProviderExecuteOutput>;
}
