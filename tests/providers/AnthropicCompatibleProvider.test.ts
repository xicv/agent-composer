import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  AnthropicCompatibleProvider,
  type AnthropicLike,
} from "../../src/providers/AnthropicCompatibleProvider.js";
import { TapeProvider, loadTape } from "../util/recorder.js";

function makeFakeClient(): {
  client: AnthropicLike;
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn();
  return {
    create,
    client: { messages: { create } },
  };
}

describe("AnthropicCompatibleProvider (DI client mocked)", () => {
  let factoryCalls: Array<{ baseURL: string; apiKey: string }>;
  let create: ReturnType<typeof vi.fn>;
  let fakeClient: AnthropicLike;

  beforeEach(() => {
    factoryCalls = [];
    const f = makeFakeClient();
    create = f.create;
    fakeClient = f.client;
  });

  function buildProvider(model = "glm-4.6"): AnthropicCompatibleProvider {
    return new AnthropicCompatibleProvider({
      baseUrl: "https://test.example/api/anthropic",
      apiKey: "test-key-abc",
      model,
      clientFactory: (opts) => {
        factoryCalls.push(opts);
        return fakeClient;
      },
    });
  }

  it("has id 'anthropic' and modelLabel from opts", () => {
    const p = buildProvider("custom-model");
    expect(p.id).toBe("anthropic");
    expect(p.modelLabel).toBe("custom-model");
  });

  it("constructor forwards baseUrl + apiKey to clientFactory", () => {
    buildProvider();
    expect(factoryCalls).toEqual([
      { baseURL: "https://test.example/api/anthropic", apiKey: "test-key-abc" },
    ]);
  });

  it("throws when baseUrl missing", () => {
    expect(
      () =>
        new AnthropicCompatibleProvider({
          baseUrl: "",
          apiKey: "k",
          model: "m",
          clientFactory: () => fakeClient,
        }),
    ).toThrow(/baseUrl required/);
  });

  it("throws when apiKey missing", () => {
    expect(
      () =>
        new AnthropicCompatibleProvider({
          baseUrl: "https://x",
          apiKey: "",
          model: "m",
          clientFactory: () => fakeClient,
        }),
    ).toThrow(/apiKey required/);
  });

  it("throws when model missing", () => {
    expect(
      () =>
        new AnthropicCompatibleProvider({
          baseUrl: "https://x",
          apiKey: "k",
          model: "",
          clientFactory: () => fakeClient,
        }),
    ).toThrow(/model required/);
  });

  it("healthCheck returns true after construction", async () => {
    await expect(buildProvider().healthCheck()).resolves.toBe(true);
  });

  it("execute() forwards prompt + maxTokens to messages.create", async () => {
    create.mockResolvedValue({
      content: [{ type: "text", text: "OK" }],
      usage: { input_tokens: 5, output_tokens: 1 },
    });
    const p = buildProvider();
    const out = await p.execute({ prompt: "hello", maxTokens: 99 });

    expect(create).toHaveBeenCalledTimes(1);
    const params = create.mock.calls[0]?.[0];
    expect(params).toMatchObject({
      model: "glm-4.6",
      max_tokens: 99,
    });
    expect(out.text).toBe("OK");
    expect(out.tokensIn).toBe(5);
    expect(out.tokensOut).toBe(1);
  });

  it("execute() defaults max_tokens to 4096 when not provided", async () => {
    create.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const p = buildProvider();
    await p.execute({ prompt: "p" });
    const params = create.mock.calls[0]?.[0];
    expect(params?.max_tokens).toBe(4096);
  });

  it("execute() prepends context as a separate text block", async () => {
    create.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const p = buildProvider();
    await p.execute({ prompt: "p", context: "CTX-PAYLOAD" });
    const params = create.mock.calls[0]?.[0];
    const userMsg = params?.messages?.[0];
    const flat = JSON.stringify(userMsg);
    expect(flat).toContain("CTX-PAYLOAD");
    expect(flat).toContain("Context:");
  });

  it("execute() joins multiple text blocks in the response", async () => {
    create.mockResolvedValue({
      content: [
        { type: "text", text: "Part A. " },
        { type: "text", text: "Part B." },
        { type: "tool_use", id: "x", name: "y" },
      ],
      usage: { input_tokens: 10, output_tokens: 10 },
    });
    const p = buildProvider();
    const out = await p.execute({ prompt: "x" });
    expect(out.text).toBe("Part A. Part B.");
  });

  it("execute() forwards thinking block when type=enabled", async () => {
    create.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const p = new AnthropicCompatibleProvider({
      baseUrl: "https://x",
      apiKey: "k",
      model: "glm-5.1",
      defaultMaxTokens: 65536,
      thinking: { type: "enabled", budgetTokens: 32768 },
      clientFactory: () => fakeClient,
    });
    await p.execute({ prompt: "p" });
    const params = create.mock.calls[0]?.[0];
    expect(params?.thinking).toEqual({ type: "enabled", budget_tokens: 32768 });
    expect(params?.max_tokens).toBe(65536);
  });

  it("execute() omits thinking block when not configured", async () => {
    create.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const p = buildProvider();
    await p.execute({ prompt: "p" });
    const params = create.mock.calls[0]?.[0];
    expect(params?.thinking).toBeUndefined();
  });

  it("constructor rejects thinking budget below SDK minimum (1024)", () => {
    expect(
      () =>
        new AnthropicCompatibleProvider({
          baseUrl: "https://x",
          apiKey: "k",
          model: "glm-5.1",
          defaultMaxTokens: 16384,
          thinking: { type: "enabled", budgetTokens: 512 },
          clientFactory: () => fakeClient,
        }),
    ).toThrow(/budgetTokens must be >=1024/);
  });

  it("constructor rejects thinking budget >= max_tokens", () => {
    expect(
      () =>
        new AnthropicCompatibleProvider({
          baseUrl: "https://x",
          apiKey: "k",
          model: "glm-5.1",
          defaultMaxTokens: 4096,
          thinking: { type: "enabled", budgetTokens: 4096 },
          clientFactory: () => fakeClient,
        }),
    ).toThrow(/must be less than max_tokens/);
  });
});

const ANTHROPIC_TAPE = path.resolve(
  "tests/fixtures/tapes/anthropic-glm.json",
);

describe("AnthropicCompatibleProvider (replay against recorded GLM tape)", () => {
  it.skipIf(!fs.existsSync(ANTHROPIC_TAPE))(
    "TapeProvider replays the captured response shape",
    async () => {
      const tape = loadTape(ANTHROPIC_TAPE);
      expect(tape.length).toBeGreaterThanOrEqual(1);
      const first = tape[0]!;
      expect(typeof first.output.text).toBe("string");
      expect(first.output.text.length).toBeGreaterThan(0);
      const tp = new TapeProvider(tape, "glm-4.6");
      const replay = await tp.execute({ prompt: first.input.prompt });
      expect(replay.text).toBe(first.output.text);
      expect(replay.tokensIn).toBeDefined();
      expect(replay.tokensOut).toBeDefined();
    },
  );
});
