import { describe, expect, it } from "vitest";
import {
  ccTokensFromModelUsage,
  observedRoute,
  parseArgs,
  parseClaudeStream,
  routeHonored,
  routePrompt,
} from "../../evals/scripts/route-compare.js";
import type { EvalTask } from "./schema.js";

const task: EvalTask = {
  id: "t",
  class: "cross-file-refactor",
  prompt: "Implement the thing.",
  expect: { outputContains: ["thing"], dispatchSequence: ["coder"] },
};

describe("route-compare helpers", () => {
  it("parses route compare CLI args", () => {
    const args = parseArgs([
      "--routes",
      "cc-only,composer-codex-cli",
      "--task",
      "t8-csv-module",
      "--runs",
      "3",
      "--model",
      "haiku",
      "--budget-usd",
      "0.25",
      "--skip-typecheck",
    ]);
    expect(args.routes).toEqual(["cc-only", "composer-codex-cli"]);
    expect(args.taskFilter).toBe("t8-csv-module");
    expect(args.runs).toBe(3);
    expect(args.model).toBe("haiku");
    expect(args.budgetUsd).toBe(0.25);
    expect(args.skipTypecheck).toBe(true);
  });

  it("builds route-specific prompt guards", () => {
    expect(routePrompt("cc-only", task)).toContain("Do not use Composer");
    expect(routePrompt("composer-glm-chain", task)).toContain("composer_code_chain");
    expect(routePrompt("composer-glm-chain", task)).toContain("Do not use mcp__composer__composer_code_cli");
    expect(routePrompt("composer-codex-cli", task)).toContain("composer_code_cli");
  });

  it("parses Claude stream-json tool uses and result", () => {
    const stream = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "mcp__composer__composer_code_cli", input: { prompt: "x" } },
          ],
        },
      }),
      JSON.stringify({
        type: "result",
        result: "done",
        modelUsage: {
          sonnet: {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadInputTokens: 20,
            cacheCreationInputTokens: 1,
          },
        },
      }),
    ].join("\n");
    const parsed = parseClaudeStream(stream);
    expect(parsed.toolUses[0]?.name).toBe("mcp__composer__composer_code_cli");
    expect(parsed.final?.result).toBe("done");
    expect(ccTokensFromModelUsage(parsed.final?.modelUsage)).toBe(36);
    expect(observedRoute(parsed.toolUses)).toBe("composer-codex-cli");
    expect(routeHonored("composer-codex-cli", observedRoute(parsed.toolUses), parsed.toolUses)).toBe(true);
    expect(routeHonored("cc-only", observedRoute(parsed.toolUses), parsed.toolUses)).toBe(false);
  });
});
