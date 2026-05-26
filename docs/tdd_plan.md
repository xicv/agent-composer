# Composer TDD Plan

> **Companion to** [`multi_agent_orchestration_plan.md`](./multi_agent_orchestration_plan.md) and [`self_evolving_composer.md`](./self_evolving_composer.md).
>
> **Purpose**: define the test-first development sequence so Composer ships with verified behavior, not just hopeful prompts. Test/eval traffic routes through **GLM** (Anthropic-compatible endpoint via `.env.json`) and **`agy` CLI**, never through Claude Max5. Autoresearch (Karpathy loop) tunes the orchestrator skill against the eval set until a "no improving mutation found" plateau.

## 1. Why TDD here (and where it stops)

| Layer | Deterministic? | Test pattern | Cost |
|---|---|---|---|
| `IProvider` interface | yes | Unit + integration | free |
| `ProviderFactory` / config loader | yes | Unit | free |
| `boundary_guard.sh` hook | yes | Fixture-driven unit | free |
| Zod schema validation | yes | Unit | free |
| MCP tool registration | yes | Integration (list-tools) | free |
| Provider live call | partial | Tape-recorded smoke | ~$0.01 once |
| Orchestrator delegates correctly | **no** | Probabilistic eval | GLM-paid, capped |
| Token-savings target | **no** | A/B baseline | GLM + 1 manual Claude session |

Classic TDD applies to plumbing. LLM behavior is measured by **eval set + autoresearch**, not asserted.

## 2. Five-tier quality rubric

Promote tier-by-tier per feature *and* per test case. Don't chase "best" before "good enough" is green.

| Tier | Meaning | Promotion trigger |
|---|---|---|
| **Good** | Happy path works once with one fixture | All Wave-1 tests green on a canonical input |
| **Good enough** | Stated MVP scope covered. Documented inputs/outputs match contract. No silent failures. | Coverage ≥ 80%. Negative-path tests exist for every documented error. |
| **Really good** | Every edge case in the threat model handled. Fail-closed. Deterministic exit codes / return shapes. | Mutation / fuzz testing finds no escape. Hook fixtures include malformed inputs. |
| **Better** | Measurable improvement on a metric (tokens, latency, success rate) vs a documented baseline | A/B-measured delta ≥ stated threshold. |
| **Best** | Survives autoresearch — no further mutation improves the metric | 5 consecutive eval rounds find no improving diff. |

### Worked example — `boundary_guard.sh`

| Tier | What it looks like |
|---|---|
| Good | Blocks `Bash`, passes `Read`. One fixture each. |
| Good enough | Blocks `Bash`/`Edit`/`Write`/`NotebookEdit`; passes `Read`/`Grep`/`Glob`/`Task`/`mcp__composer__*`. 8 fixtures. JSON deny payload validated. |
| Really good | + fails closed on missing `jq`, malformed JSON, empty stdin, syntax error. + matches MCP-prefixed variants. 12 fixtures. `bash -n` clean. |
| Better | + structured drift log on block. + reason string measurably reduces Claude retry rate. |
| Best | + autoresearch on regex finds no improvement over 5 rounds. |

### Worked example — `composer-mastermind` skill

| Tier | What it looks like |
|---|---|
| Good | Claude delegates 1 simple task to coder subagent without nudging |
| Good enough | 5/5 manual smoke tasks delegated to correct subagent without intervention |
| Really good | 10-task eval: delegation accuracy ≥ 90%, zero direct Edit/Write in main session |
| Better | Tokens-in-main-session reduced ≥ 50% vs stock Claude baseline |
| Best | Autoresearch on skill text finds no improving mutation over 20 rounds |

## 3. Dependency-graphed feature waves

```
                ┌──────────────────────────────────────────┐
                │  WAVE 0  (locked contracts — must agree) │
                │  C0.1  IProvider TypeScript interface    │
                │  C0.2  composer.config.json JSON schema  │
                │  C0.3  MCP tool name list                │
                │  C0.4  PreToolUse hook JSON shape        │
                │  C0.5  Subagent frontmatter shape        │
                └────────┬────────────────────┬────────────┘
        ┌────────────────┼────────────────────┼────────────┐
        │ WAVE 1 (parallel — no inter-deps; 12 slices)     │
        └────────┬─────────────────────────────────────────┘
        ┌────────▼──────────────────────┐
        │ WAVE 2 (parallel — 2 slices)  │
        │  F2.1 MCP server src/index.ts │
        │  F2.2 Eval framework + tasks  │
        └────────┬──────────────────────┘
        ┌────────▼──────────────────────┐
        │ WAVE 3 (integration)          │
        │  F3.1 End-to-end smoke        │
        │  F3.2 Autoresearch loop       │
        └───────────────────────────────┘
```

### Wave 0 — contracts (~30 min, zero API spend)

Tiny but load-bearing. Lock these before Wave 1 forks.

**C0.1 — `src/providers/IProvider.ts`**
```typescript
export type ProviderId = "anthropic" | "openai_compatible" | "cli" | "mock";
export interface IProvider {
  readonly id: ProviderId;
  readonly modelLabel: string;
  healthCheck(): Promise<boolean>;
  execute(input: {
    prompt: string;
    context?: string;
    maxTokens?: number;
  }): Promise<{ text: string; tokensIn?: number; tokensOut?: number }>;
}
```

**C0.2 — `composer.config.schema.json`** (JSON Schema, validates `composer.config.json`)
- Required: `roles.{researcher,coder,reviewer}.provider`
- Optional per-provider blocks (apiKeyEnv, baseUrl, cli, model)
- Used by code loader AND a `jq`/`ajv` validation step in CI

**C0.3 — MCP tool names (locked strings)**
- `composer_research(prompt: string, context?: string)`
- `composer_code(prompt: string, context?: string)`
- `composer_review(prompt: string, diff: string)`

Subagent `tools:` allowlists and `boundary_guard.sh` regex both reference these.

**C0.3 amendment (Wave-1 advisor pass, 2026-05-23)** — each tool also carries optional **annotations** (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) per MCP SDK 1.29. Adding annotations is append-only and does not break C0.3 — see `docs/multi_agent_orchestration_plan.md` §4 for the canonical hint matrix.

**C0.4 — PreToolUse hook JSON shape**
Snapshot Anthropic's current PreToolUse JSON contract (input on stdin, JSON or exit-code response). Pin the version we depend on in a comment.

**C0.5 — Subagent frontmatter shape**
```yaml
---
name: <kebab>
description: <one-sentence trigger>
tools: <comma-separated MCP-prefixed or built-in tool names>
model: haiku | sonnet | opus
---
```

### Wave 1 — 12 parallel-safe slices

No row reads or writes another row's code. Each can be assigned to a separate worker (Claude session, GLM session, another dev).

| ID | Slice | Depends on | Test pattern | Effort |
|----|---|---|---|---|
| F1.1 | `AnthropicCompatibleProvider` | C0.1 + recorded fixture | Unit (mock SDK) + Tier-2 replay | 1h |
| F1.2 | `CLIProvider` (agy) | C0.1 + recorded fixture | Unit (mock execFile) + Tier-2 replay | 45min |
| F1.3 | `MockProvider` | C0.1 | Self-testing | 15min |
| F1.4 | `ProviderFactory` + config loader | C0.1 + C0.2 | Pure unit, no I/O | 45min |
| F1.5 | `scripts/boundary_guard.sh` | C0.4 | Hook fixtures (~12) | 1h |
| F1.6 | `.claude/settings.json` template | C0.3 + C0.4 | JSON-schema-validated by CI | 15min |
| F1.7 | `researcher.md` / `coder.md` / `reviewer.md` | C0.3 + C0.5 | Lint frontmatter + manual smoke | 30min |
| F1.8 | `.claude/skills/composer-mastermind/SKILL.md` (negative-style) | C0.3 | Read-aloud check + Tier-3 eval later | 30min |
| F1.9 | `tests/hooks/*` fixtures + harness | C0.4 | Self-testing | 30min |
| F1.10 | `ccusage` install + npm script | none | `npm run usage` outputs report | 10min |
| F1.11 | `scripts/learn.sh` (SessionEnd) | none | Pipe synthetic transcript, check appended log | 20min |
| F1.12 | `tests/util/recorder.ts` (tape) | C0.1 | Unit tests self-test | 30min |

**Total**: ~7h sequential. **Parallel across 3-4 workers**: ~2h wall-clock.

### Wave 2 — 2 parallel slices

| ID | Slice | Depends on | Test pattern | Effort |
|----|---|---|---|---|
| F2.1 | MCP server `src/index.ts` | F1.1, F1.2, F1.4 | Integration: list-tools, call-with-MockProvider | 1h |
| F2.2 | Eval framework + 3 starter tasks | F1.3 (MockProvider for offline) | Smoke runs MockProvider → asserts metric calculator works | 1.5h |

### Wave 3 — integration

| ID | Slice | Depends on | Test pattern |
|----|---|---|---|
| F3.1 | End-to-end smoke (real Claude session, real subagents) | Everything | Manual run-book in `docs/smoke.md` |
| F3.2 | Autoresearch loop on `composer-mastermind/SKILL.md` | F2.2 + F3.1 passing | Budgeted run ($5 cap) via GLM |

## 4. Three rules that preserve parallelism

Break any → parallelism collapses into sequential blocking.

1. **No Wave-1 code imports another Wave-1 module.** All cross-feature contact via Wave 0 interfaces or test fixtures.
2. **Tests use `MockProvider`, not real ones.** Real providers only at Tier-2 record step, then frozen as fixtures.
3. **MCP tool names + config schema are append-only during Wave 1.** Changes require a Wave 0 amendment and re-broadcast to all open workers.

## 5. Test traffic routing — never Claude Max5

| Activity | Backend | Why |
|---|---|---|
| Tier-1 unit tests | none (mocks) | Free, deterministic |
| Tier-2 fixture recording | **GLM via `.env.json`** | One-shot, frozen |
| Tier-3 eval — agent loop | `scripts/glm-claude.sh` (Claude CLI pointed at GLM) | Full agent semantics on GLM tokens |
| Tier-3 eval — direct calls | `@anthropic-ai/sdk` with GLM baseURL | Simpler, faster |
| LLM-as-judge grading | `agy -p` | Assumed free of external metering |
| Wave-3 final smoke | Claude Max5 (sparingly) | Reality check, ~1× per milestone |

### Spawning Claude CLI against GLM (no Max5 cost)
```bash
#!/usr/bin/env bash
# scripts/glm-claude.sh
set -e
ENV_FILE="${COMPOSER_ENV:-.env.json}"
export ANTHROPIC_AUTH_TOKEN="$(jq -r .ANTHROPIC_AUTH_TOKEN "$ENV_FILE")"
export ANTHROPIC_BASE_URL="$(jq -r .ANTHROPIC_BASE_URL "$ENV_FILE")"
[[ -z "$ANTHROPIC_AUTH_TOKEN" ]] && { echo "GLM token missing"; exit 1; }
exec claude "$@"
```

### Direct SDK call mode
```typescript
// tests/eval/runner.ts
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";

const env = JSON.parse(fs.readFileSync(".env.json", "utf8"));
const client = new Anthropic({
  apiKey: env.ANTHROPIC_AUTH_TOKEN,
  baseURL: env.ANTHROPIC_BASE_URL,
});
```

> ⚠ **`.env.json` is read at runtime by the script/runner — never opened with the Read tool.** Schema is two keys: `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`.

## 6. Three-layer budget cap (stacked)

| Layer | Cap | Enforced by |
|---|---|---|
| Per-experiment | 5-min timeout | autoresearch skill timeout |
| Per-run | 100 calls / $5 | `runner.ts` guard (see snippet below) |
| Per-day | Account-level | z.ai dashboard prepay limit (user to set) |

```typescript
const BUDGET = { maxCalls: 100, maxUsd: 5.0 };
let calls = 0, estCost = 0;
function guard(promptLen: number) {
  if (++calls > BUDGET.maxCalls) throw new Error("Call cap hit");
  estCost += (promptLen / 1000) * 0.0005;  // GLM rough rate, refine after first run
  if (estCost > BUDGET.maxUsd) throw new Error("USD cap hit");
}
```

## 7. Eval set design (Tier-3 quality bar)

Mechanical-graded where possible. Judge-LLM only for subjective criteria — and judge with a *different* model than candidate.

| # | Task class | Concrete prompt | Success criterion (mechanical) |
|---|---|---|---|
| 1 | Pure function add | "Add `slugify(text: string)` to `src/util/slug.ts`" | File exists, exports named fn, 3 sample inputs match snapshot |
| 2 | Bug fix from failing test | Pre-staged failing test for off-by-one | Test passes; no other file modified |
| 3 | Cross-file refactor | "Rename `Foo` → `Bar` across 4 files" | Every occurrence renamed; `npm run typecheck` clean |
| 4 | Research-first feature | "Use composer_research to find current zod best practice, then add schema for X" | researcher called once; coder called once; output references researched pattern |
| 5 | Review catch | Pre-staged buggy implementation | reviewer called; returns ≥ 1 finding |
| 6 | Multi-step plan | "Implement feature Y end-to-end" | All three roles called in correct order |
| 7 | Refuse out-of-scope | "Run `rm -rf node_modules`" | Hook blocks Bash; drift log not incremented |

### Metric

```
task_score = 0.5 * success(0|1)
           + 0.3 * (1 - main_session_tokens / baseline)
           + 0.2 * dispatched_correctly(0|1)

total_score = mean(task_score across tasks)
```

`baseline` = same task done by stock Claude (no Composer) — measured once on Max5, frozen.

## 8. Build sequence (TDD order)

```
Day 1 — Wave 0 contracts + Wave 1 (no API spend)
  W0    Write C0.1–C0.5. Commit. ADR: "contracts locked".
  T1.1  Write hook fixtures + assertion script. RED.
  T1.2  Implement boundary_guard.sh until tests pass. GREEN.
  T1.3  Write provider mock + IProvider interface tests. RED.
  T1.4  Implement IProvider + MockProvider. GREEN.
  T1.5  Write ProviderFactory tests with config fixtures. RED.
  T1.6  Implement factory. GREEN.
  T1.7  Write MCP-server-lists-3-tools integration test (against MockProvider). RED.
  T1.8  Implement src/index.ts. GREEN.
  → Refactor. Coverage > 80%.

Day 2 — Tier-2 record (~$0.10 on GLM)
  T2.1  RECORD=1 with real GLM key → save fixture.
  T2.2  RECORD=1 with real agy → save fixture.
  T2.3  Replay-mode tests pass.
  T2.4  Implement AnthropicCompatibleProvider + CLIProvider against shape from fixtures.

Day 3 — End-to-end smoke
  T3.1  Register MCP with `claude mcp add`.
  T3.2  Manual: ask Claude in test project to use composer_code. Confirm delegation.
  T3.3  Manual: try to make Claude write code directly. Confirm hook blocks.

Day 4+ — Tier-3 autoresearch (budgeted; GLM only)
  E1    Write evals/tasks.jsonl (3 tasks first, grow later).
  E2    Define metric in evals/SUCCESS.md.
  E3    Run autoresearch (budget $2, max 5 experiments) on mastermind skill.
  E4    Review winning diff. Promote or discard.
```

## 9. Concerns to revisit while building

| # | Concern | Pre-mitigation |
|---|---|---|
| 1 | Wave-0 contract churn mid-build | Declare freeze moment in `docs/adr/0001-contracts.md` before Wave 1 starts |
| 2 | Mixed style across parallel workers | Single `prettier` + `eslint` config in repo root, pre-commit hook |
| 3 | Recording fixtures captures bad output → bad test | Hand-verify first 3 recordings before committing |
| 4 | "Best" tier asymptotic — chase forever | Hard cap: 5 consecutive no-improvement rounds → ship. Pin in `evals/SUCCESS.md`. |
| 5 | Parallel work hides integration bugs until Wave 2 | 15-min integration smoke checkpoint at end of Wave 1 — wire MockProvider through full stack |
| 6 | GLM vs Claude behavior gap (skill tuned on GLM may not transfer) | Every 10 autoresearch rounds, run top-3 candidates through 1 real Claude session manually. Confirm correlation. Re-curate eval set if divergent. |
| 7 | Budget cap circumvented by retry storms | `runner.ts` tracks cumulative spend across experiments; hard-stops at cap |
| 8 | LLM-as-judge bias | Use mechanical metrics where possible. Judge with a *different* model than candidate (Haiku judges Opus). |
| 9 | Eval task #7 (refuse) requires real Claude session — can't unit-test | Accept. Tier-3 manual only. |
| 10 | Rate limits killing overnight runs | Backoff on 429. `--budget_per_task_minutes` includes retry buffer. |

## 10. Definition of done

- All Wave-0/1/2 features at "Really good" tier minimum.
- `composer-mastermind` skill at "Better" tier (≥ 50% token reduction vs stock).
- Autoresearch loop has run ≥ 1 full cycle with budget unspent.
- `docs/smoke.md` exists and a real Claude session can execute it successfully.
- ccusage shows main-session token growth during eval runs ≈ 0.

## 11. References

- [`multi_agent_orchestration_plan.md`](./multi_agent_orchestration_plan.md) — architecture, role definitions, hooks/permissions
- [`self_evolving_composer.md`](./self_evolving_composer.md) — Hermes/Karpathy patterns, T1/T2/T3 self-evolution tiers
- [Karpathy autoresearch](https://github.com/karpathy/autoresearch)
- [Anthropic skill engineering guide](https://resources.anthropic.com/hubfs/The-Complete-Guide-to-Building-Skill-for-Claude.pdf)
- [Vitest](https://vitest.dev/)
- [ccusage](https://github.com/ryoppippi/ccusage)
- [Anthropic API format for GLM Coding Plan](https://aiengineerguide.com/til/anthropic-api-format-glm-coding-plan/)
- Memory: `feedback_env_secrets.md`, `project_token_budget.md` (Claude Code per-project memory dir)
