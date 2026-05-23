import { describe, it, expect } from "vitest";
import { MockProvider } from "../../src/providers/MockProvider.js";

describe("MockProvider", () => {
  it("has id 'mock' (narrowed from ProviderId union)", () => {
    const p = new MockProvider();
    expect(p.id).toBe("mock");
  });

  it("uses 'mock-default' modelLabel when none supplied", () => {
    const p = new MockProvider();
    expect(p.modelLabel).toBe("mock-default");
  });

  it("modelLabel override is honored", () => {
    const p = new MockProvider({ modelLabel: "test-v1" });
    expect(p.modelLabel).toBe("test-v1");
  });

  it("healthCheck() resolves true by default", async () => {
    const p = new MockProvider();
    await expect(p.healthCheck()).resolves.toBe(true);
  });

  it("healthCheck() resolves false when healthy=false", async () => {
    const p = new MockProvider({ healthy: false });
    await expect(p.healthCheck()).resolves.toBe(false);
  });

  it("execute() returns deterministic text including the prompt", async () => {
    const p = new MockProvider();
    const out = await p.execute({ prompt: "hello" });
    expect(out.text).toContain("hello");
    expect(out.tokensIn).toBe(5);
    expect(out.tokensOut).toBeGreaterThan(0);
  });

  it("execute() appends context fragment when context provided", async () => {
    const p = new MockProvider();
    const out = await p.execute({ prompt: "p", context: "ctx-payload" });
    expect(out.text).toContain("ctx-payload");
  });

  it("tracks call count and full input args", async () => {
    const p = new MockProvider();
    await p.execute({ prompt: "one" });
    await p.execute({ prompt: "two", maxTokens: 100 });
    expect(p.callCount).toBe(2);
    expect(p.calls[0]?.prompt).toBe("one");
    expect(p.calls[1]?.maxTokens).toBe(100);
  });

  it("serves scripted string responses in order", async () => {
    const p = new MockProvider({ responses: ["scripted-A", "scripted-B"] });
    expect((await p.execute({ prompt: "x" })).text).toBe("scripted-A");
    expect((await p.execute({ prompt: "y" })).text).toBe("scripted-B");
  });

  it("cycles scripted responses (modulo) when exhausted", async () => {
    const p = new MockProvider({ responses: ["only-one"] });
    expect((await p.execute({ prompt: "x" })).text).toBe("only-one");
    expect((await p.execute({ prompt: "y" })).text).toBe("only-one");
  });

  it("supports function responses that receive the input", async () => {
    const p = new MockProvider({
      responses: [(input) => `prompt-was-${input.prompt}`],
    });
    expect((await p.execute({ prompt: "abc" })).text).toBe("prompt-was-abc");
  });

  it("function response can return full IProviderExecuteOutput object", async () => {
    const p = new MockProvider({
      responses: [() => ({ text: "x", tokensIn: 100, tokensOut: 200 })],
    });
    await expect(p.execute({ prompt: "y" })).resolves.toEqual({
      text: "x",
      tokensIn: 100,
      tokensOut: 200,
    });
  });
});
