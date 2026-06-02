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
  });

  it("does not dispatch tiny destructive prompts", () => {
    const hint = classifyDispatch({ prompt: "rm -rf node_modules" });

    expect(hint.recommendDispatch).toBe(false);
    expect(hint.signals.hasDestructive).toBe(true);
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
  });

  it("uses premium tier for security-sensitive prompts", () => {
    const hint = classifyDispatch({ prompt: "audit auth token handling" });

    expect(hint.tier).toBe("premium");
  });

  it("detects arrow functions as code", () => {
    const hint = classifyDispatch({ prompt: "update mapper: value => value.trim()" });

    expect(hint.signals.hasCode).toBe(true);
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
