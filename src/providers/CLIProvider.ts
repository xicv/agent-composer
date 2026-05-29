// Wave 1 F1.2 — IProvider that shells out to a CLI (default target: `agy`).
//
// CRITICAL: uses child_process.execFile (array args), NEVER child_process.exec
// or any shell-interpolated path — see plan §4 + §9.5 risk matrix. Prompt
// is appended as the LAST positional argument so quoting/backticks in the
// prompt cannot break out into the shell.

import { spawn } from "node:child_process";
import type {
  IProvider,
  IProviderExecuteInput,
  IProviderExecuteOutput,
  ProviderId,
} from "./IProvider.js";

export interface ExecFileResult {
  stdout: string;
  stderr: string;
}

export type ExecFileFn = (
  file: string,
  args: ReadonlyArray<string>,
  options: { maxBuffer?: number; timeout?: number },
) => Promise<ExecFileResult>;

// Default executor uses spawn (not execFile) so we can explicitly ignore
// stdin. Some CLIs (notably `agy --print`) hang forever waiting on stdin
// when launched from a non-TTY parent if stdin is inherited.
const DEFAULT_EXEC: ExecFileFn = (file, args, options) =>
  new Promise((resolve, reject) => {
    const maxBuffer = options.maxBuffer ?? 32 * 1024 * 1024;
    const timeoutMs = options.timeout;

    const child = spawn(file, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let bufferExceeded = false;

    const timer =
      typeof timeoutMs === "number" && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, timeoutMs)
        : null;

    const checkBuffer = (kind: "stdout" | "stderr", payload: string) => {
      if (payload.length > maxBuffer) {
        bufferExceeded = true;
        child.kill("SIGTERM");
      } else if (kind === "stdout") {
        stdout = payload;
      } else {
        stderr = payload;
      }
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      checkBuffer("stdout", stdout + chunk.toString());
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      checkBuffer("stderr", stderr + chunk.toString());
    });

    child.once("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.once("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        return reject(
          new Error(`CLIProvider: '${file}' timed out after ${timeoutMs}ms`),
        );
      }
      if (bufferExceeded) {
        return reject(
          new Error(`CLIProvider: '${file}' exceeded maxBuffer ${maxBuffer}`),
        );
      }
      if (code !== 0) {
        return reject(
          new Error(
            `CLIProvider: '${file}' exited code=${code} signal=${signal ?? "none"}; stderr: ${stderr.slice(0, 500)}`,
          ),
        );
      }
      resolve({ stdout, stderr });
    });
  });

export interface CLIProviderOptions {
  /** argv array: [binary, ...staticArgs]. Prompt is appended at runtime. */
  cli: ReadonlyArray<string>;
  /** Optional human-readable model label; defaults to the binary name. */
  model?: string;
  timeoutMs?: number;
  maxBuffer?: number;
  /** Retry attempts on transient failure (timeout / empty / rate-limit). Default 2. */
  retries?: number;
  /** Override execFile for tests. */
  execFn?: ExecFileFn;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000; // 5 min — matches tdd_plan.md §6 per-experiment budget cap.
const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024; // 32 MB.
const DEFAULT_RETRIES = 2; // agy/CLI agents occasionally "time out waiting for response" — retry transient failures.

export class CLIProvider implements IProvider {
  readonly id: ProviderId = "cli";
  readonly modelLabel: string;

  private readonly argv: ReadonlyArray<string>;
  private readonly exec: ExecFileFn;
  private readonly timeoutMs: number;
  private readonly maxBuffer: number;
  private readonly retries: number;

  constructor(opts: CLIProviderOptions) {
    if (!opts.cli || opts.cli.length === 0) {
      throw new Error("CLIProvider: cli argv must contain at least 1 element (binary path)");
    }
    this.argv = opts.cli;
    const bin = opts.cli[0] ?? "cli";
    this.modelLabel = opts.model ?? bin;
    this.exec = opts.execFn ?? DEFAULT_EXEC;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
    this.retries = opts.retries ?? DEFAULT_RETRIES;
  }

  async healthCheck(): Promise<boolean> {
    // Spawning the binary just to probe would block. Caller is expected
    // to verify the binary exists on PATH at startup.
    return true;
  }

  async execute(
    input: IProviderExecuteInput,
  ): Promise<IProviderExecuteOutput> {
    const fullPrompt = input.context
      ? `Context:\n${input.context}\n\nTask:\n${input.prompt}`
      : input.prompt;

    const [bin, ...staticArgs] = this.argv;
    if (!bin) {
      throw new Error("CLIProvider: argv missing binary");
    }
    const args = [...staticArgs, fullPrompt];

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const { stdout } = await this.exec(bin, args, {
          maxBuffer: this.maxBuffer,
          timeout: this.timeoutMs,
        });
        if (CLIProvider.isTransientFailure(stdout)) {
          lastError = new Error(
            `CLIProvider: '${bin}' transient failure on attempt ${attempt + 1}: ${stdout.trim().slice(0, 200)}`,
          );
          continue;
        }
        return { text: stdout };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }
    throw (
      lastError ??
      new Error(`CLIProvider: '${bin}' failed after ${this.retries + 1} attempts`)
    );
  }

  /** Output signalling a retryable transient failure (timeout / rate-limit / empty). */
  static isTransientFailure(stdout: string): boolean {
    return /timed out waiting for response|rate limit|temporarily unavailable|ECONNRESET|overloaded|503\b/i.test(
      stdout,
    );
  }
}
