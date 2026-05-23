// Wave 1 Day 2 — .env.json loader.
//
// IMPORTANT (per CLAUDE.md): the Read tool MUST NOT open .env.json.
// This loader uses fs.readFileSync at runtime — the file is gitignored.
// Failure modes (missing file, malformed JSON, wrong types) ALL degrade
// silently to an empty env object, never throw — the registry will fail
// loud later if a required key is missing.

import fs from "node:fs";
import path from "node:path";

export interface ComposerEnv {
  ANTHROPIC_AUTH_TOKEN?: string;
  ANTHROPIC_BASE_URL?: string;
}

const DEFAULT_ENV_FILE = ".env.json";

export function loadEnvJson(envPath: string = DEFAULT_ENV_FILE): ComposerEnv {
  const resolved = path.resolve(envPath);
  if (!fs.existsSync(resolved)) return {};
  let raw: string;
  try {
    raw = fs.readFileSync(resolved, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const obj = parsed as Record<string, unknown>;
  const result: ComposerEnv = {};
  if (typeof obj["ANTHROPIC_AUTH_TOKEN"] === "string") {
    result.ANTHROPIC_AUTH_TOKEN = obj["ANTHROPIC_AUTH_TOKEN"];
  }
  if (typeof obj["ANTHROPIC_BASE_URL"] === "string") {
    result.ANTHROPIC_BASE_URL = obj["ANTHROPIC_BASE_URL"];
  }
  return result;
}

export function applyEnvJson(envPath?: string): void {
  const env = loadEnvJson(envPath);
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string" && v.length > 0 && !process.env[k]) {
      process.env[k] = v;
    }
  }
}

export function getEnv(): ComposerEnv {
  const result: ComposerEnv = {};
  const t = process.env["ANTHROPIC_AUTH_TOKEN"];
  const u = process.env["ANTHROPIC_BASE_URL"];
  if (typeof t === "string" && t.length > 0) result.ANTHROPIC_AUTH_TOKEN = t;
  if (typeof u === "string" && u.length > 0) result.ANTHROPIC_BASE_URL = u;
  return result;
}
