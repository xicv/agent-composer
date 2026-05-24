// Resolves global (user-home) and per-project paths for composer config + env.
//
// Lookup chain (in order):
//   1. Explicit path override (COMPOSER_CONFIG / COMPOSER_ENV env var, or CLI arg)
//   2. Per-project file in process.cwd()
//   3. Global file at $XDG_CONFIG_HOME/composer/ (default ~/.config/composer/)
//
// The first existing file wins; if none exist, callers decide how to handle
// (env loader returns {}, config loader throws).

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";

/**
 * Returns the directory where composer's user-level (global) config files live.
 * Honours $XDG_CONFIG_HOME if set, otherwise defaults to ~/.config/composer.
 */
export function globalConfigDir(): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "composer");
}

/**
 * Returns the first existing path from the lookup chain for a given filename
 * (typically "composer.config.json" or ".env.json"). If an explicit path is
 * provided AND it exists, that wins. Otherwise checks cwd, then global dir.
 * Returns `null` if no file in the chain exists.
 */
export function resolveConfigPath(filename: string, explicitPath?: string): string | null {
  if (explicitPath) {
    const r = resolve(explicitPath);
    if (existsSync(r)) return r;
  }
  const local = resolve(process.cwd(), filename);
  if (existsSync(local)) return local;
  const global = join(globalConfigDir(), filename);
  if (existsSync(global)) return global;
  return null;
}
