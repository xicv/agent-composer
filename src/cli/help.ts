/** Usage text for the `agent-composer` CLI. Pure function so it is unit-testable
 *  without executing the entrypoint (which would start the MCP server). */
export function formatHelp(): string {
  return [
    "agent-composer — Claude-orchestrated multi-agent MCP server",
    "",
    "Usage:",
    "  agent-composer                  Start the MCP server over stdio (default)",
    "  agent-composer init             Scaffold composer config + assets in the current project",
    "  agent-composer init --oracle    ...also install the opt-in Oracle (ChatGPT Pro) planning lane",
    "  agent-composer init --global    Install orchestrator assets into the user-global config",
    "  agent-composer doctor           Run environment/config diagnostics",
    "  agent-composer doctor --json    Emit the diagnostics report as JSON (exit 0 healthy / 1 unhealthy)",
    "  agent-composer cleanup          Remove accumulated Composer artefacts (.composer/oracle, results, state jobs)",
    "  agent-composer cleanup --dry-run --older-than 14d   Preview what would be removed",
    "  agent-composer mode <fast|balanced|strict>   Apply a preset (lifecycle + review gates)",
    "  agent-composer status [--json|--line|--watch]   Show project config + integration status (codexReview, lifecycle, oracle, git hook)",
    "  agent-composer install-git-hook Install the Composer pre-commit gate into .git/hooks/pre-commit",
    "  agent-composer help             Show this help",
    "",
    "Notes:",
    "  --oracle is project-scoped and cannot be combined with --global.",
    "  Overrides: COMPOSER_CONFIG (config path), COMPOSER_ENV (.env.json path).",
  ].join("\n");
}
