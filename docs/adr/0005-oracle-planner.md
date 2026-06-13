# ADR 0005 — Oracle planner lane (ChatGPT Pro as opt-in planning oracle)

Date: 2026-06-12
Status: Accepted
Relates to: ADR 0001 (frozen contracts, append-only)

## Context

ChatGPT Pro web, driven through the steipete/oracle browser CLI, offers
extended "Pro" reasoning useful for architecture, feature planning, migration
design, hard debugging, and high-risk review. We want it as a co-oracle the
orchestrator can opt into — without pulling code authoring back into the main
Claude session, and without making it the default research lane (which must
stay fast/cheap on Codex to protect the token/latency North Star).

## Decision

1. New OPTIONAL role `oraclePlanner` — an append-only addition to the fixed
   roles set; `roles` stays `additionalProperties: false`. Mirrored in
   `src/config/schema.ts` (`RoleNameSchema` + `ComposerConfigSchema.roles`) and
   `composer.config.schema.json`. It is NOT a Codex lifecycle fallback role;
   `CodexLifecycleFallbackSchema` is pinned to the original five roles so the
   Oracle browser never runs as a lifecycle fallback.
2. New MCP tool `composer_oracle_plan` (locked name, append-only per ADR 0001).
   Inputs: `prompt` (required), `mode`
   (auto|quick|standard|deep|plan|review|debug|research, optional), `context`,
   `handoffPath`. The tool maps `mode != auto` to an `[oracle:<mode>]` prefix on
   the prompt; the backing script classifies on that marker. Annotations:
   readOnly, openWorld (hits ChatGPT/web), non-destructive, non-idempotent.
3. Default wiring: `oraclePlanner` → `bash scripts/oracle-plan-mcp.sh --mode
   auto --` (a thin wrapper that runs `oracle-pro-safe.sh` and emits the final answer file content to stdout) (CLIProvider appends the prompt as the final argv). `researcher`
   stays on Codex — Oracle is opt-in only; the researcher role is deliberately
   NOT repointed to the Oracle router.
4. The script probes the installed Oracle CLI for optional/hidden flags and
   degrades gracefully (no hardcoded flag assumptions). Thinking depth is
   selected primarily by model (`gpt-5.2-instant` / `gpt-5.5` / `gpt-5.5-pro`)
   plus the additive `--browser-thinking-time` flag when the binary supports it.
5. Async lane (optional, non-blocking): two additional locked MCP tools
   (append-only per ADR 0001) — `composer_oracle_job_start` returns a `jobId`
   immediately and runs the Oracle call in the background; `composer_oracle_job_result`
   reads the durable job record by `jobId` (or the latest) and returns the bounded
   answer once `succeeded`. Jobs persist under the Composer state dir
   (`oracle-jobs/`, mirroring the Codex lifecycle job store in
   `src/util/codexLifecycleJob.ts`). The async lane reuses the `oraclePlanner`
   role and is advisory-only like the sync tool. Synchronous `composer_oracle_plan`
   stays the DEFAULT; async is for long deep-research / large review runs or when
   the user explicitly does not want to block. Auto-async for every deep/review/debug
   call is deliberately NOT done.

## Consequences

- Advisory only: `composer_oracle_plan` never writes files. Code changes still
  go through `composer_code_cli` and a `composer_review` gate.
- Browser automation of ChatGPT is a personal, supervised workflow (consumer
  ToS sensitivity) — not a headless or high-volume API. Requires a one-time
  manual browser login.
- Full answers persist under `.composer/oracle/answers/` (gitignored); the tool
  returns only a bounded summary to keep the main context lean.
- Async Oracle jobs are non-blocking within the Composer server process
  (server-lifetime), not OS-detached durable workers; a job is reconciled to
  `failed` if the server restarts before it completes. A truly detached durable
  lane is out of scope.
- Live use requires the active runtime config to include the `oraclePlanner`
  role and a logged-in Oracle browser profile.

## Out of scope (deferred)

- A ChatGPT Apps-SDK / MCP connector exposing local handoff tools to ChatGPT web.
- Using browser-automation-skill as a UI-verification provider after Codex edits.
- Auto-escalation routing of `researcher` → Oracle (explicitly rejected here to
  protect the token/latency economy).
