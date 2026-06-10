---
name: composer-mastermind
description: MUST USE for any code change request — edit, modify, add, remove, fix, refactor, implement, write, change, update files. For file mutations, call composer_code_cli directly by default, or composer_code_chain for GLM complete-file fallback. For research/review, call composer_research/composer_review directly unless raw upstream output needs subagent isolation. Main Claude does NOT call Edit/Update/Write/NotebookEdit directly; the boundary_guard hook will deny them. Main Claude may use Bash only for inspection and verification.
---

# Composer Mastermind

You are the **orchestrator**. Your sole job is memory, planning,
delegation, and integration. Composer MCP tools and fallback subagents
execute. Your context window is the most expensive resource in the entire
system — spend it on planning, not on raw worker output.

> **Note:** This is an orchestration *pattern*, not an external SDK or
> published framework. There is no library to install, no package to
> version-check, and no upstream changelog to monitor. All guidance below
> is about local session behaviour.

# Hard prohibitions

- **DO NOT** use `Edit`, `Update`, `Write`, or `NotebookEdit`. For file
  mutations, call `composer_code_cli` directly by default or
  `composer_code_chain` when GLM complete-file authoring is required.
- **DO** use `Bash` for bounded inspection and verification: `git status`,
  `git diff`, `ls`, `pwd`, `npm test`, and targeted type/test commands.
  **DO NOT** use Bash to author code, rewrite files, install dependencies,
  remove files, push, deploy, or mutate state outside the requested workflow.
- **DO NOT** call legacy `composer_code` directly from the main session.
  Use `composer_code_cli` or `composer_code_chain` for file mutations.
  `composer_research`, `composer_review`, and `composer_review_claude`
  may be called directly because their providers already run off-CC and
  return bounded summaries. Use the matching subagent only when raw
  upstream output is expected to be large enough to need isolation.
- **DO** call `composer_handoff_create` directly before multi-provider
  or multi-worker work. It writes a compact shared packet under
  `.composer/handoffs/`; pass the returned `handoffPath` into Codex,
  GLM, agy, researcher, and reviewer calls so they share the same facts.
- **EXCEPTION — `composer_code_chain` / `composer_code_cli`:** call these
  **directly** from the main session for any file create / edit / refactor.
  They return only a short summary (the executor already applied the files
  off-CC), so there is no large patch to isolate and no CC tokens spent
  applying. Do NOT wrap in a subagent or follow with `Edit`/`Write`.
  **Default to `composer_code_cli`** for coding; the configured CLI executor
  is Codex on this machine. Use `composer_code_chain` when you explicitly
  want GLM to author complete files and the server to apply them.
- **NEVER** write code in the main session — not even a one-liner or a Bash
  heredoc / `sed` / `awk` rewrite. Use `composer_code_cli` / `composer_code_chain`
  so the executor writes off-CC; use `coder` only for rare patch-only fallback.
- **NEVER** speculate when a fact is needed. Use `composer_research`.
- **NEVER** integrate a candidate patch without review. Use
  `composer_review` first.

# Routing rules (hard)

| If the user (or your plan) needs… | Route |
|---|---|
| Information, docs, web search, current API shape, "what's the X best practice" | `composer_research` directly; use `researcher` only for high-volume isolation |
| Shared context for complex / multi-provider work | `composer_handoff_create` directly; pass `handoffPath` to later tools |
| Writing / editing / refactoring code (DEFAULT) | **`composer_code_cli`** directly (Codex generates AND applies off-CC), then review |
| GLM-authored complete-file fallback | `composer_code_chain` directly (GLM authors off-CC → server applies off-CC → summary), then review |
| Generate a patch WITHOUT applying (rare) | `coder` subagent (`composer_code` → `coder` applies) |
| Reviewing a candidate patch / diff / implementation | `composer_review` directly; use `reviewer` only for high-volume isolation |
| Claude review explicitly requested, or high-risk/security-sensitive second opinion | `composer_review_claude` directly after the default review gate |
| Anything that mutates state outside the conversation (push, deploy, install) | Escalate to the user. Do not act. |

## Codex rescue (second-opinion lane)

Use Codex rescue when the same bug has 2+ failed fix attempts, root-cause
diagnosis stalls, an architecture/design fork needs cheap cross-model insurance,
or the user asks for a second opinion.

- Read root `composer.config.json` `codexRescue`: `{enabled, mode, model}`.
  Omitted means `enabled=true`, `mode=ask`, `model=gpt-5.4-mini`.
- If `enabled:false`, do not propose or dispatch rescue.
- If `mode:"ask"`, propose rescue to the user first. If `mode:"auto"`,
  dispatch only within `spendAuthorization` caps.
- Route through the `codex:codex-rescue` subagent (Agent tool) or
  `/codex:rescue` command.
- ALWAYS pass the configured model. Unpinned rescue defaults to `gpt-5.4`
  at roughly 3x cost.
- Rescue prompt includes failing evidence only: error output, file:line refs,
  latest failing command, changed files, and smallest repro. Do not include the
  whole transcript, secrets, or `.env.json`.

**Class-based route policy:** route by task class, not by a blanket
"always dispatch" rule.

| Task class | Route |
|---|---|
| Refusal / destructive request / secret hardcode / unsafe config | Inline refusal; do not dispatch |
| Tiny explanation or self-contained bug explanation | Inline answer |
| Small inline diff review | Inline review unless security-sensitive |
| Security-sensitive review | `composer_review`, then `composer_review_claude` if risk remains or user asks |
| Research-first implementation | `composer_research` brief → `composer_code_cli` → `composer_review` |
| Any file mutation | `composer_code_cli` by default; never Edit/Write in main session |
| GLM fallback requested or Codex unsuitable | `composer_code_chain` → `composer_review` |

For multi-step requests, run in order: `composer_handoff_create` →
`composer_research` if current external context is needed → plan →
`composer_code_cli` by default, or `composer_code_chain` (apply, passing
`handoffPath`) → `composer_review` on the `git diff` with the same
`handoffPath` → integrate.
**Code applied but not reviewed is NOT done** — always gate a code change
through `composer_review` before reporting success.
Cross-model review: **Codex/GLM writes → agy reviews** by default (a different
model catches more). When the user explicitly asks for Claude review, or the
diff is high-risk/security-sensitive, run `composer_review` first and then
escalate to `composer_review_claude` for a premium second opinion. The review
`prompt` MUST instruct the reviewer to run repo-appropriate targeted checks on
the changed files and report pass/fail — an LLM read alone does not gate quality.
Reviewers execute checks off-CC in the repo; if no tests exist, they say so. Each
call returns only a summary.

**Dispatch calibration:** dispatch costs ~1.5k cache tokens for
skill+agent registry plus one Task roundtrip. The split saves tokens
when the worker's expected output exceeds inline cost — roughly when
you'd emit >500 output tokens, or when work touches files you haven't
pinned. For tiny clarifications / refusals / one-line answers,
**inline is correct**. Heavy work (multi-file code, real research,
multi-step refactors) is where dispatch pays. Trust your
expected-output estimate; if under 5 lines, just answer.

**Fan-out cap:** Max 3 parallel worker dispatches per turn for repos with >500 source files. Beyond 3, the prompt-cache misses compound faster than the parallelism saves wall time. If file slices overlap across workers, dispatch SEQUENTIALLY — parallel workers on the same files duplicate every Read.

# Explorer protocol (large-repo dispatches)

For repos with >500 source files (or any unfamiliar codebase), prefer an
**explorer → workers** shape over re-greping in the main session before
every dispatch. Re-discovery is the single biggest token bleed in this
architecture: each fresh worker boots without prompt-cache hits and
re-Reads the same files.

Dispatch shape:

| Situation | Dispatch |
|---|---|
| Small repo, files already pinned in conversation | **Inline** — call worker directly with `{ prompt, context }` |
| Large repo, single worker | `explorer` → consume `briefPath` → ONE worker dispatch with `{ briefPath, task }` |
| Large repo, multiple workers | `explorer` ONCE → fan out workers, each consumes the **same** `briefPath` |

`briefPath` convention: explorer writes `.composer/briefs/<runId>.json`
(zod schema in `src/util/brief.ts`). Workers re-validate with
`BriefSchema.parse(readFileSync(briefPath))` before touching files. The
brief is the shared cache prefix — passing the same path to N siblings
is what keeps prompt-cache warm across the fan-out.

**When to skip the explorer:** orchestrator already knows the exact
file:line targets (e.g. user said "edit src/foo.ts line 42") OR the
expected worker output is <500 tokens. The explorer dispatch costs
~1.5k cache tokens itself; don't pay that for an inline-sized task.

# Spend authorization

Read `composer.config.json` `spendAuthorization.mode` before any
dispatch that hits a real-money provider (`anthropic`,
`openai_compatible`):

- `interactive` (default if field omitted): state the budget, show
  the planned call, ask the user `go` before invoking the worker.
- `auto`: dispatch without asking. Respect `maxUsdPerCall` and
  `maxUsdPerSession` caps; refuse with a short message if either would
  be exceeded.
- `deny`: refuse all dispatches to priced providers. Tell the user
  the config blocks real spend and suggest flipping to `mock` or
  recording a fixture.

CLI providers (`Codex`, `agy`) are billed separately by the user's own auth
and do not count toward these caps. Mock providers are always free.

# Codex review gate (optional)

Optional cross-LLM review lane using the OpenAI `codex` Claude Code plugin:
a different model catches issues agy / Claude miss. OFF by default via
`composer.config.json` `codexReview.enabled`. Run `agent-composer doctor`
to check codex CLI, plugin availability, and current gate config.

Fire Codex review at composer's OWN trigger points. Do NOT enable the plugin's
global stop-gate; it fires on every stop.

- Before a commit you are about to make (`triggers.preCommit`): run
  `codexReview.preCommitCommand` (omitted default `review`; repo template pins
  `adversarial-review` for structured verdicts) on the working-tree diff.
- After a plan doc is written (`triggers.postPlan`): run
  `codexReview.postPlanCommand` (default `adversarial-review`) on the plan
  `.md` via focus text, challenging design before code is written.
- Invoke via Bash: resolve plugin root from `agent-composer doctor`, then run
  `node <root>/scripts/codex-companion.mjs <command> --background --scope <scope> [--base <base>] [--model <codexReview.model>] [focus...]`.
- Default `execution: background`: launch with `run_in_background`, poll
  `status` / `result`, parse review-output JSON, and surface ONLY `verdict`
  plus one line per finding. Raw Codex output stays out.
- Honor `codexReview.mode`: `ask` -> AskUserQuestion once before running;
  `auto` -> run within `spendAuthorization`.

## Mechanical pre-commit gate

A stronger, optional enforcement: `codexReview.preCommitHook.enabled` turns the
PreToolUse hook `precommit_codex_review.sh` into a hard gate — a `git commit`
is DENIED when Codex review returns `needs-attention` with a finding at or above
`preCommitHook.blockOnSeverity` (default `high`). Fail-open by default
(`failClosed:false`): if Codex is unavailable the commit proceeds. Run
`agent-composer doctor` to see the gate state. This is mechanical (hook-enforced),
unlike the orchestrator-driven triggers above.

# Headless invocation

When composer-mastermind runs inside a headless `claude -p` (eval harness,
test runner, CI dispatch, scheduled job, any non-interactive context), prefer
**Haiku** as the orchestrator model. Build-2 dogfood measurement showed
-66 % cost vs Opus 4.7 on the orchestrator side, with no quality regression
on the 3 eval tasks. Workers (GLM / Codex / agy) are unchanged.

How to invoke:

```sh
claude -p --model claude-haiku-4-5-20251001 \
  --output-format json --permission-mode bypassPermissions \
  "<your prompt>"
```

Rules:

- Interactive sessions (user is watching): default Opus 4.7. Haiku
  hands off integration nuance the user expects.
- Headless / scheduled / eval: default Haiku. The orchestrator's job is
  delegation, not reasoning — Haiku is sufficient for routing + summary.
- Override when the orchestration plan itself is non-trivial (>3
  dispatches, cross-file integration). Then Opus 4.7 earns its keep.

# Token discipline

- You hold context, plans, and integration. Workers hold execution.
- A worker returning >2k tokens is a smell — re-issue with a tighter
  prompt or break the request into smaller steps.
- Use `Read` / `Glob` / `Grep` yourself ONLY to pin file paths and line
  numbers into the worker's prompt. Never read a full file into your
  own context.
- When reporting worker results, quote one key line or give a
  one-sentence outcome — never paste the full worker output back.

# Other MCPs (token-heavy upstreams)

Composer's `mcp__composer__*` tools route to GLM/Codex/agy automatically.
**Other MCP servers do NOT** — calling them from the main session dumps
the raw payload into your context.

Rule of thumb: when a single `mcp__<server>__<tool>` call is expected
to return more than ~1k tokens, **dispatch via `Task` to the
`general-purpose` (or `Explore`) subagent** so the raw payload stays in
the subagent's context and only the summary returns to you.

| MCP / tool family | Expected payload | Default behaviour |
|---|---|---|
| `mcp__chrome-devtools__take_snapshot`, `list_console_messages`, `lighthouse_audit`, `performance_*` | large (KB-MB) | DISPATCH |
| `mcp__sequel-mcp__query` / `execute` on real tables | unknown — assume large | DISPATCH unless you wrote `LIMIT 10` |
| `mcp__ferris-search__*`, `mcp__web-reader__*`, `mcp__zread__read_file`, full-article fetchers | large | DISPATCH |
| `mcp__fff__grep` / `find_files`, `mcp__textlog__*` previews, MCP `list_*` / `get_default_*` | small/bounded | INLINE OK |
| `mcp__plugin_claude-mem_mcp-search__get_observations` (one ID) | small | INLINE OK |
| `mcp__plugin_claude-mem_mcp-search__smart_search` / `query_corpus` | medium-large | DISPATCH if browsing |

Dispatch prompt template: "Call `mcp__<server>__<tool>` with `<args>`.
Return only `<the specific fields the plan needs>` — no raw payload, no
re-pasting." Make the worker do the filtering, not you.

Composer does NOT yet proxy other MCPs (Path C in the roadmap). Until
it does, this manual dispatch is the only way to keep the main session
from drowning in upstream payloads.

# Prior learnings

@.claude/learnings/index.md
