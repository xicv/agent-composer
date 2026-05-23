# Composer — Project Memory (auto-loaded by Claude Code)

> Read this on every session. Three rules below override defaults.

## North star (the only thing that matters)

1. **Claude is the brain.** The most capable model (Opus 4.7) holds memory,
   plans, and orchestrates. It does NOT execute.
2. **Other agents are executors.** GLM (via Anthropic-compatible endpoint)
   does code work. `agy` CLI (Gemini 3.1) does research + review.
3. **Save Claude tokens. Each task reviewable.** Every subagent dispatch
   returns only a summary; raw worker output stays out of the main context.
4. **Do not get distracted by other services.** If a feature does not
   improve task-detection, brain-vs-executor split, token economy, or
   review-ability, it is out of scope.

## Reading order before touching code

1. `docs/STATUS.md` — **current state: what's done, what's next, last-green test count**
2. `docs/multi_agent_orchestration_plan.md` — architecture, hooks, settings.json, risk matrix
3. `docs/tdd_plan.md` — Wave 0/1/2/3 build sequence, quality rubric, eval set
4. `docs/self_evolving_composer.md` — T1/T2/T3 self-evolution tiers
5. `docs/adr/0001-contracts.md` — Wave 0 frozen contracts (C0.1–C0.5), append-only
6. `evals/SUCCESS.md` + `evals/baseline-protocol.md` — measurement spec for Wave-3 autoresearch

## Hard constraints (carried across sessions)

- **NEVER use the `Read` tool on `.env.json`.** Schema only: `{ ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL }`. Runtime parses via `fs.readFileSync`.
- **All test/eval traffic routes through GLM** (`.env.json`) or `agy` CLI. **Claude Max5 is reserved for orchestration + milestone smoke checks.**
- **TypeScript + Node + `@modelcontextprotocol/sdk` + zod.** No Python in the runtime path. Vitest for tests.
- **Wave 0 contracts are append-only during Wave 1+.** New optional fields OK; renames/removals require a new ADR and a pause across all open workers.
- **`boundary_guard.sh` is fail-closed.** Exit 0 + JSON `permissionDecision: "deny"` for blocked tools; same for malformed input.
- **`composer-mastermind/SKILL.md` is negative-style.** "DO NOT use Edit; NEVER call Bash; ALWAYS dispatch via Task" — mirrors Anthropic's frontend-design skill convention.
- **Day 2 (real GLM/`agy` fixture record) needs explicit user `go`.** Costs ~$0.02 in GLM tokens; not auto-spent.

## How work is structured

| Layer | What it does |
|---|---|
| Main Claude session (Opus 4.7) | Orchestration, memory, plans. **No `Edit`/`Write`/`Bash`** — denied in `.claude/settings.json` AND blocked by `scripts/boundary_guard.sh` |
| Native subagents (`.claude/agents/*.md`) | Wrapping layer for context isolation. Each lists exactly one composer MCP tool + `Read`/`Glob`. Model: `haiku` |
| MCP server (`src/index.ts`) | Wires `composer_research` / `composer_code` / `composer_review` to provider adapters; ships C0.3 tool annotations + `Use when…` descriptions |
| Providers (`src/providers/*`) | `MockProvider` (free), `AnthropicCompatibleProvider` (GLM via z.ai), `CLIProvider` (`agy` via Gemini 3.1, spawn-based with stdin closed) |
| Config loader (`src/config/env.ts`) | Reads `.env.json` via `fs.readFileSync` — **never** with the `Read` tool |
| Hooks (`scripts/*.sh`) | `boundary_guard.sh` enforces denials. `learn.sh` (Stop hook) appends user corrections to `.claude/learnings/<month>.md` |
| Eval harness (`tests/eval/*` + `evals/*`) | Budget guard + composite metric + 3 starter tasks. Wave-3 autoresearch consumes this. |
| Tape harness (`tests/util/recorder.ts` + `tests/fixtures/tapes/*`) | Record once on real GLM/`agy`, replay forever in vitest. CI cost: $0. |

## What NOT to build

- Per-tool LSP integrations, custom statusline themes, agent-team experiments — see `docs/self_evolving_composer.md` §6 ("What NOT to build").
- Anything that pulls real code-writing back into the main Claude session.
- Anything that bypasses the GLM/agy routing in eval/test paths.
