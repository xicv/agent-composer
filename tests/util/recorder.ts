// Wave 1 F1.12 — tape harness for record/replay against real providers.
//
// Default mode (replay): TapeProvider reads a JSON tape and serves the
// recorded { input → output } pairs in order. A mismatch between the
// recorded prompt and the runtime prompt throws — guarantees that
// recorded fixtures stay relevant.
//
// Record mode: RecordingProvider wraps a real IProvider, forwards every
// execute() call, captures the round-trip, then `flush()` writes the
// tape. Used by Day-2 (F1.1 AnthropicCompatibleProvider, F1.2 CLIProvider)
// to capture ONE real call each, then frozen.

import fs from "node:fs";
import path from "node:path";
import type {
  IProvider,
  IProviderExecuteInput,
  IProviderExecuteOutput,
  ProviderId,
} from "../../src/providers/IProvider.js";

export interface TapeEntry {
  input: IProviderExecuteInput;
  output: IProviderExecuteOutput;
}

export class TapeMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TapeMismatchError";
  }
}

export class TapeExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TapeExhaustedError";
  }
}

export class TapeProvider implements IProvider {
  readonly id: ProviderId = "mock";
  readonly modelLabel: string;
  private readonly entries: ReadonlyArray<TapeEntry>;
  private cursor = 0;

  constructor(tape: ReadonlyArray<TapeEntry>, modelLabel = "tape") {
    this.entries = tape;
    this.modelLabel = modelLabel;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async execute(
    input: IProviderExecuteInput,
  ): Promise<IProviderExecuteOutput> {
    const entry = this.entries[this.cursor];
    if (entry === undefined) {
      throw new TapeExhaustedError(
        `Tape exhausted at cursor ${this.cursor} (length ${this.entries.length}). Re-record with RECORD=1.`,
      );
    }
    if (entry.input.prompt !== input.prompt) {
      throw new TapeMismatchError(
        `Tape mismatch at cursor ${this.cursor}: expected prompt ${JSON.stringify(entry.input.prompt)}, got ${JSON.stringify(input.prompt)}`,
      );
    }
    this.cursor++;
    return entry.output;
  }
}

export class RecordingProvider implements IProvider {
  readonly id: ProviderId;
  readonly modelLabel: string;
  private readonly inner: IProvider;
  private readonly tapePath: string;
  private readonly entries: TapeEntry[] = [];

  constructor(inner: IProvider, tapePath: string) {
    this.inner = inner;
    this.id = inner.id;
    this.modelLabel = inner.modelLabel;
    this.tapePath = tapePath;
  }

  async healthCheck(): Promise<boolean> {
    return this.inner.healthCheck();
  }

  async execute(
    input: IProviderExecuteInput,
  ): Promise<IProviderExecuteOutput> {
    const output = await this.inner.execute(input);
    this.entries.push({ input, output });
    return output;
  }

  flush(): void {
    fs.mkdirSync(path.dirname(this.tapePath), { recursive: true });
    fs.writeFileSync(
      this.tapePath,
      JSON.stringify(this.entries, null, 2) + "\n",
    );
  }
}

export function loadTape(tapePath: string): TapeEntry[] {
  if (!fs.existsSync(tapePath)) {
    throw new Error(
      `Tape not found at ${tapePath}. Run with RECORD=1 against a real provider to create it.`,
    );
  }
  const raw = fs.readFileSync(tapePath, "utf8");
  return JSON.parse(raw) as TapeEntry[];
}

export function wrapWithRecorder(
  inner: IProvider,
  tapePath: string,
  record: boolean,
): IProvider {
  if (record) return new RecordingProvider(inner, tapePath);
  return new TapeProvider(loadTape(tapePath), inner.modelLabel);
}
