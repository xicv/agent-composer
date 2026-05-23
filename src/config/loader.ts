// Wave 1 F1.4 — config loader (disk + in-memory).
// `loadConfig` reads + validates `composer.config.json`; `parseConfig`
// validates an already-parsed object. Both throw on invalid input so
// the MCP server fails fast at startup instead of mid-request.

import fs from "node:fs";
import path from "node:path";
import { ComposerConfigSchema, type ComposerConfig } from "./schema.js";

export function parseConfig(input: unknown): ComposerConfig {
  const result = ComposerConfigSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new Error(`Composer config failed schema validation:\n${issues}`);
  }
  return result.data;
}

export function loadConfig(configPath: string): ComposerConfig {
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Composer config not found at ${resolved}`);
  }
  const raw = fs.readFileSync(resolved, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`Composer config at ${resolved} is not valid JSON: ${detail}`);
  }
  return parseConfig(parsed);
}
