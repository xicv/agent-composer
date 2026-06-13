import { spawnSync } from "node:child_process";

export type ReviewScope = "staged" | "unstaged" | "working-tree" | "branch";

export interface ReviewDiffOptions {
  base?: string;
  files?: string[];
}

/** Compute a git diff for the requested scope, rooted at `root`. Throws on git
 *  failure or when the scope yields no changes. `files` narrows any scope to a pathspec. */
export function computeReviewDiff(root: string, scope: ReviewScope, opts: ReviewDiffOptions = {}): string {
  const args = ["-C", root, "--no-pager", "diff", "--no-ext-diff"];
  if (scope === "staged") args.push("--cached");
  else if (scope === "working-tree") args.push("HEAD");
  else if (scope === "branch") args.push(`${opts.base ?? "main"}...HEAD`);
  // "unstaged" => plain `git diff`
  if (opts.files && opts.files.length > 0) {
    args.push("--", ...opts.files);
  }
  const result = spawnSync("git", args, { encoding: "utf8", timeout: 15000, maxBuffer: 32 * 1024 * 1024 });
  if (result.error) {
    throw new Error(`composer review: git diff failed: ${result.error.message}`);
  }
  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(`composer review: git diff exited ${result.status}: ${(result.stderr ?? "").slice(0, 300)}`);
  }
  const diff = result.stdout ?? "";
  if (diff.trim().length === 0) {
    throw new Error(`composer review: no changes for scope "${scope}"${opts.files?.length ? ` (files: ${opts.files.join(", ")})` : ""}`);
  }
  return diff;
}
