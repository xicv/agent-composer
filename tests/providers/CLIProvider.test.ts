import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  CLIProvider,
  type ExecFileFn,
} from "../../src/providers/CLIProvider.js";
import { TapeProvider, loadTape } from "../util/recorder.js";

describe("CLIProvider (execFile injected)", () => {
  function makeExec(stdout: string, stderr = "", capture: Array<{ bin: string; args: ReadonlyArray<string> }> = []): ExecFileFn {
    return (async (bin: string, args: ReadonlyArray<string>) => {
      capture.push({ bin, args: [...args] });
      return { stdout, stderr };
    }) as ExecFileFn;
  }

  it("has id 'cli' and modelLabel defaulting to binary name", () => {
    const p = new CLIProvider({ cli: ["agy", "-p"], execFn: makeExec("") });
    expect(p.id).toBe("cli");
    expect(p.modelLabel).toBe("agy");
  });

  it("custom modelLabel honored", () => {
    const p = new CLIProvider({
      cli: ["agy", "-p"],
      model: "gemini-3.1",
      execFn: makeExec(""),
    });
    expect(p.modelLabel).toBe("gemini-3.1");
  });

  it("throws on empty argv", () => {
    expect(() => new CLIProvider({ cli: [], execFn: makeExec("") })).toThrow(
      /at least 1/,
    );
  });

  it("healthCheck returns true (does not spawn)", async () => {
    const p = new CLIProvider({ cli: ["agy"], execFn: makeExec("") });
    await expect(p.healthCheck()).resolves.toBe(true);
  });

  it("execute() spawns the binary with static args + prompt as LAST arg", async () => {
    const captured: Array<{ bin: string; args: ReadonlyArray<string> }> = [];
    const p = new CLIProvider({
      cli: ["agy", "--dangerously-skip-permissions", "-p"],
      execFn: makeExec("agy reply text", "", captured),
    });
    const out = await p.execute({ prompt: "what is 2+2?" });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.bin).toBe("agy");
    expect(captured[0]?.args).toEqual([
      "--dangerously-skip-permissions",
      "-p",
      "what is 2+2?",
    ]);
    expect(out.text).toBe("agy reply text");
  });

  it("execute() prepends context block when provided", async () => {
    const captured: Array<{ bin: string; args: ReadonlyArray<string> }> = [];
    const p = new CLIProvider({
      cli: ["agy", "-p"],
      execFn: makeExec("ok", "", captured),
    });
    await p.execute({ prompt: "T", context: "C" });
    const lastArg = captured[0]?.args[captured[0]!.args.length - 1] ?? "";
    expect(lastArg).toContain("Context:");
    expect(lastArg).toContain("C");
    expect(lastArg).toContain("Task:");
    expect(lastArg).toContain("T");
  });

  it("execute() returns stdout verbatim as text", async () => {
    const p = new CLIProvider({
      cli: ["agy", "-p"],
      execFn: makeExec("line1\nline2\n"),
    });
    const out = await p.execute({ prompt: "x" });
    expect(out.text).toBe("line1\nline2\n");
  });

  it("execute() passes timeout + maxBuffer to execFile options", async () => {
    const optsSeen: Array<{ maxBuffer?: number; timeout?: number }> = [];
    const exec: ExecFileFn = async (_bin, _args, options) => {
      optsSeen.push(options);
      return { stdout: "", stderr: "" };
    };
    const p = new CLIProvider({
      cli: ["agy"],
      execFn: exec,
      timeoutMs: 7000,
      maxBuffer: 1024,
    });
    await p.execute({ prompt: "x" });
    expect(optsSeen[0]?.timeout).toBe(7000);
    expect(optsSeen[0]?.maxBuffer).toBe(1024);
  });

  it("execute() propagates execFile rejection", async () => {
    const exec: ExecFileFn = async () => {
      throw new Error("ENOENT");
    };
    const p = new CLIProvider({ cli: ["nonexistent-binary"], execFn: exec });
    await expect(p.execute({ prompt: "x" })).rejects.toThrow(/ENOENT/);
  });
});

describe("CLIProvider (real spawn — default execFn against node binary)", () => {
  // These exercise DEFAULT_EXEC, the spawn-based closure that ships in
  // production. Without these the spawn closure has 0 coverage (every
  // other test injects a fake execFn). `node` is virtually always on
  // PATH; the scripts are inline so no temp files are required.

  it("captures stdout from a node -e script", async () => {
    const p = new CLIProvider({
      cli: ["node", "-e", "process.stdout.write('hello-real-spawn')"],
    });
    const out = await p.execute({ prompt: "" });
    expect(out.text).toContain("hello-real-spawn");
  });

  it("rejects when child exits non-zero (stderr included in error)", async () => {
    const p = new CLIProvider({
      cli: [
        "node",
        "-e",
        "process.stderr.write('boom'); process.exit(2)",
      ],
    });
    await expect(p.execute({ prompt: "" })).rejects.toThrow(/exited code=2/);
  });

  it("rejects with 'timed out' when child runs past timeout", async () => {
    const p = new CLIProvider({
      cli: ["node", "-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 300,
    });
    await expect(p.execute({ prompt: "" })).rejects.toThrow(/timed out/);
  });

  it("rejects with ENOENT when binary missing", async () => {
    const p = new CLIProvider({
      cli: ["/definitely/not/a/real/binary-xyz"],
    });
    await expect(p.execute({ prompt: "" })).rejects.toThrow();
  });

  it("enforces maxBuffer when stdout exceeds limit", async () => {
    const p = new CLIProvider({
      cli: [
        "node",
        "-e",
        "for (let i = 0; i < 1000; i++) process.stdout.write('x'.repeat(1000))",
      ],
      maxBuffer: 1024,
    });
    await expect(p.execute({ prompt: "" })).rejects.toThrow(/maxBuffer|exited/);
  });
});

const CLI_TAPE = path.resolve("tests/fixtures/tapes/cli-agy.json");

describe("CLIProvider (replay against recorded agy tape)", () => {
  it.skipIf(!fs.existsSync(CLI_TAPE))(
    "TapeProvider replays the captured agy reply",
    async () => {
      const tape = loadTape(CLI_TAPE);
      expect(tape.length).toBeGreaterThanOrEqual(1);
      const first = tape[0]!;
      const tp = new TapeProvider(tape, "agy");
      const replay = await tp.execute({ prompt: first.input.prompt });
      expect(replay.text).toBe(first.output.text);
    },
  );
});
