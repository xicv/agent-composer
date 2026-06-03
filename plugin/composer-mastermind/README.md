# composer-mastermind

> Multi-agent orchestrator plugin for Claude Code. Claude orchestrates; GLM, Codex, and agy execute. Claude Code CLI is available as a premium review escalation.

## What it is

Composer-mastermind is a Claude Code plugin that turns the main session into a coordinator. The orchestrator never writes code or edits files directly; it may use Bash for inspection and verification. Work is dispatched through direct MCP tools and fallback subagents wired to the `agent-composer` MCP server:

| Subagent | Tool | Role |
|---|---|---|
| direct | `mcp__composer__composer_handoff_create` | Writes shared context packets for multi-provider work |
| direct | `mcp__composer__composer_code_cli` | Default coding path; CLI executor applies code directly from the MCP server root; configure as Codex or agy |
| direct | `mcp__composer__composer_code_chain` | GLM-authored fallback; server applies complete-file blocks deterministically |
| direct | `mcp__composer__composer_research` | Default docs lookup + web research lane via Codex CLI search in read-only mode |
| direct | `mcp__composer__composer_review` | Default code review lane via `agy` CLI; ask for repo-appropriate targeted checks |
| direct | `mcp__composer__composer_review_claude` | Premium Claude second-opinion review for explicit/risky cases |
| `coder` | `mcp__composer__composer_code` | Patch-only legacy path via GLM (Anthropic-compatible endpoint) |
| `researcher` | `mcp__composer__composer_research` | High-volume research wrapper when raw upstream output needs isolation |
| `reviewer` | `mcp__composer__composer_review` | High-volume review wrapper when raw upstream output needs isolation |
| `reviewer-claude` | `mcp__composer__composer_review_claude` | High-volume premium review wrapper when raw upstream output needs isolation |

The orchestrator's allowed-tool surface is enforced by `boundary_guard.sh` — `Edit`, `Update`, `Write`, `NotebookEdit`, and MCP write/edit/exec variants are denied; native Bash, composer MCP tools, `Read`, and `Glob` pass.

Soft-disable Composer hooks without editing Claude Code settings:

```bash
COMPOSER_ENABLED=0 claude          # one launch
touch ~/.claude/composer.disabled  # global live toggle off
rm -f ~/.claude/composer.disabled  # global live toggle on
touch .composer-disabled           # project-local toggle off
```

The sentinel disables hooks immediately. To fully suppress skill autoload,
set `"composer-mastermind": "off"` in Claude Code `skillOverrides` and restart
CC.

## What's inside

```
composer-mastermind/
├── plugin.json                              # this manifest
├── skills/composer-mastermind/SKILL.md      # the orchestrator brain
├── agents/                                  # haiku-wrapped subagent defs
│   ├── coder.md
│   ├── researcher.md
│   ├── reviewer.md
│   └── reviewer-claude.md
├── commands/
│   └── evolve.md                            # /evolve slash command (GEPA loop)
└── hooks/
    ├── boundary_guard.sh                    # PreToolUse fail-closed boundary
    └── learn.sh                             # Stop hook — append user corrections
```

## Requires

- `agent-composer` (peer; install via `npx agent-composer` or global npm install)
- A `composer.config.json` + `.env.json` at the consumer project root (run `npx composer-mcp init` to scaffold; see ADR 0002 M0.3)
- Claude Code ≥4.6

## Self-evolution surface

`/evolve --eval-mode real` mutates only the project-local copy of `SKILL.md` (`.claude/skills/composer-mastermind/SKILL.md`), never the plugin install. Plugin updates ship via npm; per-project skill drift is intentional. See ADR 0003 for the full mutation scope contract (S1 diff-path, S2 deny-list, S3 stat gate, S4 human-promote, S5 audit trail).

## Source of truth

This is the frozen release snapshot of the composer-monorepo's canonical assets. The development instance lives at the upstream repo's `.claude/` tree; releases re-sync via M0.5 (see `scripts/release-sync.mjs`).

## License

MIT.
