import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export interface InstallGitHookResult {
  path: string;
  status: "installed" | "already" | "refused";
  reason?: string;
}

const HOOK_CONTENT = `#!/usr/bin/env bash
# composer pre-commit gate — installed by \`agent-composer install-git-hook\`
exec bash scripts/precommit_codex_review.sh --git-hook "$@"
`;

export function installGitHook(cwd: string): InstallGitHookResult {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--git-path", "hooks/pre-commit"], {
    encoding: "utf8",
    timeout: 10000,
  });

  if (result.error || result.status !== 0) {
    throw new Error("install-git-hook: not a git repository");
  }

  const hookPath = resolve(cwd, result.stdout.trim());

  if (existsSync(hookPath)) {
    let text: string;
    try {
      text = readFileSync(hookPath, "utf8");
    } catch {
      text = "";
    }
    if (text.includes("precommit_codex_review.sh")) {
      return { path: hookPath, status: "already" };
    }
    return {
      path: hookPath,
      status: "refused",
      reason: "a non-Composer pre-commit hook already exists; remove it first",
    };
  }

  mkdirSync(dirname(hookPath), { recursive: true });
  writeFileSync(hookPath, HOOK_CONTENT, { encoding: "utf8" });
  chmodSync(hookPath, 0o755);

  return { path: hookPath, status: "installed" };
}

export function runInstallGitHook(cwd: string): void {
  let result: InstallGitHookResult;
  try {
    result = installGitHook(cwd);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${msg}\n`);
    process.exit(1);
    return;
  }

  if (result.status === "installed") {
    process.stdout.write(`composer install-git-hook: installed at ${result.path}\n`);
  } else if (result.status === "already") {
    process.stdout.write(`composer install-git-hook: already installed at ${result.path}\n`);
  } else {
    process.stdout.write(`composer install-git-hook: refused — ${result.reason ?? "unknown reason"} (${result.path})\n`);
    process.exit(1);
  }
}
