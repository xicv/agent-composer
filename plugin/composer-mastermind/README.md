# composer-mastermind

> Multi-agent orchestrator plugin for Claude Code. Claude orchestrates; GLM and agy execute.

## What it is

Composer-mastermind is a Claude Code plugin that turns the main session into a coordinator. The orchestrator never writes code, runs bash, or edits files directly — instead it dispatches work through three subagents wired to the `agent-composer` MCP server:

| Subagent | Tool | Role |
|---|---|---|
| `coder` | `mcp__composer__composer_code` | Writes code via GLM (Anthropic-compatible endpoint) |
| `researcher` | `mcp__composer__composer_research` | Docs lookup + research via `agy` CLI (Gemini) |
| `reviewer` | `mcp__composer__composer_review` | Code review via `agy` CLI |

The orchestrator's allowed-tool surface is enforced by `boundary_guard.sh` — `Edit`, `Write`, `Bash`, `NotebookEdit` are denied; only the three composer MCP tools plus `Read`/`Glob` pass.

## What's inside

```
composer-mastermind/
├── plugin.json                              # this manifest
├── skills/composer-mastermind/SKILL.md      # the orchestrator brain
├── agents/                                  # haiku-wrapped subagent defs
│   ├── coder.md
│   ├── researcher.md
│   └── reviewer.md
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

This is the **frozen v0.1.0 snapshot** of the composer-monorepo's canonical assets. The development instance lives at the upstream repo's `.claude/` tree; releases re-sync via M0.5 (see `scripts/release-sync.mjs`).

## License

MIT.
