// Wave 1 Day 2 — .env.json loader.
//
// IMPORTANT (per CLAUDE.md): the Read tool MUST NOT open .env.json.
// This loader uses fs.readFileSync at runtime — the file is gitignored.
// Failure modes (missing file, malformed JSON, wrong types) ALL degrade
// silently to an empty env object, never throw — the registry will fail
// loud later if a required key is missing.

import fs from "node:fs";
import path from "node:path";
import { resolveConfigPath } from "./paths.js";

export interface ComposerEnv {
  ANTHROPIC_AUTH_TOKEN?: string;
  ANTHROPIC_BASE_URL?: string;
  /**
   * Wave 3 Step 4 — model identifier override for the AnthropicCompatible
   * provider. Precedence (resolved in src/registry.ts):
   *   process.env.ANTHROPIC_MODEL > composer.config.json role.model > "glm-5.2"
   */
  ANTHROPIC_MODEL?: string;
}

const DEFAULT_ENV_FILE = ".env.json";

/**
 * Reads `.env.json` via the path lookup chain (explicit > cwd > global).
 * Returns `{}` if no file in the chain exists or any parse step fails — this
 * loader is fail-silent by design (the registry surfaces missing-key errors
 * later with better context).
 */
export function loadEnvJson(envPath?: string): ComposerEnv {
  // If the caller passed an explicit path, use it directly (legacy behaviour
  // for tests that pass a synthetic path). Otherwise resolve via the chain.
  const resolved = envPath
    ? path.resolve(envPath)
    : resolveConfigPath(DEFAULT_ENV_FILE);
  if (!resolved || !fs.existsSync(resolved)) return {};
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
  if (typeof obj["ANTHROPIC_MODEL"] === "string") {
    result.ANTHROPIC_MODEL = obj["ANTHROPIC_MODEL"];
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
  const m = process.env["ANTHROPIC_MODEL"];
  if (typeof t === "string" && t.length > 0) result.ANTHROPIC_AUTH_TOKEN = t;
  if (typeof u === "string" && u.length > 0) result.ANTHROPIC_BASE_URL = u;
  if (typeof m === "string" && m.length > 0) result.ANTHROPIC_MODEL = m;
  return result;
}
