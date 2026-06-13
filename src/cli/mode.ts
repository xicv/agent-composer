import fs from "node:fs";
import { resolve } from "node:path";
import {
  resolveComposerConfigTarget,
  applyComposerConfigPatch,
  assertSafeConfigWriteTarget,
  writeConfigFileAtomically,
} from "../server/configMutation.js";
import { parseConfig } from "../config/loader.js";
import { modePatch, type ModeName } from "../config/modes.js";

export interface ApplyModeResult { path: string; changed: boolean; }

export function applyMode(cwd: string, mode: ModeName): ApplyModeResult {
  const root = resolve(cwd);
  const target = resolveComposerConfigTarget(root, process.env["COMPOSER_CONFIG"], "project");
  if (!fs.existsSync(target.path)) {
    throw new Error(`composer mode: config not found at ${target.path} — run \`agent-composer init\` first.`);
  }
  const beforeRaw = fs.readFileSync(target.path, "utf8");
  const before = JSON.parse(beforeRaw) as Record<string, unknown>;
  const patch = modePatch(mode);
  const next = applyComposerConfigPatch(before, { codexLifecycle: patch.codexLifecycle, codexReview: patch.codexReview });
  const parsed = parseConfig(next);
  const nextRaw = `${JSON.stringify(parsed, null, 2)}\n`;
  const changed = beforeRaw !== nextRaw;
  if (changed) {
    assertSafeConfigWriteTarget(root, target);
    writeConfigFileAtomically(target.path, nextRaw);
  }
  return { path: target.path, changed };
}
