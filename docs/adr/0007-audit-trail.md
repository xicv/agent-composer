# ADR 0007 - Append-Only Audit/Route-Outcome Trail

- **Date**: 2026-06-13
- **Status**: Accepted
- **Companion**: ADR 0001 (contracts), ADR 0004 (codex lifecycle), ADR 0006 (modes)

## Context

As Composer routes tasks across GLM, Codex, agy, and Oracle, there is no durable record of what was dispatched, which route was taken, what the outcome was, or whether a correction occurred. Without this, route accuracy cannot be measured and the /evolve self-improvement loop has no ground truth to act on.

## Decision

Add an append-only JSONL audit trail stored under `<stateDir>/audit/<projectStateKey>.jsonl` (0o600 file, 0o700 dirs) with the same state-dir conventions as the codex-lifecycle job store (ADR 0004).

### Key design choices

1. **Explicit orchestrator-driven recording** via `composer_audit_record` MCP tool.
   - Rationale: auto-instrumenting other tool handlers would make `composer_route_decide` non-read-only, add latency tax to every call, and couple the audit path to execution paths that should stay independent.
   - The orchestrator (Claude) calls `composer_audit_record` after each dispatch, passing a `runId` to group a feature's events.

2. **`composer_audit_read`** for inspection and export (JSON or markdown). Supports `runId` filter and `limit`.

3. **`readAuditFailures()`** helper exposed from `src/util/auditLog.ts` for future `/evolve` consumption. Deep operator-switch integration is deferred; the manual-promotion guardrail from ADR 0003 is preserved.

4. **Security**: audit dir lstat-guarded against symlinks (same pattern as codex-lifecycle job dir). Files written with mode 0o600 on creation.

5. **Cleanup**: `src/cli/cleanup.ts` includes the `audit` state dir in its cleanup roots so old JSONL files are pruned by `agent-composer cleanup --state`.

## Consequences

Positive:
- Route accuracy becomes measurable: orchestrator records decisions + outcomes; future /evolve reads failures and corrections.
- No performance tax on normal tool calls (explicit recording only).
- `composer_route_decide` remains read-only (ADR 0001 annotation contract preserved).

Negative:
- Orchestrator must call `composer_audit_record` explicitly; passive gaps in the record are possible if the orchestrator skips it.
- Deep /evolve integration (reading failures to auto-promote routes) is deferred to Wave 4.
