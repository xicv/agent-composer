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
    "  agent-composer readiness [--json]  Run the daily readiness verdict (ready/degraded/disabled/blocked)",
    "  agent-composer cleanup          Remove accumulated Composer artefacts (.composer/oracle, results, state jobs)",
    "  agent-composer cleanup --goals --dry-run --older-than 14d   Preview artefact cleanup including terminal goal records",
    "  agent-composer mode <fast|balanced|strict>   Apply a preset (lifecycle + review gates)",
    "  agent-composer status [--json|--line|--watch|--watch --replace]   Show project config + integration status (codexReview, lifecycle, oracle, git hook)",
    "  agent-composer goal start <objective> --condition <condition> [--check name=cmd ...] [--max-turns N] [--max-cost USD]",
    "  agent-composer goal status [goalId]",
    "  agent-composer goal step [goalId] [--check-result name=pass|fail ...] [--condition-met|--condition-not-met] [--spent USD] [--raise-max-turns N] [--raise-max-cost USD]",
    "  agent-composer goal report [goalId] [--format markdown|json] [--audit] [--audit-limit N] [--include-commands] [--include-audit-events]",
    "  agent-composer goal clear [goalId]",
    "  agent-composer install-git-hook Install the Composer pre-commit gate into .git/hooks/pre-commit",
    "  agent-composer help             Show this help",
    "",
    "Notes:",
    "  --oracle is project-scoped and cannot be combined with --global.",
    "  Overrides: COMPOSER_CONFIG (config path), COMPOSER_ENV (.env.json path).",
  ].join("\n");
}
