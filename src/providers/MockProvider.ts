// Wave 1 F1.3 — in-memory IProvider for unit tests + offline eval.
// Real providers (F1.1 AnthropicCompatible, F1.2 CLI) are tape-replayed
// against fixtures captured ONCE on real GLM/agy traffic; everything else
// runs against MockProvider so tests stay deterministic + zero-cost.

import type {
  IProvider,
  IProviderExecuteInput,
  IProviderExecuteOutput,
} from "./IProvider.js";

export type MockResponse =
  | string
  | ((input: IProviderExecuteInput) => string | IProviderExecuteOutput);

export interface MockProviderOptions {
  /** Override the default 'mock-default' model label. */
  modelLabel?: string;
  /**
   * Scripted responses returned in order; cycles modulo length when exhausted.
   * String entries become `{ text, tokensIn: prompt.length, tokensOut: text.length }`.
   * Function entries get the full execute() input and may return either a string
   * (token counts derived) or a full IProviderExecuteOutput.
   * If omitted, a deterministic echo response is generated.
   */
  responses?: ReadonlyArray<MockResponse>;
  /** Toggle healthCheck() return value. */
  healthy?: boolean;
}

export class MockProvider implements IProvider {
  readonly id = "mock" as const;
  readonly modelLabel: string;

  private readonly _healthy: boolean;
  private readonly _responses?: ReadonlyArray<MockResponse>;
  private readonly _calls: IProviderExecuteInput[] = [];

  constructor(opts: MockProviderOptions = {}) {
    this.modelLabel = opts.modelLabel ?? "mock-default";
    this._healthy = opts.healthy ?? true;
    this._responses = opts.responses;
  }

  get callCount(): number {
    return this._calls.length;
  }

  get calls(): readonly IProviderExecuteInput[] {
    return this._calls;
  }

  async healthCheck(): Promise<boolean> {
    return this._healthy;
  }

  async execute(input: IProviderExecuteInput): Promise<IProviderExecuteOutput> {
    const callIndex = this._calls.length;
    this._calls.push(input);

    if (this._responses && this._responses.length > 0) {
      const slot = callIndex % this._responses.length;
      const r = this._responses[slot];
      if (r !== undefined) {
        return resolveResponse(r, input);
      }
    }

    const text = echoText(input);
    return {
      text,
      tokensIn: input.prompt.length,
      tokensOut: text.length,
    };
  }
}

function echoText(input: IProviderExecuteInput): string {
  const ctx = input.context ? `|ctx:${input.context}` : "";
  const cap = input.maxTokens !== undefined ? `|cap:${input.maxTokens}` : "";
  return `mock:${input.prompt}${ctx}${cap}`;
}

function resolveResponse(
  r: MockResponse,
  input: IProviderExecuteInput,
): IProviderExecuteOutput {
  if (typeof r === "string") {
    return {
      text: r,
      tokensIn: input.prompt.length,
      tokensOut: r.length,
    };
  }
  const result = r(input);
  if (typeof result === "string") {
    return {
      text: result,
      tokensIn: input.prompt.length,
      tokensOut: result.length,
    };
  }
  return result;
}
