import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createComposerServer } from "../../src/server.js";
import { ProviderRegistry } from "../../src/registry.js";
import { parseConfig } from "../../src/config/loader.js";
import type { ComposerConfig } from "../../src/config/schema.js";
import { COMPOSER_STATE_DIR_ENV } from "../../src/util/codexLifecycleJob.js";

const config: ComposerConfig = parseConfig({
  roles: {
    researcher: { provider: "mock", model: "researcher-mock" },
    coder: { provider: "mock", model: "coder-mock" },
    reviewer: { provider: "mock", model: "reviewer-mock" },
  },
});

async function bootClient(root: string) {
  const registry = new ProviderRegistry(config);
  const server = createComposerServer(registry, { root, config });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "composer-goal-test-client", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client };
}

function textResult(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content[0]?.text ?? "";
}

describe("composer goal MCP tools", () => {
  let root: string;
  let stateDir: string;
  let previousComposerStateDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "composer-goal-mcp-"));
    stateDir = mkdtempSync(join(tmpdir(), "composer-goal-mcp-state-"));
    previousComposerStateDir = process.env[COMPOSER_STATE_DIR_ENV];
    process.env[COMPOSER_STATE_DIR_ENV] = stateDir;
  });

  afterEach(() => {
    if (previousComposerStateDir === undefined) delete process.env[COMPOSER_STATE_DIR_ENV];
    else process.env[COMPOSER_STATE_DIR_ENV] = previousComposerStateDir;
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("starts, reads, and steps a goal while status stays read-only", async () => {
    const { client } = await bootClient(root);

    const started = JSON.parse(textResult(await client.callTool({
      name: "composer_goal_start",
      arguments: {
        objective: "ship goal tool",
        condition: "check passes",
        checks: [{ name: "unit", command: "true" }],
      },
    })));
    expect(started.state).toBe("active");
    expect(started.turns).toBe(0);
    expect(started.nextAction).toMatchObject({ tool: "composer_route_decide", reason: "begin" });

    const status = JSON.parse(textResult(await client.callTool({
      name: "composer_goal_status",
      arguments: { goalId: started.goalId },
    })));
    expect(status.state).toBe("active");
    expect(status.turns).toBe(0);

    const statusAgain = JSON.parse(textResult(await client.callTool({
      name: "composer_goal_status",
      arguments: { goalId: started.goalId },
    })));
    expect(statusAgain.turns).toBe(0);

    const pending = JSON.parse(textResult(await client.callTool({
      name: "composer_goal_step",
      arguments: { goalId: started.goalId },
    })));
    expect(pending.state).toBe("active");
    expect(pending.turns).toBe(1);
    expect(pending.nextAction).toMatchObject({
      tool: "composer_goal_status",
      reason: "1 check(s) pending: unit - run the declared check command(s) yourself and report results via signals.checkResults",
    });
    expect(pending.nextAction).not.toHaveProperty("args");
    expect(JSON.stringify(pending.nextAction)).not.toContain("true");

    const stepped = JSON.parse(textResult(await client.callTool({
      name: "composer_goal_step",
      arguments: {
        goalId: started.goalId,
        signals: { checkResults: [{ name: "unit", passed: true }] },
      },
    })));
    expect(stepped.state).toBe("achieved");
    expect(stepped.turns).toBe(2);
    expect(stepped.nextAction).toMatchObject({
      tool: "none",
      reason: "condition met",
    });
  });

  it("reports the actual clear outcome for active and achieved goals", async () => {
    const { client } = await bootClient(root);

    const active = JSON.parse(textResult(await client.callTool({
      name: "composer_goal_start",
      arguments: {
        objective: "cancel active",
        condition: "clear reports cancelled",
      },
    })));

    const cancelled = JSON.parse(textResult(await client.callTool({
      name: "composer_goal_clear",
      arguments: { goalId: active.goalId },
    })));
    expect(cancelled).toMatchObject({
      goalId: active.goalId,
      state: "cancelled",
      changed: true,
    });

    const achieving = JSON.parse(textResult(await client.callTool({
      name: "composer_goal_start",
      arguments: {
        objective: "clear achieved",
        condition: "check passes",
        checks: [{ name: "unit", command: "true" }],
      },
    })));
    const achieved = JSON.parse(textResult(await client.callTool({
      name: "composer_goal_step",
      arguments: {
        goalId: achieving.goalId,
        signals: { checkResults: [{ name: "unit", passed: true }] },
      },
    })));
    expect(achieved.state).toBe("achieved");

    const unchanged = JSON.parse(textResult(await client.callTool({
      name: "composer_goal_clear",
      arguments: { goalId: achieving.goalId },
    })));
    expect(unchanged).toMatchObject({
      goalId: achieving.goalId,
      state: "achieved",
      changed: false,
    });
  });

  it("passes spentUsd through composer_goal_step and blocks when maxCost is reached", async () => {
    const { client } = await bootClient(root);

    const started = JSON.parse(textResult(await client.callTool({
      name: "composer_goal_start",
      arguments: {
        objective: "watch budget",
        condition: "stay under spend cap",
        maxCost: 1,
      },
    })));

    const stepped = JSON.parse(textResult(await client.callTool({
      name: "composer_goal_step",
      arguments: {
        goalId: started.goalId,
        signals: { spentUsd: 1.25 },
      },
    })));

    expect(stepped.state).toBe("blocked");
    expect(stepped.nextAction).toMatchObject({
      tool: "composer_goal_status",
      reason: "budget/turn cap reached - extend budget (budgetExtension) or clear",
    });
  });

  it("passes conditionMet through composer_goal_step and achieves a check-less goal", async () => {
    const { client } = await bootClient(root);

    const started = JSON.parse(textResult(await client.callTool({
      name: "composer_goal_start",
      arguments: {
        objective: "judge transcript",
        condition: "condition is externally satisfied",
      },
    })));

    const stepped = JSON.parse(textResult(await client.callTool({
      name: "composer_goal_step",
      arguments: {
        goalId: started.goalId,
        signals: { conditionMet: true },
      },
    })));

    expect(stepped.state).toBe("achieved");
    expect(stepped.nextAction).toMatchObject({
      tool: "none",
      reason: "condition met",
    });
  });

  it("declares composer_goal_step as advisory and closed-world", async () => {
    const { client } = await bootClient(root);

    const listed = await client.listTools();
    const step = listed.tools.find((tool) => tool.name === "composer_goal_step");

    expect(step?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(step?.description).toContain("does NOT execute anything");
    expect(step?.description).toContain("returning the next recommended action");
  });
});
