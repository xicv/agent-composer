import { describe, expect, it } from "vitest";

import {
  buildWorkerPrompt,
  classifyDispatch,
  type WorkerPromptParts,
} from "../../src/util/dispatchHint.js";

describe("classifyDispatch", () => {
  it("keeps a tiny rename inline with a cheap lite hint", () => {
    const hint = classifyDispatch({ prompt: "rename foo to bar" });

    expect(hint.tier).toBe("cheap");
    expect(hint.promptSize).toBe("lite");
    expect(hint.reasoning).toBe("none");
    expect(hint.recommendDispatch).toBe(false);
    expect(hint.signals.promptChars).toBe("rename foo to bar".length);
    expect(hint.signals.complexityScore).toBe(0);
    expect(hint.route.target).toBe("inline");
    expect(hint.route.taskClass).toBe("trivial");
  });

  it("dispatches multi-file architecture refactors with premium full sizing", () => {
    const hint = classifyDispatch({
      prompt: [
        "Refactor the src/server.ts and tests/server.test.ts architecture.",
        "This is a multi-file migration that changes module boundaries.",
      ].join("\n"),
    });

    expect(hint.tier).toBe("premium");
    expect(hint.promptSize).toBe("full");
    expect(hint.reasoning).toBe("high");
    expect(hint.recommendDispatch).toBe(true);
    expect(hint.signals.hasFileRef).toBe(true);
    expect(hint.signals.complexityScore).toBeGreaterThanOrEqual(0.6);
    expect(hint.route.target).toBe("composer-code-cli");
    expect(hint.route.taskClass).toBe("cross-file-code");
    expect(hint.route.providerRole).toBe("coderCli");
    expect(hint.route.requiresReview).toBe(true);
  });

  it("does not dispatch tiny destructive prompts", () => {
    const hint = classifyDispatch({ prompt: "rm -rf node_modules" });

    expect(hint.recommendDispatch).toBe(false);
    expect(hint.signals.hasDestructive).toBe(true);
    expect(hint.route.target).toBe("refuse");
    expect(hint.route.taskClass).toBe("refuse");
  });

  it("keeps self-contained inline diff reviews inline", () => {
    const hint = classifyDispatch({
      description: "review",
      prompt: [
        "Please review this change:",
        "```diff",
        "-const port = 3000;",
        "+const port = 4000;",
        "```",
      ].join("\n"),
    });

    expect(hint.recommendDispatch).toBe(false);
    expect(hint.signals.isReviewWithInlineDiff).toBe(true);
    expect(hint.route.target).toBe("review-inline");
    expect(hint.route.taskClass).toBe("review-inline");
  });

  it("routes security-sensitive reviews through the default reviewer first", () => {
    const hint = classifyDispatch({ prompt: "audit auth token handling" });

    expect(hint.tier).toBe("cheap");
    expect(hint.route.target).toBe("task-reviewer");
    expect(hint.route.providerRole).toBe("reviewer");
  });

  it("uses premium reviewer only when explicitly requested", () => {
    const hint = classifyDispatch({
      prompt: "Run a premium review of auth token handling.",
    });

    expect(hint.tier).toBe("premium");
    expect(hint.route.target).toBe("composer-review-claude");
    expect(hint.route.providerRole).toBe("reviewerClaude");
  });

  it("detects arrow functions as code", () => {
    const hint = classifyDispatch({ prompt: "update mapper: value => value.trim()" });

    expect(hint.signals.hasCode).toBe(true);
  });

  it("routes research-first implementation through researcher then coder", () => {
    const hint = classifyDispatch({
      prompt: "Research exponential backoff with jitter, then implement retry(fn, opts) in src/_eval/retry.ts.",
    });

    expect(hint.recommendDispatch).toBe(true);
    expect(hint.promptSize).toBe("full");
    expect(hint.route.target).toBe("task-researcher-coder");
    expect(hint.route.taskClass).toBe("research-first-code");
    expect(hint.route.requiresReview).toBe(true);
  });

  it("keeps small bug explanations inline", () => {
    const hint = classifyDispatch({
      prompt: "Find the bug: `[10,2,1].sort()` returns wrong numeric order. Explain the fix.",
    });

    expect(hint.recommendDispatch).toBe(false);
    expect(hint.route.target).toBe("inline");
    expect(hint.route.taskClass).toBe("bug-explain");
  });

  describe("Oracle planning lane", () => {
    it("routes [oracle:plan] to synchronous oracle plan (sync default)", () => {
      const hint = classifyDispatch({
        prompt: "[oracle:plan] design the new auth module",
      });

      expect(hint.route.target).toBe("composer-oracle-plan");
      expect(hint.route.providerRole).toBe("oraclePlanner");
      expect(hint.route.taskClass).toBe("oracle-plan");
      expect(hint.tier).toBe("premium");
      expect(hint.recommendDispatch).toBe(true);
      expect(hint.promptSize).toBe("full");
    });

    it("routes [oracle:quick] to the synchronous oracle plan tool", () => {
      const hint = classifyDispatch({
        prompt: "[oracle:quick] what flag flips strategy?",
      });

      expect(hint.route.target).toBe("composer-oracle-plan");
      expect(hint.route.providerRole).toBe("oraclePlanner");
    });

    it("routes [oracle:review] to synchronous oracle plan (short mode)", () => {
      const hint = classifyDispatch({
        prompt: "[oracle:review] audit this diff",
      });

      expect(hint.route.target).toBe("composer-oracle-plan");
      expect(hint.route.providerRole).toBe("oraclePlanner");
    });

    it("routes [oracle:research] to async job-start (research always async)", () => {
      const hint = classifyDispatch({
        prompt: "[oracle:research] explore distributed tracing options for our stack",
      });

      expect(hint.route.target).toBe("composer-oracle-job-start");
      expect(hint.route.providerRole).toBe("oraclePlanner");
    });

    it("routes [oracle:deep] with short prompt to synchronous oracle plan", () => {
      const hint = classifyDispatch({
        prompt: "[oracle:deep] analyze the retry strategy",
      });

      expect(hint.route.target).toBe("composer-oracle-plan");
      expect(hint.route.providerRole).toBe("oraclePlanner");
    });

    it("routes [oracle:plan] with explicit async request to async job-start", () => {
      const hint = classifyDispatch({
        prompt: "[oracle:plan] design X — don't block, run in the background",
      });

      expect(hint.route.target).toBe("composer-oracle-job-start");
      expect(hint.route.providerRole).toBe("oraclePlanner");
    });

    it("routes [oracle:async] bare marker to async job-start as standard mode", () => {
      const hint = classifyDispatch({
        prompt: "[oracle:async] design X",
      });

      expect(hint.route.target).toBe("composer-oracle-job-start");
      expect(hint.route.providerRole).toBe("oraclePlanner");
      expect(hint.route.taskClass).toBe("oracle-plan");
    });

    it("routes a very large [oracle:plan] prompt (>6000 chars) to async job-start", () => {
      const bigBody = "x".repeat(6100);
      const hint = classifyDispatch({
        prompt: `[oracle:plan] design the migration — ${bigBody}`,
      });

      expect(hint.route.target).toBe("composer-oracle-job-start");
      expect(hint.route.providerRole).toBe("oraclePlanner");
    });

    it("does NOT route a plain prompt without oracle marker to oracle targets", () => {
      const hint = classifyDispatch({
        prompt: "implement a helper in src/util/foo.ts",
      });

      expect(hint.route.target).toBe("composer-code-cli");
      expect(hint.route.target).not.toBe("composer-oracle-plan");
      expect(hint.route.target).not.toBe("composer-oracle-job-start");
    });
  });
});

describe("buildWorkerPrompt", () => {
  const fullParts: WorkerPromptParts = {
    objective: "Refactor the provider",
    files: ["src/providers/CLIProvider.ts"],
    constraints: ["Do not change IProvider output shape"],
    acceptance: ["npx tsc --noEmit passes"],
    brief: "Use the existing utility module style.",
  };

  it("omits constraints, acceptance, and brief for lite prompts", () => {
    const hint = classifyDispatch({ prompt: "rename foo to bar" });

    const prompt = buildWorkerPrompt(hint, fullParts);

    expect(prompt).toContain("Objective:");
    expect(prompt).toContain("Refactor the provider");
    expect(prompt).toContain("Files:");
    expect(prompt).toContain("src/providers/CLIProvider.ts");
    expect(prompt).not.toContain("Constraints:");
    expect(prompt).not.toContain("Acceptance:");
    expect(prompt).not.toContain("Brief:");
  });

  it("includes all present sections for full prompts", () => {
    const hint = classifyDispatch({
      prompt: "Refactor src/index.ts architecture across multi-file boundaries",
    });

    const prompt = buildWorkerPrompt(hint, fullParts);

    expect(prompt).toContain("Objective:");
    expect(prompt).toContain("Files:");
    expect(prompt).toContain("Constraints:");
    expect(prompt).toContain("Do not change IProvider output shape");
    expect(prompt).toContain("Acceptance:");
    expect(prompt).toContain("npx tsc --noEmit passes");
    expect(prompt).toContain("Brief:");
    expect(prompt).toContain("Use the existing utility module style.");
  });

  it("omits empty sections", () => {
    const hint = classifyDispatch({
      prompt: "Refactor src/index.ts architecture across multi-file boundaries",
    });

    const prompt = buildWorkerPrompt(hint, {
      objective: "Do the work",
      files: [],
      constraints: [],
      acceptance: [],
      brief: "",
    });

    expect(prompt).toBe("Objective:\nDo the work");
  });

  it("omits empty optional section items", () => {
    const hint = classifyDispatch({
      prompt: "Refactor src/index.ts architecture across multi-file boundaries",
    });

    const prompt = buildWorkerPrompt(hint, {
      objective: "Do the work",
      files: ["src/index.ts", ""],
      constraints: ["", "Keep contracts stable"],
      acceptance: ["  "],
      brief: " ",
    });

    expect(prompt).toBe([
      "Objective:\nDo the work",
      "Files:\n- src/index.ts",
      "Constraints:\n- Keep contracts stable",
    ].join("\n\n"));
  });

  it("does not mutate prompt parts", () => {
    const hint = classifyDispatch({
      prompt: "Refactor src/index.ts architecture across multi-file boundaries",
    });
    const parts: WorkerPromptParts = {
      objective: "Refactor the provider",
      files: ["src/providers/CLIProvider.ts"],
      constraints: ["Keep contracts stable"],
      acceptance: ["Tests pass"],
      brief: "Short context",
    };
    const before = structuredClone(parts);

    buildWorkerPrompt(hint, parts);

    expect(parts).toEqual(before);
  });
});
