import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { loadEnvJson, applyEnvJson, getEnv } from "../../src/config/env.js";

function tmpEnv(content: string): string {
  const p = path.join(os.tmpdir(), `composer-env-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, content);
  return p;
}

describe("loadEnvJson", () => {
  it("returns empty object when file missing", () => {
    expect(
      loadEnvJson("/tmp/nonexistent-env-xyz.json"),
    ).toEqual({});
  });

  it("returns empty object when JSON malformed", () => {
    const p = tmpEnv("{ not json");
    try {
      expect(loadEnvJson(p)).toEqual({});
    } finally {
      fs.unlinkSync(p);
    }
  });

  it("returns empty object when value is not an object", () => {
    const p = tmpEnv("[1, 2, 3]");
    try {
      expect(loadEnvJson(p)).toEqual({});
    } finally {
      fs.unlinkSync(p);
    }
  });

  it("returns only string-typed known keys", () => {
    const p = tmpEnv(
      JSON.stringify({
        ANTHROPIC_AUTH_TOKEN: "tok-123",
        ANTHROPIC_BASE_URL: "https://x.test",
        ANTHROPIC_MODEL: "glm-5.1",
        EXTRA_KEY: "ignored",
        WRONG_TYPE: 42,
      }),
    );
    try {
      expect(loadEnvJson(p)).toEqual({
        ANTHROPIC_AUTH_TOKEN: "tok-123",
        ANTHROPIC_BASE_URL: "https://x.test",
        ANTHROPIC_MODEL: "glm-5.1",
      });
    } finally {
      fs.unlinkSync(p);
    }
  });

  it("omits ANTHROPIC_MODEL when missing from file", () => {
    const p = tmpEnv(
      JSON.stringify({
        ANTHROPIC_AUTH_TOKEN: "tok",
        ANTHROPIC_BASE_URL: "https://x",
      }),
    );
    try {
      const env = loadEnvJson(p);
      expect(env.ANTHROPIC_MODEL).toBeUndefined();
    } finally {
      fs.unlinkSync(p);
    }
  });
});

describe("applyEnvJson", () => {
  let stash: { token?: string; baseUrl?: string; model?: string };
  beforeEach(() => {
    stash = {
      token: process.env["ANTHROPIC_AUTH_TOKEN"],
      baseUrl: process.env["ANTHROPIC_BASE_URL"],
      model: process.env["ANTHROPIC_MODEL"],
    };
    delete process.env["ANTHROPIC_AUTH_TOKEN"];
    delete process.env["ANTHROPIC_BASE_URL"];
    delete process.env["ANTHROPIC_MODEL"];
  });
  afterEach(() => {
    if (stash.token === undefined) delete process.env["ANTHROPIC_AUTH_TOKEN"];
    else process.env["ANTHROPIC_AUTH_TOKEN"] = stash.token;
    if (stash.baseUrl === undefined) delete process.env["ANTHROPIC_BASE_URL"];
    else process.env["ANTHROPIC_BASE_URL"] = stash.baseUrl;
    if (stash.model === undefined) delete process.env["ANTHROPIC_MODEL"];
    else process.env["ANTHROPIC_MODEL"] = stash.model;
  });

  it("sets process.env when missing (incl. ANTHROPIC_MODEL)", () => {
    const p = tmpEnv(
      JSON.stringify({
        ANTHROPIC_AUTH_TOKEN: "from-file",
        ANTHROPIC_BASE_URL: "https://from.file",
        ANTHROPIC_MODEL: "glm-5.1",
      }),
    );
    try {
      applyEnvJson(p);
      expect(process.env["ANTHROPIC_AUTH_TOKEN"]).toBe("from-file");
      expect(process.env["ANTHROPIC_BASE_URL"]).toBe("https://from.file");
      expect(process.env["ANTHROPIC_MODEL"]).toBe("glm-5.1");
    } finally {
      fs.unlinkSync(p);
    }
  });

  it("does NOT overwrite existing process.env", () => {
    process.env["ANTHROPIC_AUTH_TOKEN"] = "pre-existing";
    const p = tmpEnv(
      JSON.stringify({ ANTHROPIC_AUTH_TOKEN: "from-file" }),
    );
    try {
      applyEnvJson(p);
      expect(process.env["ANTHROPIC_AUTH_TOKEN"]).toBe("pre-existing");
    } finally {
      fs.unlinkSync(p);
    }
  });
});

describe("getEnv", () => {
  it("reads from process.env (not from disk)", () => {
    process.env["ANTHROPIC_AUTH_TOKEN"] = "runtime-token";
    process.env["ANTHROPIC_BASE_URL"] = "https://runtime";
    process.env["ANTHROPIC_MODEL"] = "glm-5.1";
    try {
      expect(getEnv()).toEqual({
        ANTHROPIC_AUTH_TOKEN: "runtime-token",
        ANTHROPIC_BASE_URL: "https://runtime",
        ANTHROPIC_MODEL: "glm-5.1",
      });
    } finally {
      delete process.env["ANTHROPIC_AUTH_TOKEN"];
      delete process.env["ANTHROPIC_BASE_URL"];
      delete process.env["ANTHROPIC_MODEL"];
    }
  });

  it("omits keys that are absent", () => {
    delete process.env["ANTHROPIC_AUTH_TOKEN"];
    delete process.env["ANTHROPIC_BASE_URL"];
    delete process.env["ANTHROPIC_MODEL"];
    expect(getEnv()).toEqual({});
  });
});
