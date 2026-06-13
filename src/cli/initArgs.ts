export type InitInvocation =
  | { kind: "global" }
  | { kind: "project"; installOracle: boolean }
  | { kind: "error"; message: string };

/**
 * Resolve `agent-composer init` flags into a concrete invocation.
 * `--oracle` installs project-scoped Oracle adapter scripts + an opt-in role,
 * so it cannot be combined with `--global`; that combination is an explicit
 * error rather than a silently-ignored flag.
 */
export function resolveInitInvocation(flags: readonly string[]): InitInvocation {
  const global = flags.includes("--global");
  const oracle = flags.includes("--oracle");
  if (global && oracle) {
    return {
      kind: "error",
      message:
        "composer init: --oracle is project-scoped and cannot be combined with --global. " +
        "Run `agent-composer init --oracle` inside the project, or `agent-composer init --global` without --oracle.",
    };
  }
  return global ? { kind: "global" } : { kind: "project", installOracle: oracle };
}
