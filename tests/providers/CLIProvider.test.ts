import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  CLIProvider,
  type ExecFileFn,
} from "../../src/providers/CLIProvider.js";
import { TapeProvider, loadTape } from "../util/recorder.js";

describe("CLIProvider (execFile injected)", () => {
  type CapturedExec = {
    bin: string;
    args: ReadonlyArray<string>;
    options: { cwd?: string; maxBuffer?: number; timeout?: number };
  };

  function makeExec(stdout: string, stderr = "", capture: CapturedExec[] = []): ExecFileFn {
    return (async (bin: string, args: ReadonlyArray<string>, options) => {
      capture.push({ bin, args: [...args], options });
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

  it("refuses explicitly unsandboxed codex exec configs by default", () => {
    const previous = process.env["COMPOSER_ALLOW_DANGEROUS_CODEX"];
    delete process.env["COMPOSER_ALLOW_DANGEROUS_CODEX"];
    try {
      expect(
        () =>
          new CLIProvider({
            cli: ["codex", "exec", "--sandbox", "danger-full-access"],
            execFn: makeExec(""),
          }),
      ).toThrow(/unsafe Codex exec sandbox/);
      expect(
        () =>
          new CLIProvider({
            cli: ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox"],
            execFn: makeExec(""),
          }),
      ).toThrow(/unsafe Codex exec sandbox/);
      expect(
        () =>
          new CLIProvider({
            cli: [
              "codex",
              "--search",
              "--ask-for-approval",
              "never",
              "exec",
              "--sandbox",
              "danger-full-access",
            ],
            execFn: makeExec(""),
          }),
      ).toThrow(/unsafe Codex exec sandbox/);
      expect(
        () =>
          new CLIProvider({
            cli: ["codex", "exec", "--sandbox=danger-full-access"],
            execFn: makeExec(""),
          }),
      ).toThrow(/unsafe Codex exec sandbox/);
      expect(
        () =>
          new CLIProvider({
            cli: ["npx", "-y", "@openai/codex", "exec", "--sandbox=danger-full-access"],
            execFn: makeExec(""),
          }),
      ).toThrow(/unsafe Codex exec sandbox/);
    } finally {
      if (previous === undefined) delete process.env["COMPOSER_ALLOW_DANGEROUS_CODEX"];
      else process.env["COMPOSER_ALLOW_DANGEROUS_CODEX"] = previous;
    }
  });

  it("healthCheck returns true (does not spawn)", async () => {
    const p = new CLIProvider({ cli: ["agy"], execFn: makeExec("") });
    await expect(p.healthCheck()).resolves.toBe(true);
  });

  it("execute() spawns the binary with static args + prompt as LAST arg", async () => {
    const captured: CapturedExec[] = [];
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

  it("supports codex exec as a CLI executor preset", async () => {
    const captured: CapturedExec[] = [];
    const p = new CLIProvider({
      cli: ["codex", "exec", "--sandbox", "workspace-write"],
      model: "codex-cli",
      execFn: makeExec("codex summary", "", captured),
    });
    const out = await p.execute({ prompt: "edit src/server.ts" });
    expect(p.modelLabel).toBe("codex-cli");
    expect(captured[0]?.bin).toBe("codex");
    expect(captured[0]?.args.slice(0, 3)).toEqual(["exec", "--sandbox", "workspace-write"]);
    expect(captured[0]?.args).toContain("--output-last-message");
    expect(captured[0]?.args[captured[0]!.args.length - 1]).toBe("edit src/server.ts");
    expect(out.text).toBe("codex summary");
  });

  it("injects -C for codex exec when projectDir is set", async () => {
    const captured: CapturedExec[] = [];
    const p = new CLIProvider({
      cli: ["codex", "exec", "--sandbox", "workspace-write"],
      model: "codex-cli",
      execFn: makeExec("codex summary", "", captured),
    });
    await p.execute({ prompt: "edit src/server.ts", projectDir: "/target/project" });
    expect(captured[0]?.args.slice(0, 5)).toEqual([
      "-C",
      "/target/project",
      "exec",
      "--sandbox",
      "workspace-write",
    ]);
    expect(captured[0]?.options.cwd).toBeUndefined();
  });

  it("forces read-only sandbox for advisory codex exec calls", async () => {
    const captured: CapturedExec[] = [];
    const p = new CLIProvider({
      cli: ["codex", "exec", "--sandbox", "workspace-write"],
      model: "codex-cli",
      execFn: makeExec("codex review", "", captured),
    });
    await p.execute({
      prompt: "review src/server.ts",
      projectDir: "/target/project",
      readOnly: true,
    });
    expect(captured[0]?.args.slice(0, 5)).toEqual([
      "-C",
      "/target/project",
      "exec",
      "--sandbox",
      "read-only",
    ]);
  });

  it("does not duplicate codex -C when already present", async () => {
    const captured: CapturedExec[] = [];
    const p = new CLIProvider({
      cli: ["codex", "-C", "/configured/project", "exec", "--sandbox", "workspace-write"],
      model: "codex-cli",
      execFn: makeExec("codex summary", "", captured),
    });
    await p.execute({ prompt: "edit src/server.ts", projectDir: "/target/project" });
    expect(captured[0]?.args.filter((arg) => arg === "-C")).toHaveLength(1);
    expect(captured[0]?.args.slice(0, 4)).toEqual([
      "-C",
      "/configured/project",
      "exec",
      "--sandbox",
      "workspace-write",
    ].slice(0, 4));
  });

  it("injects -m for codex exec when model is set", async () => {
    const captured: CapturedExec[] = [];
    const p = new CLIProvider({
      cli: ["codex", "exec", "--sandbox", "workspace-write"],
      model: "codex-cli",
      execFn: makeExec("codex summary", "", captured),
    });
    await p.execute({ prompt: "edit src/server.ts", model: "gpt-5.4-mini" });
    const args = captured[0]?.args ?? [];
    const modelIndex = args.indexOf("-m");
    expect(modelIndex).toBeGreaterThanOrEqual(0);
    expect(args[modelIndex + 1]).toBe("gpt-5.4-mini");
    expect(modelIndex).toBeLessThan(args.indexOf("exec"));
  });

  it("does not override an explicitly configured codex model", async () => {
    const captured: CapturedExec[] = [];
    const p = new CLIProvider({
      cli: ["codex", "-m", "gpt-5", "exec", "--sandbox", "workspace-write"],
      model: "codex-cli",
      execFn: makeExec("codex summary", "", captured),
    });
    await p.execute({ prompt: "edit src/server.ts", model: "gpt-5.4-mini" });
    const args = captured[0]?.args ?? [];
    expect(args.filter((arg) => arg === "-m")).toHaveLength(1);
    expect(args[args.indexOf("-m") + 1]).toBe("gpt-5");
    expect(args).not.toContain("gpt-5.4-mini");
  });

  it("does not inject -m for non-codex binaries", async () => {
    const captured: CapturedExec[] = [];
    const p = new CLIProvider({
      cli: ["agy", "-p"],
      execFn: makeExec("agy summary", "", captured),
    });
    await p.execute({ prompt: "edit src/server.ts", model: "gpt-5.4-mini" });
    expect(captured[0]?.args).not.toContain("-m");
  });

  it("keeps configured codex -C on the hardened exec path", async () => {
    const captured: CapturedExec[] = [];
    const p = new CLIProvider({
      cli: ["codex", "-C", "/configured/project", "exec", "--sandbox", "workspace-write"],
      model: "codex-cli",
      execFn: makeExec("codex review", "", captured),
    });
    await p.execute({ prompt: "review", readOnly: true });
    expect(captured[0]?.options.cwd).toBeUndefined();
    expect(captured[0]?.args.slice(0, 5)).toEqual([
      "-C",
      "/configured/project",
      "exec",
      "--sandbox",
      "read-only",
    ]);
    expect(captured[0]?.args).toContain("--output-last-message");
  });

  it("hardens wrapped codex exec invocations", async () => {
    const captured: CapturedExec[] = [];
    const p = new CLIProvider({
      cli: ["npx", "-y", "@openai/codex", "exec", "--sandbox=workspace-write"],
      model: "codex-cli",
      execFn: makeExec("codex review", "", captured),
    });
    await p.execute({ prompt: "review", projectDir: "/target/project", readOnly: true });
    expect(captured[0]?.args.slice(0, 7)).toEqual([
      "-y",
      "@openai/codex",
      "-C",
      "/target/project",
      "exec",
      "--sandbox=read-only",
      "--output-last-message",
    ]);
  });

  it("hardens versioned wrapped codex exec invocations", async () => {
    const captured: CapturedExec[] = [];
    const p = new CLIProvider({
      cli: ["npx", "-y", "@openai/codex@0.139.0", "exec", "--sandbox=workspace-write"],
      model: "codex-cli",
      execFn: makeExec("codex review", "", captured),
    });
    await p.execute({ prompt: "review", projectDir: "/target/project", readOnly: true });
    expect(captured[0]?.args.slice(0, 7)).toEqual([
      "-y",
      "@openai/codex@0.139.0",
      "-C",
      "/target/project",
      "exec",
      "--sandbox=read-only",
      "--output-last-message",
    ]);
  });

  it("rejects read-only execution when a wrapper is not a supported codex exec", async () => {
    const p = new CLIProvider({
      cli: ["npx", "-y", "@openai/codex"],
      model: "codex-cli",
      execFn: makeExec("should not run"),
    });

    await expect(p.execute({ prompt: "review", readOnly: true })).rejects.toThrow(
      /readOnly execution requires a supported Codex exec CLI config/,
    );
  });

  it("sets spawn cwd to projectDir for non-codex binaries", async () => {
    const captured: CapturedExec[] = [];
    const p = new CLIProvider({
      cli: ["agy", "-p"],
      cwd: "/default-root",
      execFn: makeExec("ok", "", captured),
    });
    await p.execute({ prompt: "x", projectDir: "/target/project" });
    expect(captured[0]?.options.cwd).toBe("/target/project");
    expect(captured[0]?.args).toEqual(["-p", "x"]);
  });

  it("supports codex global flags before exec for web-search research", async () => {
    const captured: CapturedExec[] = [];
    const p = new CLIProvider({
      cli: [
        "codex",
        "--search",
        "--ask-for-approval",
        "never",
        "exec",
        "--sandbox",
        "read-only",
      ],
      model: "codex-search",
      execFn: makeExec("research summary", "", captured),
    });
    const out = await p.execute({ prompt: "research current MCP patterns" });
    expect(p.modelLabel).toBe("codex-search");
    expect(captured[0]?.args.slice(0, 6)).toEqual([
      "--search",
      "--ask-for-approval",
      "never",
      "exec",
      "--sandbox",
      "read-only",
    ]);
    expect(captured[0]?.args).toContain("--output-last-message");
    expect(captured[0]?.args[captured[0]!.args.length - 1]).toBe("research current MCP patterns");
    expect(out.text).toBe("research summary");
  });

  it("returns codex --output-last-message content when the file is written", async () => {
    const captured: CapturedExec[] = [];
    const exec: ExecFileFn = async (bin, args, options) => {
      captured.push({ bin, args: [...args], options });
      const flagIndex = args.indexOf("--output-last-message");
      const outputPath = args[flagIndex + 1];
      if (typeof outputPath === "string") {
        fs.writeFileSync(outputPath, "final codex summary", "utf8");
      }
      return { stdout: "{\"type\":\"event\"}\n", stderr: "" };
    };
    const p = new CLIProvider({
      cli: ["codex", "exec", "--sandbox", "workspace-write"],
      execFn: exec,
    });
    const out = await p.execute({ prompt: "change files" });
    expect(out.text).toBe("final codex summary");
    const flagIndex = captured[0]?.args.indexOf("--output-last-message") ?? -1;
    const outputPath = captured[0]?.args[flagIndex + 1];
    expect(typeof outputPath).toBe("string");
    expect(fs.existsSync(path.dirname(outputPath as string))).toBe(false);
  });

  it("execute() prepends context block when provided", async () => {
    const captured: CapturedExec[] = [];
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

  it("execute() passes cwd from input to the spawned process", async () => {
    const captured: CapturedExec[] = [];
    const p = new CLIProvider({
      cli: ["agy", "-p"],
      cwd: "/default-root",
      execFn: makeExec("ok", "", captured),
    });
    await p.execute({ prompt: "x", cwd: "/project-root" });
    expect(captured[0]?.options.cwd).toBe("/project-root");
  });

  it("execute() returns stdout verbatim as text", async () => {
    const p = new CLIProvider({
      cli: ["agy", "-p"],
      execFn: makeExec("line1\nline2\n"),
    });
    const out = await p.execute({ prompt: "x" });
    expect(out.text).toBe("line1\nline2\n");
  });

  it("execute() leaves small stdout unchanged when result bounding is enabled by default", async () => {
    const stdout = "small worker result\n";
    const p = new CLIProvider({
      cli: ["agy", "-p"],
      execFn: makeExec(stdout),
    });

    const out = await p.execute({ prompt: "x" });

    expect(out.text).toBe(stdout);
  });

  it("execute() bounds stdout larger than maxResultChars before returning text", async () => {
    const stdout = Array.from(
      { length: 400 },
      (_, index) => `worker-line-${index} ${"x".repeat(60)}`,
    ).join("\n");
    const p = new CLIProvider({
      cli: ["agy", "-p"],
      execFn: makeExec(stdout),
      maxResultChars: 16_000,
    });

    const out = await p.execute({ prompt: "x" });

    expect(out.text.length).toBeLessThan(stdout.length);
    expect(out.text).toContain("… [elided ");
    expect(out.text).toMatch(/elided \d+ chars \/ \d+ lines/);
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

  it("prepareArgs injects -c model_reasoning_effort=high for codex exec", () => {
    const args = ["exec", "--sandbox", "workspace-write"];
    const result = CLIProvider.prepareArgs("codex", args, "prompt", { reasoningEffort: "high" });
    result.cleanup();
    const joined = result.args.join(" ");
    expect(joined).toContain("-c model_reasoning_effort=high");
    expect(result.args.indexOf("-c")).toBeLessThan(result.args.indexOf("exec"));
  });

  it("prepareArgs injects -s workspace-write for codex exec when sandbox set and not readOnly", () => {
    const args = ["exec", "--sandbox", "workspace-write"];
    const result = CLIProvider.prepareArgs("codex", args, "prompt", { sandbox: "workspace-write" });
    result.cleanup();
    // The existing --sandbox workspace-write in staticArgs is already present, so findSandboxValue returns it
    // and no second -s is injected. Test with a config that has NO sandbox in staticArgs:
    const args2 = ["exec"];
    const result2 = CLIProvider.prepareArgs("codex", args2, "prompt", { sandbox: "workspace-write" });
    result2.cleanup();
    expect(result2.args).toContain("-s");
    expect(result2.args[result2.args.indexOf("-s") + 1]).toBe("workspace-write");
  });

  it("prepareArgs does NOT inject -s when sandbox set but readOnly=true (readOnly wins)", () => {
    const args = ["exec"];
    const result = CLIProvider.prepareArgs("codex", args, "prompt", { sandbox: "workspace-write", readOnly: true });
    result.cleanup();
    // readOnly forces read-only via forceCodexReadOnlySandbox — sandbox from profile is NOT injected
    expect(result.args).not.toContain("workspace-write");
    // But read-only sandbox IS present
    expect(result.args.join(" ")).toContain("read-only");
  });

  it("prepareArgs does not inject -c or -s for non-codex binaries", () => {
    const args = ["-p"];
    const result = CLIProvider.prepareArgs("agy", args, "prompt", { reasoningEffort: "high", sandbox: "workspace-write" });
    result.cleanup();
    expect(result.args).not.toContain("-c");
    expect(result.args).not.toContain("-s");
    expect(result.args).not.toContain("model_reasoning_effort=high");
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

describe("CLIProvider (real spawn — AbortSignal escalation wiring)", () => {
  it("rejects when AbortSignal is already aborted before spawn", async () => {
    const ac = new AbortController();
    ac.abort();
    const p = new CLIProvider({
      cli: ["node", "-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 10_000,
    });
    await expect(p.execute({ prompt: "", signal: ac.signal })).rejects.toThrow();
  });

  it("rejects when AbortSignal fires after spawn starts", async () => {
    const ac = new AbortController();
    const p = new CLIProvider({
      cli: ["node", "-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 10_000,
    });
    const execPromise = p.execute({ prompt: "", signal: ac.signal });
    // Let the child start, then abort.
    await new Promise<void>((r) => setTimeout(r, 50));
    ac.abort();
    await expect(execPromise).rejects.toThrow();
  });
});

describe("CLIProvider retry-on-transient", () => {
  function makeFlakyExec(
    outcomes: Array<{ throw?: string; stdout?: string }>,
  ): { fn: ExecFileFn; calls: () => number } {
    let i = 0;
    const fn = (async () => {
      const o = outcomes[Math.min(i, outcomes.length - 1)]!;
      i++;
      if (o.throw) throw new Error(o.throw);
      return { stdout: o.stdout ?? "", stderr: "" };
    }) as ExecFileFn;
    return { fn, calls: () => i };
  }

  it("retries after a thrown error and returns the next success", async () => {
    const { fn, calls } = makeFlakyExec([
      { throw: "CLIProvider: 'agy' timed out after 1000ms" },
      { stdout: "review ok" },
    ]);
    const p = new CLIProvider({ cli: ["agy", "-p"], retries: 2, execFn: fn });
    const out = await p.execute({ prompt: "review" });
    expect(out.text).toBe("review ok");
    expect(calls()).toBe(2);
  });

  it("retries when stdout signals a transient failure (agy timeout)", async () => {
    const { fn, calls } = makeFlakyExec([
      { stdout: "Error: timed out waiting for response" },
      { stdout: "VERDICT: FAIL — TS2322" },
    ]);
    const p = new CLIProvider({ cli: ["agy", "-p"], retries: 2, execFn: fn });
    const out = await p.execute({ prompt: "review" });
    expect(out.text).toContain("TS2322");
    expect(calls()).toBe(2);
  });

  it("throws after exhausting retries when every attempt is transient", async () => {
    const { fn, calls } = makeFlakyExec([{ stdout: "rate limit exceeded" }]);
    const p = new CLIProvider({ cli: ["agy", "-p"], retries: 1, execFn: fn });
    await expect(p.execute({ prompt: "x" })).rejects.toThrow(/transient/i);
    expect(calls()).toBe(2); // 1 + 1 retry
  });

  it("does not retry a clean success", async () => {
    const { fn, calls } = makeFlakyExec([{ stdout: "clean output" }]);
    const p = new CLIProvider({ cli: ["agy", "-p"], retries: 2, execFn: fn });
    const out = await p.execute({ prompt: "x" });
    expect(out.text).toBe("clean output");
    expect(calls()).toBe(1);
  });

  it("isTransientFailure detects known patterns, ignores normal output", () => {
    expect(CLIProvider.isTransientFailure("timed out waiting for response")).toBe(true);
    expect(CLIProvider.isTransientFailure("503 Service overloaded")).toBe(true);
    expect(CLIProvider.isTransientFailure("VERDICT: PASS")).toBe(false);
    expect(CLIProvider.isTransientFailure("")).toBe(false);
  });
});
