// C0.3 — locked MCP tool names. Referenced by subagent allowlists +
// boundary_guard.sh; do not rename without a new ADR.
export const COMPOSER_RESEARCH = "composer_research" as const;
export const COMPOSER_CODE = "composer_code" as const;
export const COMPOSER_REVIEW = "composer_review" as const;
export const COMPOSER_REVIEW_CLAUDE = "composer_review_claude" as const;
export const COMPOSER_CODE_CLI = "composer_code_cli" as const;
export const COMPOSER_CODE_CHAIN = "composer_code_chain" as const;
export const COMPOSER_HANDOFF_CREATE = "composer_handoff_create" as const;
export const COMPOSER_CODEX_LIFECYCLE_DECIDE = "composer_codex_lifecycle_decide" as const;
export const COMPOSER_CODEX_LIFECYCLE_RUN = "composer_codex_lifecycle_run" as const;
export const COMPOSER_CODEX_LIFECYCLE_RESULT = "composer_codex_lifecycle_result" as const;
export const COMPOSER_CONFIG_GET = "composer_config_get" as const;
export const COMPOSER_CONFIG_SET = "composer_config_set" as const;
export const COMPOSER_ORACLE_PLAN = "composer_oracle_plan" as const;
export const COMPOSER_ORACLE_JOB_START = "composer_oracle_job_start" as const;
export const COMPOSER_ORACLE_JOB_RESULT = "composer_oracle_job_result" as const;

export const RESEARCH_DESCRIPTION =
  "Default off-CC research lane for documentation lookup, web search, " +
  "current API shape, and external context. Returns a bounded summary; call " +
  "directly unless raw upstream output needs separate subagent isolation.";

export const CODE_DESCRIPTION =
  "LEGACY patch-only GLM authoring lane. Use only when you explicitly need " +
  "GLM to return a diff/text WITHOUT applying files. For normal code writing, " +
  "refactoring, debugging, and implementation, prefer composer_code_cli " +
  "(default) or composer_code_chain (GLM complete-file fallback).";

export const CODE_CHAIN_DESCRIPTION =
  "Preferred for substantial code: GLM AUTHORS the code (off-CC), then the " +
  "Composer server APPLIES it to disk deterministically (off-CC), then gate it through " +
  "composer_review. The orchestrator only calls this once and relays the " +
  "summary — it never generates or writes code itself. Combines GLM code " +
  "quality with off-CC application (keeps the main session lean). Returns a " +
  "summary of files written.";

export const CODE_CLI_DESCRIPTION =
  "Generate AND APPLY code changes directly to disk via the CLI executor " +
  "(Codex/agy/Gemini), which runs in the server working directory and edits files " +
  "itself. Returns ONLY a summary of what changed. Use this to offload BOTH " +
  "generation and file-writing off the main session: the orchestrator does " +
  "NOT call Edit/Write — the executor already applied the changes. Prefer " +
  "this for multi-file or substantial edits to keep the main context lean.";

export const REVIEW_DESCRIPTION =
  "Default off-CC review lane for diff critique and bug-finding before " +
  "integration. Provide the diff inline and ask for repo-appropriate targeted " +
  "checks. Returns a bounded summary; call directly unless raw output needs " +
  "separate subagent isolation.";

export const REVIEW_CLAUDE_DESCRIPTION =
  "Premium Claude review lane for high-risk diffs, security-sensitive changes, " +
  "or when the user explicitly asks for Claude review. Keep composer_review " +
  "as the default gate; call this directly as a second-opinion escalation.";

export const HANDOFF_CREATE_DESCRIPTION =
  "Create a shared, provider-neutral handoff packet under .composer/handoffs. " +
  "Use this before multi-agent or multi-provider work so Codex, GLM, agy, " +
  "and reviewers receive the same compact objective, constraints, files, " +
  "decisions, and acceptance criteria without copying the full transcript.";

export const CODEX_LIFECYCLE_DECIDE_DESCRIPTION =
  "Deterministically decide whether Codex should participate in a lifecycle " +
  "step (plan, code-apply, test-failure, failed attempts, or passive warm " +
  "checks). This is policy-only: it never invokes Codex and returns a compact " +
  "JSON decision so Coco can skip, ask, or run within codexLifecycle config.";

export const CODEX_LIFECYCLE_RUN_DESCRIPTION =
  "Run a Codex lifecycle companion pass and persist a durable result record. " +
  "Foreground execution returns the result immediately; background execution " +
  "returns a jobId/resultPath that composer_codex_lifecycle_result can read " +
  "later. The companion pass is advisory and must not silently mutate files.";

export const CODEX_LIFECYCLE_RESULT_DESCRIPTION =
  "Read a durable Codex lifecycle result by jobId, or the latest lifecycle " +
  "result when jobId is omitted. Use this to bring background Codex output " +
  "back into the main development loop.";

export const CONFIG_GET_DESCRIPTION =
  "Read the active, project, or global Composer config path and validated " +
  "config. Use this before changing Composer behavior from Claude Code.";

export const CONFIG_SET_DESCRIPTION =
  "Safely update Composer config toggles from Claude Code. Supports Codex " +
  "lifecycle, lifecycle fallback, and pre-commit review gate settings; validates " +
  "the resulting composer.config.json before writing.";

export const ORACLE_PLAN_DESCRIPTION =
  "Opt-in planning/review/debug lane backed by ChatGPT Pro through the " +
  "Oracle browser (scripts/oracle-pro-safe.sh). Use for architecture, " +
  "feature planning, migration design, hard root-cause debugging, or " +
  "high-risk review when you want extended reasoning from ChatGPT Pro. " +
  "The `mode` argument selects thinking depth (quick|standard|deep|plan|" +
  "review|debug|research); omit or use auto to let the script classify. " +
  "Returns a bounded summary; the full answer is saved under " +
  ".composer/oracle/answers/. Advisory planning only — file edits still go " +
  "through composer_code_cli.";

export const ORACLE_JOB_START_DESCRIPTION =
  "Start a NON-BLOCKING ChatGPT Pro (Oracle) job and return a jobId " +
  "immediately. Use for long deep-research or large architectural/review " +
  "runs, or when the user explicitly says not to block. For normal " +
  "planning that the next step depends on, prefer the synchronous " +
  "composer_oracle_plan instead. Poll composer_oracle_job_result with the " +
  "jobId to retrieve the answer. Advisory only — never edits files. Runs " +
  "non-blocking WITHIN the Composer server process (server-lifetime), not an " +
  "OS-detached worker — if the server restarts mid-run the job is reconciled " +
  "to 'failed'.";

export const ORACLE_JOB_RESULT_DESCRIPTION =
  "Read a durable Oracle job by jobId (or the latest when omitted). " +
  "Returns status (queued|running|succeeded|failed) and, when succeeded, " +
  "the bounded answer text. Optional waitMs briefly blocks until the job " +
  "reaches a terminal state or the wait elapses.";
