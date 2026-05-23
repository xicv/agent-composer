# Composer — Project Status

> Last updated: **2026-05-23**. Single source of truth for "what's done, what's next". Read this **after** [`CLAUDE.md`](../CLAUDE.md) but **before** anything in `tdd_plan.md` §8 (which is the original build sequence, frozen as written for traceability).

## At a glance

| Wave | Scope | Status |
|---|---|---|
| **Wave 0** | C0.1–C0.5 frozen contracts | ✅ committed `07c8a79` |
| **Wave 1** | F1.1 – F1.12 + F2.1 (MCP server, per §8 Day 1) | ✅ committed `07c8a79` |
| **Advisor pass** | Tool annotations, "Use when…" descriptions, `@types/node` 25, `CLAUDE.md` | ✅ committed `07c8a79` |
| **Coverage patch** | CLIProvider real-spawn tests + 2 registry branches | ✅ committed `0516416` |
| **Wave 2 F2.2** | Eval framework + 3 starter tasks + budget guard + metric | ✅ committed `e12b5b6` |
| **Baseline measurement** | Stock-Claude token counts for the 3 eval tasks | ⏸ pending — user task, see [`../evals/baseline-protocol.md`](../evals/baseline-protocol.md) |
| **Wave 3 F3.1** | End-to-end smoke (real subagent dispatch) | ⏸ gated on baseline |
| **Wave 3 F3.2** | Autoresearch on `composer-mastermind/SKILL.md` (~$2 GLM) | ⏸ gated on F3.1 |
| **Eval expansion** | Remaining 4 task classes from plan §7 | ⏸ optional, $0 cost |

## Test gates (last green run on commit `e12b5b6`)

| Gate | Value |
|---|---|
| Vitest | **123 / 123** pass across 12 test files |
| Bash hook harness | **17 / 17** pass |
| Coverage — statements | 98.52% (target 80%) |
| Coverage — branches | 92.91% |
| Coverage — functions | 100% |
| Coverage — lines | 98.94% |
| `tsc` src | 0 errors |
| `tsc` test | 0 errors |
| `ajv` schema lint | clean |
| `.env.json` git-ignored | ✅ |
| Real GLM tape | `tests/fixtures/tapes/anthropic-glm.json` (~$0.00005 spend) |
| Real agy tape | `tests/fixtures/tapes/cli-agy.json` (free) |

## What ships

```
composer/
├── CLAUDE.md                              # auto-loaded north star
├── README.md                              # entry point (brief)
├── composer.config.json                   # role → provider mapping (default all-mock)
├── composer.config.schema.json            # C0.2 frozen schema
├── package.json + package-lock.json
├── tsconfig.json + tsconfig.test.json
├── vitest.config.ts
├── .claude/
│   ├── settings.json                      # deny + hook + mcpServers
│   ├── agents/{researcher,coder,reviewer}.md
│   ├── skills/composer-mastermind/SKILL.md
│   └── learnings/index.md                 # T1 self-evolve aggregator
├── docs/
│   ├── STATUS.md                          # THIS FILE
│   ├── multi_agent_orchestration_plan.md  # v2 architecture
│   ├── tdd_plan.md                        # build sequence + rubric
│   ├── self_evolving_composer.md          # T1/T2/T3 tiers
│   └── adr/0001-contracts.md              # frozen + amendments
├── evals/
│   ├── tasks.jsonl                        # 3 starter tasks
│   ├── SUCCESS.md                         # metric spec + tier thresholds
│   ├── baseline-protocol.md               # how to measure stock-Claude baselines
│   ├── baselines.example.json             # baselines schema target
│   └── baselines.json                     # ⏸ user-measured, not yet present
├── scripts/
│   ├── boundary_guard.sh                  # PreToolUse fail-closed hook (F1.5)
│   ├── learn.sh                           # Stop hook → .claude/learnings/<month>.md (F1.11)
│   └── record-fixtures.ts                 # one-shot real-provider tape recorder
├── src/
│   ├── index.ts                           # stdio MCP server entry
│   ├── server.ts                          # createComposerServer factory
│   ├── registry.ts                        # ProviderFactory
│   ├── config/{env,loader,schema}.ts
│   └── providers/
│       ├── IProvider.ts                   # C0.1 frozen contract
│       ├── MockProvider.ts                # F1.3
│       ├── AnthropicCompatibleProvider.ts # F1.1 (GLM via Anthropic compat)
│       └── CLIProvider.ts                 # F1.2 (agy / Gemini 3.1, spawn-based)
└── tests/
    ├── hooks/{01..15}*.json + run.sh      # F1.9 fixtures + bash harness
    ├── providers/, config/, mcp/, registry.test.ts
    ├── util/recorder.ts                   # F1.12 tape harness
    ├── eval/                              # F2.2 — schema/budget/metric/runner
    ├── fixtures/tapes/{anthropic-glm,cli-agy}.json
    └── contracts/IProvider.implementable.ts
```

## Hard constraints (carried across every session)

Mirrored from `CLAUDE.md` so this file is sufficient as a handoff artifact:

1. **NEVER use the Read tool on `.env.json`.** Schema is `{ ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL }`. Runtime parses via `fs.readFileSync` in `src/config/env.ts`.
2. **All test/eval traffic routes through GLM or `agy`.** Claude Max5 is reserved for orchestration + milestone smoke checks. Replay tapes mean CI is `$0`.
3. **Wave 0 contracts (C0.1–C0.5) are append-only** during all subsequent waves. Renames / removals require a new ADR and a pause across all open workers.
4. **`boundary_guard.sh` is fail-closed.** Exit 0 + JSON `permissionDecision: "deny"` for blocked tools AND for malformed input.
5. **`composer-mastermind/SKILL.md` is negative-style** ("DO NOT use Edit", "ALWAYS dispatch via Task").
6. **Day 2+ real-provider work needs explicit user `go`** before spending GLM tokens. ~$0.0001 for fixture record was already approved.

## Routine commands

```bash
npm test                     # 123 vitest tests
npm run test:hooks           # 17 bash hook fixtures
npm run test:all             # both
npm run typecheck            # tsc on src + tests
npm run lint                 # alias for typecheck
npm run schema:lint          # ajv compile + validate composer.config.json
npm run usage                # ccusage daily report
npm run build                # tsc emit to dist/

# Direct binaries (use these when npx mis-resolves into npm scripts):
./node_modules/.bin/vitest run --coverage
./node_modules/.bin/tsx scripts/record-fixtures.ts {anthropic|cli|all}
./node_modules/.bin/tsc --noEmit
```

## Next two milestones

### A — Baseline measurement (user, on stock Max5)

See [`../evals/baseline-protocol.md`](../evals/baseline-protocol.md). Output is `evals/baselines.json`, schema mirrors `evals/baselines.example.json`. **Until this lands, Wave 3 token-savings metric is symbolic only.**

### B — Wave 3 (after baseline)

- **F3.1** end-to-end smoke against a real Claude session — register `composer` MCP, fire a 3-step feature, confirm hook + delegation chain.
- **F3.2** autoresearch loop on `composer-mastermind/SKILL.md` — mutation target, eval set above, $2 budget, 5 experiments. Winning candidate writes to `*.candidate.md` (gitignored), promoted via `mv` after manual review.
