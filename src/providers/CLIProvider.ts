// Wave 1 F1.2 — IProvider that shells out to a CLI (default target: `agy`).
//
// CRITICAL: uses child_process.execFile (array args), NEVER child_process.exec
// or any shell-interpolated path — see plan §4 + §9.5 risk matrix. Prompt
// is appended as the LAST positional argument so quoting/backticks in the
// prompt cannot break out into the shell.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  IProvider,
  IProviderExecuteInput,
  IProviderExecuteOutput,
  ProviderId,
} from "./IProvider.js";
import { projectToolResult } from "../util/projectToolResult.js";

export interface ExecFileResult {
  stdout: string;
  stderr: string;
}

export type ExecFileFn = (
  file: string,
  args: ReadonlyArray<string>,
  options: {
    cwd?: string;
    maxBuffer?: number;
    timeout?: number;
    signal?: AbortSignal;
  },
) => Promise<ExecFileResult>;

// Default executor uses spawn (not execFile) so we can explicitly ignore
// stdin. Some CLIs (notably `agy --print`) hang forever waiting on stdin
// when launched from a non-TTY parent if stdin is inherited.
const DEFAULT_EXEC: ExecFileFn = (file, args, options) =>
  new Promise((resolve, reject) => {
    const maxBuffer = options.maxBuffer ?? 32 * 1024 * 1024;
    const timeoutMs = options.timeout;

    const child = spawn(file, [...args], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      signal: options.signal,
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
  cwd?: string;
  timeoutMs?: number;
  maxBuffer?: number;
  /** Retry attempts on transient failure (timeout / empty / rate-limit). Default 2. */
  retries?: number;
  /** Project (bound) returned text larger than this many chars. Default 16000. Set 0/Infinity-ish via large number to disable. */
  maxResultChars?: number;
  /** Override execFile for tests. */
  execFn?: ExecFileFn;
}

const DEFAULT_TIMEOUT_MS = 15 * 60_000; // Long enough for Codex apply flows, still bounded.
const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024; // 32 MB.
const DEFAULT_RETRIES = 2; // agy/CLI agents occasionally "time out waiting for response" — retry transient failures.
const DEFAULT_MAX_RESULT_CHARS = 16_000;

export class CLIProvider implements IProvider {
  readonly id: ProviderId = "cli";
  readonly modelLabel: string;

  private readonly argv: ReadonlyArray<string>;
  private readonly exec: ExecFileFn;
  private readonly cwd?: string;
  private readonly timeoutMs: number;
  private readonly maxBuffer: number;
  private readonly retries: number;
  private readonly maxResultChars: number;

  constructor(opts: CLIProviderOptions) {
    if (!opts.cli || opts.cli.length === 0) {
      throw new Error("CLIProvider: cli argv must contain at least 1 element (binary path)");
    }
    CLIProvider.assertSafeCli(opts.cli);
    this.argv = opts.cli;
    const bin = opts.cli[0] ?? "cli";
    this.modelLabel = opts.model ?? bin;
    this.exec = opts.execFn ?? DEFAULT_EXEC;
    this.cwd = opts.cwd;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
    this.retries = opts.retries ?? DEFAULT_RETRIES;
    this.maxResultChars = opts.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
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
    const baseCwd = input.cwd ?? this.cwd;

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const execution = CLIProvider.prepareArgs(bin, staticArgs, fullPrompt, {
        projectDir: input.projectDir,
        readOnly: input.readOnly,
        model: input.model,
      });
      const startedAt = Date.now();
      try {
        const { stdout } = await this.exec(bin, execution.args, {
          cwd: execution.cwd ?? baseCwd,
          maxBuffer: this.maxBuffer,
          timeout: this.timeoutMs,
          signal: input.signal,
        });
        const durationMs = Date.now() - startedAt;
        const text = execution.finalMessagePath
          ? CLIProvider.readFinalMessage(execution.finalMessagePath) ?? stdout
          : stdout;
        const transientFailure = CLIProvider.isTransientFailure(text);
        CLIProvider.logUsage({
          bin,
          model: this.modelLabel,
          durationMs,
          stdoutChars: stdout.length,
          textChars: text.length,
          attempt: attempt + 1,
          status: transientFailure ? "transient" : "success",
        });
        if (transientFailure) {
          lastError = new Error(
            `CLIProvider: '${bin}' transient failure on attempt ${attempt + 1}: ${text.trim().slice(0, 200)}`,
          );
          continue;
        }
        const bounded = this.maxResultChars > 0
          ? projectToolResult(text, { maxChars: this.maxResultChars }).text
          : text;
        return { text: bounded };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        CLIProvider.logUsage({
          bin,
          model: this.modelLabel,
          durationMs: Date.now() - startedAt,
          stdoutChars: 0,
          textChars: 0,
          attempt: attempt + 1,
          status: "error",
          error: lastError.message.slice(0, 300),
        });
      } finally {
        execution.cleanup();
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

  static prepareArgs(
    bin: string,
    staticArgs: ReadonlyArray<string>,
    prompt: string,
    options: { projectDir?: string; readOnly?: boolean; model?: string } = {},
  ): { args: string[]; cwd?: string; finalMessagePath?: string; cleanup: () => void } {
    const args = [...staticArgs];
    let tempDir: string | undefined;
    let finalMessagePath = CLIProvider.findFlagValue(args, "--output-last-message");
    let cwd: string | undefined;

    if (options.readOnly && !CLIProvider.isCodexExec(bin, args)) {
      throw new Error(
        "CLIProvider: readOnly execution requires a supported Codex exec CLI config.",
      );
    }

    if (CLIProvider.isCodexExec(bin, args)) {
      if (options.projectDir && !CLIProvider.hasCodexCd(args)) {
        args.splice(CLIProvider.codexExecCommandIndex(bin, args), 0, "-C", options.projectDir);
      }
      if (options.model && !CLIProvider.hasCodexModel(args)) {
        args.splice(CLIProvider.codexExecCommandIndex(bin, args), 0, "-m", options.model);
      }
      if (options.readOnly) {
        CLIProvider.forceCodexReadOnlySandbox(bin, args);
      }
      if (!finalMessagePath) {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "composer-codex-"));
        finalMessagePath = path.join(tempDir, "last-message.txt");
        args.push("--output-last-message", finalMessagePath);
      }
    } else if (options.projectDir) {
      cwd = options.projectDir;
    }

    args.push(prompt);
    return {
      args,
      cwd,
      finalMessagePath,
      cleanup: () => {
        if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
      },
    };
  }

  private static isCodexExec(
    bin: string,
    args: ReadonlyArray<string>,
  ): boolean {
    return CLIProvider.codexExecCommandIndex(bin, args) >= 0;
  }

  private static assertSafeCli(argv: ReadonlyArray<string>): void {
    const [bin, ...args] = argv;
    if (!bin || !CLIProvider.isCodexExec(bin, args)) return;
    if (process.env["COMPOSER_ALLOW_DANGEROUS_CODEX"] === "1") return;

    const sandbox = CLIProvider.findSandboxValue(args);
    if (
      args.includes("--dangerously-bypass-approvals-and-sandbox") ||
      sandbox === "danger-full-access"
    ) {
      throw new Error(
        "CLIProvider: refusing unsafe Codex exec sandbox. Use --sandbox workspace-write, or set COMPOSER_ALLOW_DANGEROUS_CODEX=1 only inside an external sandbox.",
      );
    }
  }

  private static logUsage(entry: {
    bin: string;
    model: string;
    durationMs: number;
    stdoutChars: number;
    textChars: number;
    attempt: number;
    status: "success" | "transient" | "error";
    error?: string;
  }): void {
    if (process.env["VITEST"]) return;
    try {
      fs.appendFileSync(
        "/tmp/composer-cli-usage.jsonl",
        JSON.stringify({
          ts: new Date().toISOString(),
          bin: path.basename(entry.bin),
          model: entry.model,
          duration_ms: entry.durationMs,
          stdout_chars: entry.stdoutChars,
          text_chars: entry.textChars,
          attempt: entry.attempt,
          status: entry.status,
          ...(entry.error ? { error: entry.error } : {}),
        }) + "\n",
      );
    } catch {
      // Best-effort telemetry; never break provider execution.
    }
  }

  private static codexExecIndex(args: ReadonlyArray<string>): number {
    const flagsWithValues = new Set([
      "-a",
      "--add-dir",
      "--ask-for-approval",
      "-C",
      "-c",
      "--cd",
      "--color",
      "--config",
      "--disable",
      "--enable",
      "-i",
      "--image",
      "--local-provider",
      "-m",
      "--model",
      "-p",
      "--profile",
      "--remote",
      "--remote-auth-token-env",
      "-s",
      "--sandbox",
    ]);

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "exec") return i;
      if (arg === "--") return -1;
      if (!arg) continue;
      if (arg.startsWith("--") && arg.includes("=")) continue;
      if (flagsWithValues.has(arg)) {
        i++;
        continue;
      }
      if (arg.startsWith("-")) continue;
      return -1;
    }
    return -1;
  }

  private static hasCodexCd(args: ReadonlyArray<string>): boolean {
    return args.some((arg) => arg === "-C" || arg === "--cd" || arg.startsWith("--cd="));
  }

  private static hasCodexModel(args: ReadonlyArray<string>): boolean {
    return args.some(
      (arg) => arg === "-m" || arg === "--model" || arg.startsWith("--model="),
    );
  }

  private static findFlagValue(
    args: ReadonlyArray<string>,
    flag: string,
  ): string | undefined {
    const index = args.indexOf(flag);
    const value = index >= 0 ? args[index + 1] : undefined;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  private static forceCodexReadOnlySandbox(bin: string, args: string[]): void {
    const equalsIndex = args.findIndex((arg) => arg.startsWith("--sandbox="));
    if (equalsIndex >= 0) {
      args[equalsIndex] = "--sandbox=read-only";
      return;
    }

    const flagIndex = args.findIndex((arg) => arg === "--sandbox" || arg === "-s");
    if (flagIndex >= 0) {
      args[flagIndex] = "--sandbox";
      args[flagIndex + 1] = "read-only";
      return;
    }

    const execIndex = CLIProvider.codexExecCommandIndex(bin, args);
    if (execIndex < 0) {
      throw new Error(
        "CLIProvider: readOnly execution requires a supported Codex exec CLI config.",
      );
    }
    args.splice(execIndex + 1, 0, "--sandbox", "read-only");
  }

  private static findSandboxValue(args: ReadonlyArray<string>): string | undefined {
    const equals = args.find((arg) => arg.startsWith("--sandbox="));
    if (equals) return equals.slice("--sandbox=".length);
    const index = args.findIndex((arg) => arg === "--sandbox" || arg === "-s");
    const value = index >= 0 ? args[index + 1] : undefined;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  private static codexExecCommandIndex(
    bin: string,
    args: ReadonlyArray<string>,
  ): number {
    if (path.basename(bin) === "codex") {
      return CLIProvider.codexExecIndex(args);
    }
    if (!CLIProvider.isCodexWrapper(bin)) return -1;
    const packageIndex = args.findIndex((arg) => CLIProvider.isCodexPackageToken(arg));
    if (packageIndex < 0) return -1;
    return args.indexOf("exec", packageIndex + 1);
  }

  private static isCodexWrapper(bin: string): boolean {
    return ["npx", "npm", "pnpm", "yarn", "bun"].includes(path.basename(bin));
  }

  private static isCodexPackageToken(arg: string): boolean {
    return (
      arg === "codex" ||
      arg.startsWith("codex@") ||
      arg === "@openai/codex" ||
      arg.startsWith("@openai/codex@")
    );
  }

  private static readFinalMessage(filePath: string): string | undefined {
    try {
      const text = fs.readFileSync(filePath, "utf8");
      return text.length > 0 ? text : undefined;
    } catch {
      return undefined;
    }
  }
}
