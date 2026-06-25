import fs from "node:fs";
import path from "node:path";

export function isPathInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

export function resolveProjectDir(projectDir: string | undefined, root: string): string {
  const resolved = projectDir === undefined ? root : path.resolve(projectDir);
  if (projectDir !== undefined && !path.isAbsolute(projectDir)) {
    throw new Error(`projectDir must be an absolute path: ${projectDir}`);
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`projectDir must be an existing directory: ${resolved}`);
  }
  return fs.realpathSync(resolved);
}
