import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ENABLED_OFF = new Set(["0", "false", "FALSE", "off", "OFF", "no", "NO"]);
const DISABLED_ON = new Set(["1", "true", "TRUE", "on", "ON", "yes", "YES"]);

/** Mirrors the shell hooks' composer_disabled(): COMPOSER_ENABLED off-values,
 *  COMPOSER_DISABLED on-values, COMPOSER_DISABLED_FILE, <projectDir>/.composer-disabled,
 *  and ~/.claude/composer.disabled. Keep in sync with scripts/*.sh. */
export function isComposerDisabled(opts: { projectDir?: string } = {}): boolean {
  const enabled = process.env["COMPOSER_ENABLED"];
  if (enabled !== undefined && ENABLED_OFF.has(enabled)) return true;
  const disabled = process.env["COMPOSER_DISABLED"];
  if (disabled !== undefined && DISABLED_ON.has(disabled)) return true;
  const df = process.env["COMPOSER_DISABLED_FILE"];
  if (df && existsSync(df)) return true;
  const projDir = opts.projectDir ?? process.env["CLAUDE_PROJECT_DIR"];
  if (projDir && existsSync(join(projDir, ".composer-disabled"))) return true;
  const home = process.env["HOME"] && process.env["HOME"]!.length > 0 ? process.env["HOME"]! : homedir();
  if (home && existsSync(join(home, ".claude", "composer.disabled"))) return true;
  return false;
}
