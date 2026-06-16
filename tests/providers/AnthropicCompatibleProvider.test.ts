import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  AnthropicCompatibleProvider,
  type AnthropicLike,
} from "../../src/providers/AnthropicCompatibleProvider.js";
import { TapeProvider, loadTape } from "../util/recorder.js";

function makeFakeClient(): {
  client: AnthropicLike;
  stream: ReturnType<typeof vi.fn>;
} {
  const stream = vi.fn().mockReturnValue({
    finalMessage: () => Promise.resolve({
      content: [{ type: "text", text: "" }],
      usage: { input_tokens: 0, output_tokens: 0 },
    }),
  });
  return {
    stream,
    client: { messages: { stream } },
  };
}

function setStreamResult(
  stream: ReturnType<typeof vi.fn>,
  result: { content: Array<{ type: string; text?: string; id?: string; name?: string }>; usage: { input_tokens: number; output_tokens: number } },
): void {
  stream.mockReturnValue({ finalMessage: () => Promise.resolve(result) });
}

describe("AnthropicCompatibleProvider (DI client mocked)", () => {
  let factoryCalls: Array<{ baseURL: string; apiKey: string }>;
  let stream: ReturnType<typeof vi.fn>;
  let fakeClient: AnthropicLike;

  beforeEach(() => {
    factoryCalls = [];
    const f = makeFakeClient();
    stream = f.stream;
    fakeClient = f.client;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function buildProvider(
    model = "glm-4.6",
    opts: { timeoutMs?: number } = {},
  ): AnthropicCompatibleProvider {
    return new AnthropicCompatibleProvider({
      baseUrl: "https://test.example/api/anthropic",
      apiKey: "test-key-abc",
      model,
      ...opts,
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

  it("throws when timeoutMs is not positive", () => {
    expect(
      () =>
        new AnthropicCompatibleProvider({
          baseUrl: "https://x",
          apiKey: "k",
          model: "m",
          timeoutMs: 0,
          clientFactory: () => fakeClient,
        }),
    ).toThrow(/timeoutMs must be a positive finite number/);
  });

  it("healthCheck returns true after construction", async () => {
    await expect(buildProvider().healthCheck()).resolves.toBe(true);
  });

  it("execute() forwards prompt + maxTokens to messages.stream", async () => {
    setStreamResult(stream, {
      content: [{ type: "text", text: "OK" }],
      usage: { input_tokens: 5, output_tokens: 1 },
    });
    const p = buildProvider();
    const out = await p.execute({ prompt: "hello", maxTokens: 99 });

    expect(stream).toHaveBeenCalledTimes(1);
    const params = stream.mock.calls[0]?.[0];
    expect(params).toMatchObject({
      model: "glm-4.6",
      max_tokens: 99,
    });
    expect(out.text).toBe("OK");
    expect(out.tokensIn).toBe(5);
    expect(out.tokensOut).toBe(1);
  });

  it("execute() defaults max_tokens to 4096 when not provided", async () => {
    setStreamResult(stream, {
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const p = buildProvider();
    await p.execute({ prompt: "p" });
    const params = stream.mock.calls[0]?.[0];
    expect(params?.max_tokens).toBe(4096);
  });

  it("execute() prepends context as a separate text block", async () => {
    setStreamResult(stream, {
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const p = buildProvider();
    await p.execute({ prompt: "p", context: "CTX-PAYLOAD" });
    const params = stream.mock.calls[0]?.[0];
    const userMsg = params?.messages?.[0];
    const flat = JSON.stringify(userMsg);
    expect(flat).toContain("CTX-PAYLOAD");
    expect(flat).toContain("Context:");
  });

  it("execute() joins multiple text blocks in the response", async () => {
    setStreamResult(stream, {
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
    setStreamResult(stream, {
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
    const params = stream.mock.calls[0]?.[0];
    expect(params?.thinking).toEqual({ type: "enabled", budget_tokens: 32768 });
    expect(params?.max_tokens).toBe(65536);
  });

  it("execute() omits thinking block when not configured", async () => {
    setStreamResult(stream, {
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const p = buildProvider();
    await p.execute({ prompt: "p" });
    const params = stream.mock.calls[0]?.[0];
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

  it("execute() passes a composed AbortSignal as 2nd arg to stream when caller provides one", async () => {
    setStreamResult(stream, {
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const controller = new AbortController();
    const { signal } = controller;
    const p = buildProvider();
    await p.execute({ prompt: "p", signal });
    expect(stream).toHaveBeenCalledTimes(1);
    const forwardedSignal = stream.mock.calls[0]?.[1]?.signal;
    expect(forwardedSignal).toBeInstanceOf(AbortSignal);
    expect(forwardedSignal).not.toBe(signal);
    expect(forwardedSignal?.aborted).toBe(false);
  });

  it("execute() passes an internally managed AbortSignal when caller provides no signal", async () => {
    setStreamResult(stream, {
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const p = buildProvider();
    await p.execute({ prompt: "p" });
    expect(stream).toHaveBeenCalledTimes(1);
    const forwardedSignal = stream.mock.calls[0]?.[1]?.signal;
    expect(forwardedSignal).toBeInstanceOf(AbortSignal);
    expect(forwardedSignal?.aborted).toBe(false);
  });

  it("execute() rejects a never-resolving finalMessage after timeoutMs and aborts the stream", async () => {
    vi.useFakeTimers();
    const abort = vi.fn();
    let forwardedSignal: AbortSignal | undefined;
    stream.mockImplementation((_params, options) => {
      forwardedSignal = options?.signal;
      return {
        abort,
        finalMessage: () => new Promise<never>(() => {}),
      };
    });

    const p = buildProvider("glm-4.6", { timeoutMs: 50 });
    const pending = p.execute({ prompt: "hang" });
    const assertion = expect(pending).rejects.toThrow(/timed out after 50ms/i);

    expect(forwardedSignal).toBeInstanceOf(AbortSignal);
    expect(forwardedSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(49);
    expect(abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await assertion;
    expect(forwardedSignal?.aborted).toBe(true);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("execute() rejects promptly when caller signal aborts before the internal timeout", async () => {
    vi.useFakeTimers();
    const abort = vi.fn();
    stream.mockReturnValue({
      abort,
      finalMessage: () => new Promise<never>(() => {}),
    });
    const controller = new AbortController();
    const p = buildProvider("glm-4.6", { timeoutMs: 10_000 });
    const pending = p.execute({ prompt: "x", signal: controller.signal });
    const assertion = expect(pending).rejects.toThrow(/caller stopped/);

    controller.abort(new Error("caller stopped"));

    await assertion;
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("propagates a timeout error from finalMessage()", async () => {
    stream.mockReturnValue({ finalMessage: () => Promise.reject(new Error("Request timed out.")) });
    const p = buildProvider();
    await expect(p.execute({ prompt: "x" })).rejects.toThrow(/timed out/i);
  });

  it("propagates an AbortError when the signal aborts", async () => {
    const abortErr = Object.assign(new Error("Request was aborted."), { name: "AbortError" });
    stream.mockReturnValue({ finalMessage: () => Promise.reject(abortErr) });
    const controller = new AbortController();
    controller.abort();
    const p = buildProvider();
    await expect(p.execute({ prompt: "x", signal: controller.signal })).rejects.toThrow(/abort/i);
    expect(stream.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("propagates a generic provider error", async () => {
    stream.mockReturnValue({
      finalMessage: () => Promise.reject(new Error("overloaded_error")),
    });
    const p = buildProvider();
    await expect(p.execute({ prompt: "x" })).rejects.toThrow(/overloaded/i);
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
