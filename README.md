# Composer

Multi-agent orchestration MCP server. **Claude (Opus 4.7) is the brain — it does not execute.** Heavy work is delegated to **GLM** (via Anthropic-compatible endpoint) and **`agy`** (Gemini 3.1 CLI). The goal is to save Claude Max5 tokens while preserving the orchestrator's plan/integration role and keeping every dispatched task reviewable.

## Read in this order

1. [`CLAUDE.md`](./CLAUDE.md) — auto-loaded north star + hard constraints
2. [`docs/STATUS.md`](./docs/STATUS.md) — what's done, what's next
3. [`docs/multi_agent_orchestration_plan.md`](./docs/multi_agent_orchestration_plan.md) — v2 architecture
4. [`docs/tdd_plan.md`](./docs/tdd_plan.md) — build sequence + 5-tier quality rubric
5. [`docs/adr/0001-contracts.md`](./docs/adr/0001-contracts.md) — frozen C0.1–C0.5 + amendments
6. [`docs/self_evolving_composer.md`](./docs/self_evolving_composer.md) — autonomous skill evolution (T1/T2/T3)
7. [`evals/SUCCESS.md`](./evals/SUCCESS.md) + [`evals/baseline-protocol.md`](./evals/baseline-protocol.md) — measurement spec

## Quickstart

```bash
npm install
npm test                  # 123 tests
npm run test:hooks        # 17 bash hook fixtures
npm run typecheck         # both tsc configs
npm run schema:lint       # composer.config.json validates against schema
```

To run the MCP server against the all-mock default config:

```bash
npm start                 # tsx src/index.ts → stdio MCP server
```

Register with Claude Code:

```bash
# .claude/settings.json already wires composer; or via CLI:
claude mcp add composer --command npx --args tsx src/index.ts
```

## Repo layout (abridged)

| Path | What it is |
|---|---|
| `src/` | MCP server, providers, registry, config loader |
| `tests/` | Vitest unit tests + bash hook fixtures + eval harness |
| `scripts/` | `boundary_guard.sh`, `learn.sh`, `record-fixtures.ts` |
| `.claude/` | Subagents, skills, settings, learnings |
| `docs/` | Architecture, build plan, ADR, self-evolution |
| `evals/` | Task set, success metric, baseline protocol |

Full layout in [`docs/STATUS.md`](./docs/STATUS.md#what-ships).

## Hard constraints

See [`CLAUDE.md`](./CLAUDE.md). In one line: **never `Read` `.env.json`, route test/eval traffic through GLM/agy never Max5, treat C0.1–C0.5 contracts as append-only, hooks are fail-closed.**
