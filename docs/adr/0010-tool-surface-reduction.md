# ADR 0010 — Tool-surface reduction (hard-remove) + evolve flag-gate

- Status: Accepted
- Date: 2026-06-25
- Supersedes/Amends: C0.3 (locked MCP tool names, append-only) — this ADR is the new-ADR escape hatch ADR 0001 requires for tool removal.

## Context

The MCP tool surface has grown to ~30 tools. Mid-2026 research on MCP tool-surface discipline (Anthropic "Building Effective Agents"; MCP spec 2025-06-18) shows that large/overlapping tool sets degrade model tool-selection and consume cached schema tokens on every orchestrator turn. Dogfood evidence: `composer_code_cli` won every code build; `composer_code` is already labelled LEGACY and `composer_code_chain` is rarely chosen over `_cli`. The 3 audit tools and 5 goal tools are finer-grained than daily orchestration needs. Separately, the self-evolution engine (`src/evolve/`, `scripts/run-evolve.ts`, ~1.8k LOC + 5 resilience layers) produced ZERO promotions across 6+ real runs (documented flat plateau in docs/STATUS.md) yet sits in the default daily surface.

## Decision

1. CODE LANE — remove `composer_code` and `composer_code_chain`. `composer_code_cli` becomes the sole code-writing tool. (Codex/CLI generate-and-apply already covers both prior behaviours.)
2. AUDIT LANE — replace `composer_audit_record` / `composer_audit_read` / `composer_audit_summary` with ONE tool `composer_audit` taking a discriminated `action: "record" | "read" | "summary"`.
3. GOAL LANE — replace `composer_goal_start` / `composer_goal_status` / `composer_goal_clear` / `composer_goal_report` with ONE tool `composer_goal` taking `action: "start" | "status" | "clear" | "report"`. KEEP `composer_goal_step` as a separate tool (it is the state-advancing verb with distinct inputs/semantics).
4. EVOLVE — de-register the evolve surface from default; gate it behind `COMPOSER_ENABLE_EVOLVE=1`. Code and tests remain in the repo (reversible).

Net effect: ~30 → ~23 tools (code −2, audit −2, goal −3).

## Consequences

- BREAKING for any external caller of the removed names. No deprecation window (hard remove, per owner decision 2026-06-25).
- Update sites: `src/server/toolDescriptions.ts` (C0.3 constants), `src/server.ts` registration, dispatch/routing logic, `.claude/agents/*.md` allowlists, both `composer-mastermind/SKILL.md` copies, `composer.config.schema.json` if referenced, `scripts/boundary_guard.sh` + `scripts/dispatch_guard.sh` tool references, and `tests/mcp/server.test.ts`.
- Migration: `composer_code`/`composer_code_chain` → `composer_code_cli`; `composer_audit_*` → `composer_audit({action})`; `composer_goal_{start,status,clear,report}` → `composer_goal({action})`; `composer_goal_step` unchanged.

## Alternatives considered

- Deprecate-then-remove (keep warning aliases one release): rejected by owner in favour of a clean hard cut.
- Keep evolve in the default surface: rejected — zero promotions in 6+ runs; it taxes the daily surface without daily value.
