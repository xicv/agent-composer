import fs from "node:fs";
import path from "node:path";

/**
 * Deterministically apply GLM-authored output of the form
 *   FILE: <relative/path>
 *   ```lang
 *   <content>
 *   ```
 * Writes each file under `root` (cwd/projectDir). Guards against path
 * traversal, including symlink escapes through existing parent directories.
 */
export function applyFileBlocks(
  text: string,
  root: string,
): { files: Array<{ path: string; status: "changed" | "unchanged" }>; rejected: string[] } {
  const projectRoot = fs.realpathSync(root);
  const parsed: Array<{ rel: string; abs: string; content: string }> = [];
  const rejected: string[] = [];
  const re = /^FILE:\s*(\S+)[^\n]*\r?\n(`{3,}|~{3,})[^\n]*\r?\n([\s\S]*?)^\2[ \t]*$(?=\r?\nFILE:\s|\s*$)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const rel = (m[1] ?? "").trim();
    const content = m[3] ?? "";
    if (!rel) continue;
    const abs = path.resolve(projectRoot, rel);
    if (!isPathInside(abs, projectRoot)) {
      rejected.push(`${rel} (outside projectDir)`);
      continue;
    }
    const nearestParent = nearestExistingParent(path.dirname(abs));
    const parentReal = fs.realpathSync(nearestParent);
    if (!isPathInside(parentReal, projectRoot)) {
      rejected.push(`${rel} (parent resolves outside projectDir)`);
      continue;
    }
    let leafStat: fs.Stats | undefined;
    try {
      leafStat = fs.lstatSync(abs);
    } catch {
      leafStat = undefined;
    }
    if (leafStat?.isSymbolicLink()) {
      // A symlink leaf (including a DANGLING one) would be followed by
      // writeFileSync and could escape projectDir. realpathSync throws on a
      // dangling target, so reject unresolvable or escaping links.
      let linkReal: string | undefined;
      try {
        linkReal = fs.realpathSync(abs);
      } catch {
        linkReal = undefined;
      }
      if (linkReal === undefined || !isPathInside(linkReal, projectRoot)) {
        rejected.push(`${rel} (symlink target resolves outside projectDir)`);
        continue;
      }
    } else if (leafStat !== undefined) {
      const existingReal = fs.realpathSync(abs);
      if (!isPathInside(existingReal, projectRoot)) {
        rejected.push(`${rel} (file resolves outside projectDir)`);
        continue;
      }
    }
    parsed.push({ rel, abs, content });
  }

  if (rejected.length > 0) {
    throw new Error(
      `composer_code_chain: refusing to apply paths outside projectDir ${projectRoot}: ${rejected.join(", ")}`,
    );
  }

  // Two-phase apply so a mid-write failure cannot leave partial state:
  // stage every CHANGED file to a sibling temp, then atomically rename all.
  const statusByRel = new Map<string, "changed" | "unchanged">();
  const pending: Array<{ abs: string; tmp: string }> = [];
  try {
    for (const { rel, abs, content } of parsed) {
      const previous = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : undefined;
      if (previous === content) {
        statusByRel.set(rel, "unchanged");
        continue;
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const tmp = path.join(
        path.dirname(abs),
        `.composer-apply-${process.pid}-${pending.length}.tmp`,
      );
      fs.writeFileSync(tmp, content, "utf8");
      pending.push({ abs, tmp });
      statusByRel.set(rel, "changed");
    }
  } catch (error) {
    for (const { tmp } of pending) fs.rmSync(tmp, { force: true });
    throw error;
  }
  // Phase 2: rename staged temps into place, snapshotting each target's prior
  // content first so a mid-phase failure can roll back to the original state.
  const applied: Array<{ abs: string; original: string | null }> = [];
  try {
    for (const { abs, tmp } of pending) {
      const existed = fs.existsSync(abs);
      const original = existed ? fs.readFileSync(abs, "utf8") : null;
      if (existed) {
        // Preserve the target's mode (e.g. the +x bit on scripts/hooks) — the
        // staged temp was created with the process default, so copy it over
        // before the atomic replace.
        try {
          fs.chmodSync(tmp, fs.statSync(abs).mode & 0o777);
        } catch {
          // best-effort mode preservation; never fail the apply over chmod
        }
      }
      fs.renameSync(tmp, abs);
      applied.push({ abs, original });
    }
  } catch (error) {
    // Roll back already-applied files (restore prior content, or remove files
    // that did not previously exist), then clean up any remaining temps.
    for (const done of applied.reverse()) {
      try {
        if (done.original === null) {
          fs.rmSync(done.abs, { force: true });
        } else {
          fs.writeFileSync(done.abs, done.original, "utf8");
        }
      } catch {
        // best-effort restore; nothing else we can safely do here
      }
    }
    for (const { tmp } of pending) fs.rmSync(tmp, { force: true });
    throw error;
  }
  const files = parsed.map(({ rel }) => ({
    path: rel,
    status: statusByRel.get(rel) ?? "unchanged",
  }));
  return { files, rejected };
}

export function isPathInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function nearestExistingParent(dir: string): string {
  let current = dir;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
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
