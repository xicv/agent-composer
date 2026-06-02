import { describe, expect, it } from "vitest";

import { computeHintFromHookInput } from "../../src/cli/dispatch-hint.js";

describe("computeHintFromHookInput", () => {
  it("classifies valid PreToolUse JSON", () => {
    const hint = computeHintFromHookInput(JSON.stringify({
      tool_name: "Task",
      tool_input: {
        subagent_type: "coder",
        description: "refactor",
        prompt: "Refactor src/server.ts architecture across multi-file tests/server.test.ts",
      },
    }));

    expect(hint.recommendDispatch).toBe(true);
    expect(hint.tier).toBe("premium");
    expect(hint.promptSize).toBe("full");
    expect(hint.signals.hasFileRef).toBe(true);
  });

  it("returns a neutral hint for empty stdin", () => {
    const hint = computeHintFromHookInput("");

    expect(hint.recommendDispatch).toBe(false);
    expect(hint.tier).toBe("cheap");
    expect(hint.promptSize).toBe("lite");
    expect(hint.reasoning).toBe("none");
  });

  it("returns a neutral hint for malformed JSON", () => {
    const hint = computeHintFromHookInput("{nope");

    expect(hint.recommendDispatch).toBe(false);
    expect(hint.tier).toBe("cheap");
    expect(hint.promptSize).toBe("lite");
    expect(hint.reasoning).toBe("none");
  });

  it("returns a neutral hint when tool_input is missing", () => {
    const hint = computeHintFromHookInput(JSON.stringify({ tool_name: "Task" }));

    expect(hint.recommendDispatch).toBe(false);
    expect(hint.tier).toBe("cheap");
    expect(hint.promptSize).toBe("lite");
    expect(hint.reasoning).toBe("none");
  });
});
