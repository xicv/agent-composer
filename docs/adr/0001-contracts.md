# ADR 0001 — Wave 0 Contracts Frozen

- **Date**: 2026-05-23
- **Status**: Accepted (frozen)
- **Supersedes**: none
- **Superseded by**: changing any C0.X requires a NEW ADR (no in-place edit) AND pausing every open Wave 1 worker until the new contract is re-broadcast.

## Context

Wave 1 of the Composer build (see [`docs/tdd_plan.md`](../tdd_plan.md) §3) spawns up to 12 parallel feature slices. Each slice is implementable in isolation **only if** its inputs (interface, schema, tool name, hook shape, frontmatter) are known and stable. Anything not pinned here becomes a synchronisation point and collapses parallelism back to serial.

Per `tdd_plan.md` §4 rule 3: *"MCP tool names + config schema are append-only during Wave 1. Changes require a Wave 0 amendment and re-broadcast to all open workers."* This ADR is that freeze record.

## Decision

The five contracts below (C0.1–C0.5) are locked.

**Append-only rule**: a new *optional* field is acceptable; renaming, removing, or making a previously-optional field required is NOT. Such a change demands a new ADR and a Wave 1 pause.

---

### C0.1 — `IProvider` TypeScript interface

**Path**: [`src/providers/IProvider.ts`](../../src/providers/IProvider.ts).

```typescript
export type ProviderId = "anthropic" | "openai_compatible" | "cli" | "mock";

export interface IProviderExecuteInput {
  prompt: string;
  context?: string;
  maxTokens?: number;
  cwd?: string;
}

export interface IProviderExecuteOutput {
  text: string;
  tokensIn?: number;
  tokensOut?: number;
}

export interface IProvider {
  readonly id: ProviderId;
  readonly modelLabel: string;
  healthCheck(): Promise<boolean>;
  execute(input: IProviderExecuteInput): Promise<IProviderExecuteOutput>;
}
```

The inline form quoted in `tdd_plan.md` §3 is structurally equivalent. Wave 1 workers may import the named types or rely on TypeScript's structural typing — both compile against the same surface.

---

### C0.2 — `composer.config.json` JSON Schema

**Path**: [`composer.config.schema.json`](../../composer.config.schema.json) (JSON Schema draft-07).

- **Required**: `roles.researcher`, `roles.coder`, `roles.reviewer`; each must specify `provider` ∈ {`anthropic`, `openai_compatible`, `cli`, `mock`}.
- **Optional per-role**: `apiKeyEnv` (string), `baseUrl` (uri), `model` (string), `cli` (string[], min 1 item).
- `additionalProperties: false` at every level — typos fail validation early instead of becoming silent defaults.
- Wave 1 F1.4 (`ProviderFactory` + config loader) validates via `zod` derived from this schema; CI may also lint via `ajv-cli`.

---

### C0.3 — MCP tool names (locked strings)

Referenced by (a) MCP server `registerTool()` calls, (b) each subagent's `tools:` allowlist, (c) `boundary_guard.sh` MCP-variant regex.

| Tool name | Input shape | Used by subagent |
|---|---|---|
| `composer_research` | `{ prompt: string, context?: string }` | `researcher.md` |
| `composer_code` | `{ prompt: string, context?: string }` | `coder.md` |
| `composer_review` | `{ prompt: string, diff: string }` | `reviewer.md` |
| `composer_review_claude` | `{ prompt: string, diff: string }` | `reviewer-claude.md` |

MCP namespace prefix when referenced from subagents or hooks: `mcp__composer__composer_research`, `mcp__composer__composer_code`, `mcp__composer__composer_review`, `mcp__composer__composer_review_claude`.

---

### C0.4 — `PreToolUse` hook JSON shape (Anthropic snapshot, 2026-05)

- **stdin**: JSON object `{ "hook_event_name": "PreToolUse", "tool_name": string, "tool_input": object, "session_id": string, ... }`
- **stdout** (optional): JSON `{ "permissionDecision": "allow"|"deny"|"ask", "permissionDecisionReason"?: string }`
- **Exit codes**:
  - `0` — pass-through; optional JSON on stdout is honoured.
  - `2` — block AND surface stderr into Claude's context (use for deterministic deny).
  - other non-zero — non-blocking warning; **do NOT rely on this for security**.

`scripts/boundary_guard.sh` (Wave 1 F1.5) emits `permissionDecision: "deny"` JSON and exits `0` (semantics carry the deny). Failure modes — missing `jq`, empty stdin, malformed JSON, `tool_name` absent — all fail **closed**: emit deny JSON, exit 0.

---

### C0.5 — Subagent frontmatter shape

**Path**: `.claude/agents/<role>.md`

```yaml
---
name: <kebab-case>
description: <one sentence; starts with "Use PROACTIVELY..." for auto-trigger>
tools: <comma-separated tool names; MCP-prefixed where applicable>
model: haiku | sonnet | opus
---
```

Locked tools allowlists (Wave 1 F1.7):

| Subagent | `tools:` |
|---|---|
| `researcher.md` | `mcp__composer__composer_research, Read, Glob` |
| `coder.md` | `mcp__composer__composer_code, Read, Glob, Edit, Update, Write, Bash` |
| `reviewer.md` | `mcp__composer__composer_review, Read, Glob` |
| `reviewer-claude.md` | `mcp__composer__composer_review_claude, Read, Glob` |

`Read` and `Glob` are present so the subagent can quote the right file path/snippet into the MCP-tool `prompt` argument. `coder.md` is the only subagent allowed to mutate files; `Edit`/`Update`/`Write` apply provider-authored patches, and `Bash` is limited to setup, inspection, and verification. `NotebookEdit` remains forbidden in every subagent's allowlist. The boundary is the allowlist plus the PreToolUse hook, not policy text alone.

---

## Consequences

**Positive**:
- Wave 1's 12 slices can fork fully in parallel — no inter-worker coordination needed during the build window.
- Provider swap (GLM → Kimi / MiniMax) becomes a config-file edit, no code change.
- Boundary enforcement is testable in isolation (`tests/hooks/*.json` fixtures), independent of provider work.

**Negative**:
- A mistake here is expensive: re-broadcast costs ~12 worker context switches.
- Drift detection requires Wave 1 PR descriptions to mention "uses C0.X" so Wave 2 reviewers can grep.

## Verification

- `npx tsc --noEmit` clean against `src/providers/IProvider.ts`.
- `jq empty composer.config.schema.json` clean.
- `docs/tdd_plan.md` Wave 1 task table cross-references C0.1–C0.5 by ID.

## References

- [`docs/multi_agent_orchestration_plan.md`](../multi_agent_orchestration_plan.md) §3 (Two-Layer Architecture), §4 (MCP Server), §6 (Boundary Enforcement)
- [`docs/tdd_plan.md`](../tdd_plan.md) §3 (Wave 0/1 graph), §4 (parallelism rules)
- [`docs/self_evolving_composer.md`](../self_evolving_composer.md) §2 (T1/T2/T3 tiers — out of scope for Wave 0)

---

## Amendments (append-only)

### 2026-05-23 — Wave-1 advisor pass

Optional fields added; no rename, no removal; **append-only rule honoured**.

- **C0.3**: each tool may now declare an `annotations` object — `title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` — per MCP SDK 1.29. Canonical per-tool matrix lives in `multi_agent_orchestration_plan.md` §4.
- **C0.5**: subagent + skill `description` fields adopt the `"Use when..."` opening per Anthropic's May-2026 skill-engineering guidance. Old `"Use PROACTIVELY..."` form still parses; no breakage.
- **Tech debt** (NOT applied): MCP SDK 2.0-alpha returns JSON-RPC `-32602` for tool errors instead of `{isError: true}`. Pin to SDK 1.29 until 2.0 stabilises; `tests/mcp/server.test.ts` will need a one-line update on upgrade.


### 2026-05-23 — Wave-3 Step 1 (boundary_guard extensions)

Two append-only extensions to **C0.4** (PreToolUse hook), plus a sibling PR-gate script.

1. **`COMPOSER_DANGEROUSLY_BYPASS_PERMISSIONS`** env var (default unset). When set to `"1"` or `"true"`, `scripts/boundary_guard.sh` exits `0` immediately with a stderr warning, bypassing all deny logic. Purpose: bootstrap dev sessions where the locked orchestrator session cannot write files itself. **MUST NOT** be set in CI, production, or any runtime path. Cline-style — verbose name discourages accidental use. Friction is the safety feature.

2. **`COMPOSER_STOP_EVOLVE_FILE`** sentinel mechanism. When the file at `${COMPOSER_STOP_EVOLVE_FILE:-$CLAUDE_PROJECT_DIR/STOP_EVOLVE}` exists, `boundary_guard.sh` denies any `mcp__composer__*` tool call. Purpose: hard kill-switch for nightly self-evolution Routines and ad-hoc `/evolve` runs. Non-composer tools remain subject to the normal block list.

Neither extension renames or removes any prior field — append-only rule honoured. Companion script: `scripts/evolve_check_diff.sh` (PR-gate enforcing the autoresearch diff scope whitelist; harness: `tests/scripts/run.sh`). Whitelist regex set:

```
^\.claude/agents/[^/]+\.md$
^\.claude/skills/composer-mastermind/SKILL\.md$
^evals/tasks/[^/]+\.json$
^evals/tasks\.jsonl$
```

The forthcoming ADR 0003 will document the full self-evolution architecture; this amendment captures only the safety primitives that ship in Wave 3 Step 1.

### 2026-06-01 — Codex CLI pilot + shared handoff packets

Append-only extensions; no existing tool, provider ID, or required config field changed.

- **C0.3**: added `composer_handoff_create` with input
  `{ objective: string, contextSummary?: string, constraints?: string[], relevantFiles?: string[], acceptanceCriteria?: string[], decisions?: string[], openQuestions?: string[], artifacts?: HandoffArtifact[], briefPath?: string }`.
  It writes a validated packet under `.composer/handoffs/<runId>.json` and returns `{ runId, handoffPath, objective }`.
- **C0.3**: `composer_research`, `composer_code`, `composer_code_chain`, `composer_code_cli`, `composer_review`, and `composer_review_claude` now accept optional `handoffPath?: string`. The server only reads paths resolving under `.composer/handoffs/`, formats the packet as compact context, and prepends it to the provider call.
- **C0.1/C0.2**: Codex is piloted through the existing `cli` provider, e.g. `["codex", "exec", "--sandbox", "workspace-write", "-c", "approval_policy=\"never\""]`. No `ProviderId` enum value was added; a first-class Codex provider is deferred until JSONL event parsing and usage telemetry are needed.
- **C0.1**: `IProviderExecuteInput.cwd?: string` is an optional append-only field. `composer_code_cli` passes the MCP server root through it so CLI executors apply edits in the intended project even when tests or future hosts construct the server with an explicit root.
- **CLIProvider**: when the configured command is `codex exec`, the provider appends a temporary `--output-last-message <file>` flag unless the user already supplied one. The returned MCP payload is Codex's final summary when available, not the raw stdout/event stream. The provider refuses explicit `danger-full-access` / bypass-sandbox Codex configs unless `COMPOSER_ALLOW_DANGEROUS_CODEX=1` is set in an externally sandboxed environment.
- **Research route**: `researcher` may use Codex's global web-search flag before the `exec` subcommand, e.g. `["codex", "--search", "--ask-for-approval", "never", "exec", "--sandbox", "read-only"]`. CLIProvider treats this as Codex exec for final-message capture and safety checks.

### 2026-06-02 — Premium Claude review escalation

Append-only extension; routine review remains `composer_review` through `agy`.

- **C0.2**: added optional `roles.reviewerClaude`. It uses the existing `cli` provider; no provider enum value was added.
- **C0.3**: added `composer_review_claude` with the same `{ prompt, diff, handoffPath? }` input shape as `composer_review`.
- **C0.5**: added `reviewer-claude.md` with the allowlist `mcp__composer__composer_review_claude, Read, Glob`.
- **Default config**: `reviewerClaude` invokes bounded `claude -p --model opus` with read/test tools only and `--max-budget-usd 0.50`.
