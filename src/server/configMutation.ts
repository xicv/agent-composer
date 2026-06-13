import fs from "node:fs";
import path from "node:path";
import { globalConfigDir } from "../config/paths.js";
import { isPathInside } from "../util/applyFileBlocks.js";
import { ORACLE_PLANNER_ROLE } from "../config/oracleRole.js";

export type ConfigScope = "active" | "project" | "global";

export interface ComposerConfigTarget {
  scope: ConfigScope;
  path: string;
}

export function resolveComposerConfigTarget(
  root: string,
  configuredPath: string | undefined,
  scope: ConfigScope,
): ComposerConfigTarget {
  if (scope === "project") {
    return { scope, path: path.resolve(root, "composer.config.json") };
  }
  if (scope === "global") {
    return { scope, path: path.join(globalConfigDir(), "composer.config.json") };
  }

  if (configuredPath && configuredPath.length > 0) {
    const configuredTarget = path.isAbsolute(configuredPath)
      ? configuredPath
      : path.resolve(root, configuredPath);
    if (fs.existsSync(configuredTarget)) {
      return { scope, path: configuredTarget };
    }
    if (!path.isAbsolute(configuredPath)) {
      const globalTarget = path.join(globalConfigDir(), configuredPath);
      if (fs.existsSync(globalTarget)) {
        return { scope, path: globalTarget };
      }
    }
    return {
      scope,
      path: configuredTarget,
    };
  }

  const projectPath = path.resolve(root, "composer.config.json");
  if (fs.existsSync(projectPath)) return { scope, path: projectPath };
  return { scope, path: path.join(globalConfigDir(), "composer.config.json") };
}

export function applyComposerConfigPatch(
  before: Record<string, unknown>,
  patch: {
    codexLifecycle?: unknown;
    codexReview?: unknown;
    oracle?: { enabled?: boolean };
  },
): Record<string, unknown> {
  const next = cloneJsonObject(before);
  if (patch.codexLifecycle !== undefined) {
    next["codexLifecycle"] = deepMergeRecords(
      readRecord(next["codexLifecycle"]),
      readRecord(patch.codexLifecycle),
    );
  }
  if (patch.codexReview !== undefined) {
    next["codexReview"] = deepMergeRecords(
      readRecord(next["codexReview"]),
      readRecord(patch.codexReview),
    );
  }
  if (patch.oracle?.enabled !== undefined) {
    const roles = readRecord(next["roles"]);
    if (patch.oracle.enabled) {
      if (!isRecord(roles["oraclePlanner"])) {
        roles["oraclePlanner"] = cloneJsonObject(
          ORACLE_PLANNER_ROLE as unknown as Record<string, unknown>,
        );
      }
    } else {
      delete roles["oraclePlanner"];
    }
    next["roles"] = roles;
  }
  return next;
}

export function assertSafeConfigWriteTarget(root: string, target: ComposerConfigTarget): void {
  const stat = fs.lstatSync(target.path);
  if (stat.isSymbolicLink()) {
    throw new Error(`Composer config target must not be a symlink: ${target.path}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Composer config target must be a file: ${target.path}`);
  }

  if (target.scope === "project") {
    const rootReal = fs.realpathSync(root);
    const parentReal = fs.realpathSync(path.dirname(target.path));
    if (!isPathInside(parentReal, rootReal)) {
      throw new Error(`Composer project config target escapes project root: ${target.path}`);
    }
  }
}

export function writeConfigFileAtomically(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.composer-config-${process.pid}-${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, filePath);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

export function isGlobalComposerConfigPath(filePath: string): boolean {
  return path.resolve(filePath) === path.join(globalConfigDir(), "composer.config.json");
}

export function cloneJsonObject(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export function readRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? cloneJsonObject(value) : {};
}

export function deepMergeRecords(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = cloneJsonObject(target);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const existing = next[key];
    next[key] =
      isRecord(existing) && isRecord(value)
        ? deepMergeRecords(existing, value)
        : value;
  }
  return next;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
