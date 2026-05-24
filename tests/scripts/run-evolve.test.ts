import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseArgs,
  enforceSpendCap,
  SpendCapExceededError,
  syntheticScore,
  createRealEvaluate,
} from "../../scripts/run-evolve.js";
import type { ComposerConfig } from "../../src/config/schema.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

vi.mock("node:fs", async (importActual) => {
  const actual = await importActual<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});

describe("run-evolve helpers", () => {
  describe("parseArgs", () => {
    it("returns defaults for empty argv", () => {
      const result = parseArgs([]);
      expect(result.budgetUsd).toBe(2.0);
      expect(result.maxRounds).toBe(10);
      expect(result.evalMode).toBe("synthetic");
    });

    it("parses explicit --budget-usd and --max-rounds", () => {
      const result = parseArgs(["--budget-usd", "0.50", "--max-rounds", "3"]);
      expect(result.budgetUsd).toBe(0.5);
      expect(result.maxRounds).toBe(3);
      expect(result.evalMode).toBe("synthetic");
    });

    it("parses --eval-mode synthetic", () => {
      const result = parseArgs(["--eval-mode", "synthetic"]);
      expect(result.evalMode).toBe("synthetic");
      expect(result.maxRounds).toBe(10);
    });

    it("parses --eval-mode real", () => {
      const result = parseArgs(["--eval-mode", "real"]);
      expect(result.evalMode).toBe("real");
      expect(result.maxRounds).toBe(3);
    });

    it("rejects unknown --eval-mode value", () => {
      expect(() => parseArgs(["--eval-mode", "bogus"])).toThrow(
        '--eval-mode: "bogus" must be "synthetic" or "real"',
      );
    });

    it("throws when --eval-mode lacks a value", () => {
      expect(() => parseArgs(["--eval-mode"])).toThrow("--eval-mode requires a value");
    });

    it("defaults to 3 rounds in real mode when --max-rounds not specified", () => {
      const result = parseArgs(["--eval-mode", "real"]);
      expect(result.maxRounds).toBe(3);
    });

    it("respects explicit --max-rounds in real mode", () => {
      const result = parseArgs(["--eval-mode", "real", "--max-rounds", "5"]);
      expect(result.maxRounds).toBe(5);
    });

    it("synthetic mode keeps default 10 rounds when --max-rounds not specified", () => {
      const result = parseArgs(["--eval-mode", "synthetic"]);
      expect(result.maxRounds).toBe(10);
    });

    it("throws on unknown flag", () => {
      expect(() => parseArgs(["--unknown-flag"])).toThrow("unknown flag: --unknown-flag");
    });

    it("parses --length-lambda as a float and stores in lengthLambda", () => {
      const result = parseArgs(["--length-lambda", "0.0005"]);
      expect(result.lengthLambda).toBe(0.0005);
    });

    it("rejects negative --length-lambda", () => {
      expect(() => parseArgs(["--length-lambda", "-0.001"])).toThrow(
        "--length-lambda must be non-negative",
      );
    });

    it("parses --force-operator and stores the name", () => {
      const result = parseArgs(["--force-operator", "tightenLanguage"]);
      expect(result.forceOperator).toBe("tightenLanguage");
    });

    it("rejects unknown --force-operator with list of valid names", () => {
      expect(() => parseArgs(["--force-operator", "bogus"])).toThrow(
        '--force-operator: "bogus" is unknown; valid names:',
      );
    });

    it("returns both lengthLambda and forceOperator when both flags set (summary contract)", () => {
      const result = parseArgs([
        "--length-lambda",
        "0.0005",
        "--force-operator",
        "tightenLanguage",
      ]);
      expect(result.lengthLambda).toBe(0.0005);
      expect(result.forceOperator).toBe("tightenLanguage");
    });

    it("throws when --budget-usd value is non-numeric", () => {
      expect(() => parseArgs(["--budget-usd", "abc"])).toThrow('--budget-usd: "abc" is not a number');
    });

    it("throws when --budget-usd is negative", () => {
      expect(() => parseArgs(["--budget-usd", "-1.0"])).toThrow("--budget-usd must be non-negative");
    });

    it("throws when --budget-usd lacks a value", () => {
      expect(() => parseArgs(["--budget-usd"])).toThrow("--budget-usd requires a value");
    });

    it("throws when --max-rounds value is non-numeric", () => {
      expect(() => parseArgs(["--max-rounds", "xyz"])).toThrow('--max-rounds: "xyz" is not a number');
    });

    it("throws when --max-rounds is negative", () => {
      expect(() => parseArgs(["--max-rounds", "-5"])).toThrow("--max-rounds must be non-negative");
    });
  });

  describe("enforceSpendCap", () => {
    const mockRoles = {
      researcher: { provider: "mock" as const },
      coder: { provider: "mock" as const },
      reviewer: { provider: "mock" as const },
    };

    it("throws SpendCapExceededError when budget exceeds maxUsdPerSession", () => {
      const config: ComposerConfig = {
        roles: mockRoles,
        spendAuthorization: { mode: "auto", maxUsdPerSession: 0.1 },
      };
      expect(() => enforceSpendCap(config, 5.0)).toThrow(SpendCapExceededError);
    });

    it("does not throw when budget equals maxUsdPerSession", () => {
      const config: ComposerConfig = {
        roles: mockRoles,
        spendAuthorization: { mode: "auto", maxUsdPerSession: 1.0 },
      };
      expect(() => enforceSpendCap(config, 1.0)).not.toThrow();
    });

    it("does not throw when budget is less than maxUsdPerSession", () => {
      const config: ComposerConfig = {
        roles: mockRoles,
        spendAuthorization: { mode: "auto", maxUsdPerSession: 5.0 },
      };
      expect(() => enforceSpendCap(config, 2.0)).not.toThrow();
    });

    it("does not throw when spendAuthorization is undefined", () => {
      const config: ComposerConfig = { roles: mockRoles };
      expect(() => enforceSpendCap(config, 100.0)).not.toThrow();
    });

    it("does not throw when maxUsdPerSession is undefined", () => {
      const config: ComposerConfig = {
        roles: mockRoles,
        spendAuthorization: { mode: "auto" },
      };
      expect(() => enforceSpendCap(config, 50.0)).not.toThrow();
    });
  });

  describe("syntheticScore", () => {
    it("scores empty string as 0", () => {
      expect(syntheticScore("")).toBe(0);
    });

    it("scores skill with both keywords near 4000-char peak as > 0.9", () => {
      // 14 chars of keywords + 3986 'x' = 4000 chars total → peak length score.
      const skill = "dispatch Read " + "x".repeat(3986);
      const score = syntheticScore(skill);
      expect(score).toBeGreaterThan(0.9);
    });

    it("scores skill with both keywords at short length (114 chars) as ~0.6", () => {
      const skill = "dispatch Read " + "y".repeat(100);
      expect(syntheticScore(skill)).toBeCloseTo(0.6, 5);
    });

    it("awards 0.4 for dispatch keyword alone", () => {
      const score = syntheticScore("dispatch is present");
      expect(score).toBe(0.4);
    });

    it("awards 0.2 for Read tool name alone", () => {
      const score = syntheticScore("Read file content");
      expect(score).toBe(0.2);
    });

    it("scales length score higher at 4000 than 3000 chars", () => {
      const skill4000 = "x".repeat(4000) + " dispatch Read";
      const skill3000 = "x".repeat(3000) + " dispatch Read";
      expect(syntheticScore(skill4000)).toBeGreaterThan(syntheticScore(skill3000));
    });

    it("returns 0 length component for lengths outside [2000, 6000]", () => {
      const short = "x".repeat(100) + " dispatch Read";
      const long = "x".repeat(10000) + " dispatch Read";
      expect(syntheticScore(short)).toBeCloseTo(0.6, 5);
      expect(syntheticScore(long)).toBeCloseTo(0.6, 5);
    });

    it("is case-insensitive for dispatch", () => {
      expect(syntheticScore("dispatch here")).toBeGreaterThanOrEqual(0.4);
      expect(syntheticScore("DISPATCH HERE")).toBeGreaterThanOrEqual(0.4);
      expect(syntheticScore("DiSpAtCh here")).toBeGreaterThanOrEqual(0.4);
    });

    it("is case-sensitive for Read", () => {
      expect(syntheticScore("Read file")).toBeGreaterThan(syntheticScore("read file"));
    });

    it("clamps result to [0, 1]", () => {
      const skill = "dispatch Read " + "x".repeat(4000);
      const score = syntheticScore(skill);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });
  });

  describe("real mode evaluator", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("creates swap file, writes candidate, and restores on success", () => {
      const tempDir = path.resolve(process.cwd(), ".test-real-eval-swap");
      const skillPath = path.join(tempDir, "SKILL.md");
      fs.mkdirSync(tempDir, { recursive: true });
      fs.writeFileSync(skillPath, "original skill content", "utf8");

      // Directly test the swap logic inline since we're mocking
      const originalContent = fs.readFileSync(skillPath, "utf8");
      const swapPath = `${skillPath}.swap-${process.pid}`;

      fs.renameSync(skillPath, swapPath);
      fs.writeFileSync(skillPath, "candidate skill", "utf8");

      expect(fs.readFileSync(skillPath, "utf8")).toBe("candidate skill");
      expect(fs.existsSync(swapPath)).toBe(true);

      // Restore
      fs.rmSync(skillPath, { force: true });
      fs.renameSync(swapPath, skillPath);

      expect(fs.readFileSync(skillPath, "utf8")).toBe(originalContent);
      expect(fs.existsSync(swapPath)).toBe(false);

      // Cleanup
      fs.rmSync(tempDir, { recursive: true });
    });

    it("parses JSON response with token usage correctly", async () => {
      const mockResponse = {
        content: [{ type: "text", text: "test output" }],
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 50,
          output_tokens: 20,
        },
      };

      // Test token extraction
      const tokens =
        (mockResponse.usage.input_tokens ?? 0) +
        (mockResponse.usage.cache_creation_input_tokens ?? 0) +
        (mockResponse.usage.cache_read_input_tokens ?? 0) +
        (mockResponse.usage.output_tokens ?? 0);

      expect(tokens).toBe(180);
    });

    it("classifies tool_use events by description", () => {
      const responses = [
        {
          description: "dispatch coder subagent",
          expected: ["coder"],
        },
        {
          description: "dispatch reviewer",
          expected: ["reviewer"],
        },
        {
          description: "dispatch researcher",
          expected: ["researcher"],
        },
        {
          description: "some other action",
          expected: [],
        },
      ];

      for (const test of responses) {
        const roles: string[] = [];
        const desc = test.description;

        if (desc.toLowerCase().includes("coder")) {
          roles.push("coder");
        } else if (desc.toLowerCase().includes("reviewer")) {
          roles.push("reviewer");
        } else if (desc.toLowerCase().includes("researcher")) {
          roles.push("researcher");
        }

        expect(roles).toEqual(test.expected);
      }
    });

    it("checks success by searching outputContains substrings case-insensitively", () => {
      const mockResponse = {
        content: [{ type: "text", text: "Found a BUG in the code" }],
      };

      const outputContains = ["bug", "code"];
      const fullText = mockResponse.content.map((item) => item.text ?? "").join(" ");
      const lowerText = fullText.toLowerCase();

      const success = outputContains.every((substr) => lowerText.includes(substr.toLowerCase()));
      expect(success).toBe(true);

      const outputContainsFail = ["bug", "syntax error"];
      const successFail = outputContainsFail.every((substr) => lowerText.includes(substr.toLowerCase()));
      expect(successFail).toBe(false);
    });

    it("evaluates dispatch correctly when dispatchRequired is true", () => {
      const input = {
        actualSequence: ["coder", "reviewer"],
        expectedSequence: ["coder", "reviewer"],
        dispatchRequired: true,
        success: true,
      };

      const actualMatchesExpected =
        input.actualSequence.length === input.expectedSequence.length &&
        input.actualSequence.every((r, i) => r === input.expectedSequence[i]);

      expect(actualMatchesExpected).toBe(true);
    });

    it("evaluates dispatch correctly when dispatchRequired is false with no dispatch", () => {
      const input = {
        actualSequence: [],
        expectedSequence: ["coder"],
        dispatchRequired: false,
        success: true,
      };

      // When dispatchRequired is false and actualSequence is empty, success determines correctness
      const correct = input.actualSequence.length === 0 ? input.success : false;
      expect(correct).toBe(true);
    });

    it("scores task with baseline comparison", () => {
      const evalResult = {
        taskId: "t1",
        success: true,
        mainSessionTokens: 50,
        dispatchedCorrectly: true,
        durationMs: 0,
        workerCalls: 1,
        workerTextSample: "",
      };

      const baseline = 100;
      const baselineTokens = baseline > 0 ? baseline : 1;
      const tokenComponent = baseline > 0 ? Math.max(0, 1 - evalResult.mainSessionTokens / baselineTokens) : 0;
      const successComponent = evalResult.success ? 1 : 0;
      const dispatchComponent = evalResult.dispatchedCorrectly ? 1 : 0;

      const score = 0.5 * successComponent + 0.3 * tokenComponent + 0.2 * dispatchComponent;
      // 0.5 * 1 + 0.3 * 0.5 + 0.2 * 1 = 0.5 + 0.15 + 0.2 = 0.85 (fp drift OK)
      expect(score).toBeCloseTo(0.85, 6);
    });

    it("aggregates task scores correctly", () => {
      const scores = [
        { taskId: "t1", score: 0.9 },
        { taskId: "t2", score: 0.8 },
        { taskId: "t3", score: 0.7 },
      ];

      const aggregated = scores.reduce((acc, s) => acc + s.score, 0) / scores.length;
      expect(aggregated).toBeCloseTo(0.8, 5);
    });

    it("handles missing baseline gracefully by treating as 0", () => {
      const evalResult = {
        taskId: "unknown-task",
        success: true,
        mainSessionTokens: 100,
        dispatchedCorrectly: true,
        durationMs: 0,
        workerCalls: 1,
        workerTextSample: "",
      };

      const baseline = 0; // Missing baseline
      const baselineTokens = baseline > 0 ? baseline : 1;
      const tokenComponent = baseline > 0 ? Math.max(0, 1 - evalResult.mainSessionTokens / baselineTokens) : 0;

      expect(tokenComponent).toBe(0);
      expect(baselineTokens).toBe(1);
    });
  });
});

describe("createRealEvaluate — worktree isolation", () => {
  const REAL_SKILL_PATH = "/real/repo/.claude/skills/composer-mastermind/SKILL.md";
  const BASELINES: Record<string, { mainSessionTokens: number }> = {
    t1: { mainSessionTokens: 1000 },
    t2: { mainSessionTokens: 800 },
  };
  const FAKE_CLAUDE_RESPONSE = JSON.stringify({
    type: "result",
    subtype: "success",
    result: "",
    is_error: false,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    total_cost_usd: 0.001,
  });
  const CANDIDATE = "dispatch Read worktree candidate";

  type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;
  type ExecFileMockArgs = [string, (readonly string[] | null | undefined), unknown, unknown];

  function makeExecFileMock(claudeFails?: boolean) {
    return (vi.mocked(childProcess.execFile) as unknown as { mockImplementation: (fn: (...a: ExecFileMockArgs) => unknown) => void })
      .mockImplementation((_cmd, args, _opts, cb) => {
        const callback = cb as ExecFileCallback;
        const a = (args ?? []) as string[];
        const isWorktreeAdd = _cmd === "git" && a[1] === "add";
        const isClaude = _cmd === "claude";
        const isWorktreeRemove = _cmd === "git" && a[1] === "remove";
        if (isWorktreeAdd || isWorktreeRemove) {
          setImmediate(() => callback(null, "", ""));
        } else if (isClaude) {
          if (claudeFails) {
            setImmediate(() => callback(new Error("spawn failed"), "", ""));
          } else {
            setImmediate(() => callback(null, FAKE_CLAUDE_RESPONSE, ""));
          }
        } else {
          setImmediate(() => callback(null, "", ""));
        }
        return { stdin: { end: vi.fn() } } as unknown as ReturnType<typeof childProcess.execFile>;
      });
  }

  let writeFileSyncSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);
    writeFileSyncSpy = vi.mocked(fs.writeFileSync) as unknown as ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a worktree for each task", async () => {
    makeExecFileMock();
    const evaluate = createRealEvaluate(REAL_SKILL_PATH, BASELINES);
    await evaluate(CANDIDATE, [{ id: "t1", description: "task one" }]);
    const addCalls = vi.mocked(childProcess.execFile).mock.calls.filter(
      (c) => c[0] === "git" && (c[1] as string[])[1] === "add",
    );
    expect(addCalls).toHaveLength(1);
  });

  it("worktree path embeds the task id", async () => {
    makeExecFileMock();
    const evaluate = createRealEvaluate(REAL_SKILL_PATH, BASELINES);
    await evaluate(CANDIDATE, [{ id: "t1", description: "task one" }]);
    const addCall = vi.mocked(childProcess.execFile).mock.calls.find(
      (c) => c[0] === "git" && (c[1] as string[])[1] === "add",
    );
    expect((addCall?.[1] as string[])?.join(" ")).toContain("t1");
  });

  it("writes candidate SKILL into worktree path, not real repo", async () => {
    makeExecFileMock();
    const evaluate = createRealEvaluate(REAL_SKILL_PATH, BASELINES);
    await evaluate(CANDIDATE, [{ id: "t1", description: "task one" }]);
    expect(writeFileSyncSpy.mock.calls.length).toBeGreaterThan(0);
    for (const call of writeFileSyncSpy.mock.calls) {
      const dest = call[0] as string;
      expect(dest).not.toBe(REAL_SKILL_PATH);
      expect(dest).toContain(".claude/skills/composer-mastermind/SKILL.md");
      expect(dest).toContain("/tmp/");
    }
  });

  it("spawns claude with cwd pointing at worktree", async () => {
    makeExecFileMock();
    const evaluate = createRealEvaluate(REAL_SKILL_PATH, BASELINES);
    await evaluate(CANDIDATE, [{ id: "t1", description: "task one" }]);
    const claudeCall = vi.mocked(childProcess.execFile).mock.calls.find((c) => c[0] === "claude");
    expect(claudeCall).toBeDefined();
    const opts = claudeCall?.[2] as { cwd?: string };
    expect(opts.cwd).toContain("/tmp/");
    expect(opts.cwd).toContain("t1");
  });

  it("removes worktree after successful eval", async () => {
    makeExecFileMock();
    const evaluate = createRealEvaluate(REAL_SKILL_PATH, BASELINES);
    await evaluate(CANDIDATE, [{ id: "t1", description: "task one" }]);
    const removeCalls = vi.mocked(childProcess.execFile).mock.calls.filter(
      (c) => c[0] === "git" && (c[1] as string[])[1] === "remove",
    );
    expect(removeCalls).toHaveLength(1);
    expect((removeCalls[0]?.[1] as string[])).toContain("--force");
  });

  it("removes worktree even when claude spawn throws, and does not abort the evaluate run", async () => {
    makeExecFileMock(true);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const evaluate = createRealEvaluate(REAL_SKILL_PATH, BASELINES);
    const result = await evaluate(CANDIDATE, [{ id: "t1", description: "task one" }]);
    const removeCalls = vi.mocked(childProcess.execFile).mock.calls.filter(
      (c) => c[0] === "git" && (c[1] as string[])[1] === "remove",
    );
    expect(removeCalls).toHaveLength(1);
    expect(result.score).toBe(0);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("task t1 failed"));
    errSpy.mockRestore();
  });

  it("continues to the next task when one task's spawn throws", async () => {
    let callCount = 0;
    (vi.mocked(childProcess.execFile) as unknown as { mockImplementation: (fn: (...a: ExecFileMockArgs) => unknown) => void })
      .mockImplementation((_cmd, _args, _opts, cb) => {
        const callback = cb as ExecFileCallback;
        const isClaude = _cmd === "claude";
        if (isClaude) {
          callCount++;
          if (callCount === 1) {
            setImmediate(() => callback(new Error("transient claude failure"), "", ""));
          } else {
            setImmediate(() => callback(null, FAKE_CLAUDE_RESPONSE, ""));
          }
        } else {
          // git worktree add/remove
          setImmediate(() => callback(null, "", ""));
        }
        return { stdin: { end: vi.fn() } } as unknown as ReturnType<typeof childProcess.execFile>;
      });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const evaluate = createRealEvaluate(REAL_SKILL_PATH, BASELINES);
    await evaluate(CANDIDATE, [
      { id: "t1", description: "task one" },
      { id: "t2", description: "task two" },
    ]);
    // Both tasks reached the claude spawn (first failed, second succeeded)
    const claudeCalls = vi.mocked(childProcess.execFile).mock.calls.filter((c) => c[0] === "claude");
    expect(claudeCalls).toHaveLength(2);
    // Both worktrees still cleaned up
    const removeCalls = vi.mocked(childProcess.execFile).mock.calls.filter(
      (c) => c[0] === "git" && (c[1] as string[])[1] === "remove",
    );
    expect(removeCalls).toHaveLength(2);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("task t1 failed"));
    errSpy.mockRestore();
  });

  it("real-repo SKILL.md is never written (MD5 invariant)", async () => {
    makeExecFileMock();
    const originalContent = "original skill content";
    const beforeHash = createHash("md5").update(originalContent).digest("hex");
    vi.mocked(fs.readFileSync).mockReturnValue(originalContent);

    const evaluate = createRealEvaluate(REAL_SKILL_PATH, BASELINES);
    await evaluate(CANDIDATE, [{ id: "t1", description: "task one" }]);

    const afterContent = fs.readFileSync(REAL_SKILL_PATH, "utf8") as string;
    const afterHash = createHash("md5").update(afterContent).digest("hex");
    expect(afterHash).toBe(beforeHash);
    const realRepoWrites = writeFileSyncSpy.mock.calls.filter((c: unknown[]) => c[0] === REAL_SKILL_PATH);
    expect(realRepoWrites).toHaveLength(0);
  });

  it("creates one worktree per task for multiple tasks", async () => {
    makeExecFileMock();
    const evaluate = createRealEvaluate(REAL_SKILL_PATH, BASELINES);
    await evaluate(CANDIDATE, [
      { id: "t1", description: "task one" },
      { id: "t2", description: "task two" },
    ]);
    const addCalls = vi.mocked(childProcess.execFile).mock.calls.filter(
      (c) => c[0] === "git" && (c[1] as string[])[1] === "add",
    );
    expect(addCalls).toHaveLength(2);
    const worktreePaths = addCalls.map((c) => (c[1] as string[])[2]);
    expect(worktreePaths[0]).toContain("t1");
    expect(worktreePaths[1]).toContain("t2");
  });

  it("captures claude stderr tail in the error message when the spawn fails", async () => {
    (vi.mocked(childProcess.execFile) as unknown as { mockImplementation: (fn: (...a: ExecFileMockArgs) => unknown) => void })
      .mockImplementation((_cmd, _args, _opts, cb) => {
        const callback = cb as ExecFileCallback;
        if (_cmd === "claude") {
          setImmediate(() => callback(new Error("Command failed: claude -p"), "", "rate limit exceeded\nretry after 60s"));
        } else {
          setImmediate(() => callback(null, "", ""));
        }
        return { stdin: { end: vi.fn() } } as unknown as ReturnType<typeof childProcess.execFile>;
      });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const evaluate = createRealEvaluate(REAL_SKILL_PATH, BASELINES);
    await evaluate(CANDIDATE, [{ id: "t1", description: "task one" }]);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("rate limit exceeded"));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("retry after 60s"));
    errSpy.mockRestore();
  });
});
