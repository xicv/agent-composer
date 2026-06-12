# Composer — multi-agent orchestration for Claude Code

[![npm](https://img.shields.io/badge/npm-agent--composer-blue)](#install) [![tests](https://img.shields.io/badge/vitest-499%20passing-brightgreen)](#contributing) [![license](https://img.shields.io/badge/license-MIT-lightgrey)](#license)

> **Claude orchestrates. GLM, Codex, and `agy` execute — and *apply* — off your Claude quota.** Composer is an MCP server + Claude Code plugin that lets the most-capable model hold the plan while worker models generate *and write* the code in their own context. Because the executors apply files themselves (instead of returning text the main session must re-ingest), composer keeps the orchestrator's context lean and every change reviewable.

## What it is

Two coordinated artefacts:

| Artefact | Purpose |
|---|---|
| **`agent-composer`** (this npm package) | MCP server exposing `composer_handoff_create`, `composer_research`, `composer_code`, `composer_code_chain`, `composer_code_cli`, `composer_review`, `composer_review_claude`, the `composer_codex_lifecycle_*` decision/run/result tools, and `composer_config_*` config tools. Wraps GLM (via Anthropic-compatible endpoint) and CLI executors such as Codex, `agy`, or bounded `claude -p`. |
| **`composer-mastermind`** (Claude Code plugin) | Orchestrator skill + haiku-wrapped subagents (`coder`, `researcher`, `reviewer`, optional `reviewer-claude`) + `boundary_guard` PreToolUse hook + `/evolve` slash command. |

Combined, they turn the main Claude session into a coordinator that never writes code or edits files directly. The main session may use Bash for inspection and verification, while code changes are dispatched through Composer MCP tools. The boundary hook fails closed if a denied file-mutating tool is requested.

## Tools

Twelve MCP tools, all routing work off the main Claude session:

| Tool | Executor | What it does |
|---|---|---|
| `composer_handoff_create` | Composer server | Writes a compact shared packet under `.composer/handoffs/`; pass `handoffPath` to Codex, GLM, agy, researcher, and reviewer calls so every worker shares the same objective and constraints. |
| `composer_code_cli` | Codex CLI or agy | **Default for code edits.** The configured CLI executor generates **and applies** files itself off-CC, from the MCP server root, then returns a bounded summary. Use Codex here for complex coding work. |
| `composer_code_chain` | GLM authors → server applies | GLM fallback. GLM writes the complete files off-CC (`FILE: <path>` + fenced blocks); the MCP server applies them deterministically off-CC; the orchestrator only relays a summary. ~71% fewer total-CC tokens on multi-file tasks. |
| `composer_code` | GLM | Legacy patch-only lane. Use only when you explicitly need GLM diff/text output instead of an apply-capable lane. |
| `composer_research` | Codex CLI search | Direct docs/web/current-context lane → bounded structured summary. Runs Codex with live web search and a read-only sandbox. |
| `composer_review` | agy | Direct diff-review lane. Ask it to run repo-appropriate targeted checks off-CC; use a reviewer model different from the author for cross-model rigor (e.g. GLM writes → agy reviews). |
| `composer_review_claude` | Claude Code CLI | Premium second-opinion review for high-risk/security-sensitive diffs or explicit user requests. Default config runs bounded `claude -p --model opus` with read/test tools only and `--max-budget-usd 0.50`. |
| `composer_codex_lifecycle_decide` | Composer server | Scores lifecycle events and returns `skip`, `ask`, or `run` from project config without invoking Codex. |
| `composer_codex_lifecycle_run` | Codex CLI companion | Runs a foreground or background advisory Codex checkpoint and persists a durable job under `.composer/codex-lifecycle/`. |
| `composer_codex_lifecycle_result` | Composer server | Reads a lifecycle job by `jobId`, or the latest job, so background Codex output is merged back into the main loop. |
| `composer_config_get` | Composer server | Reads the active, project, or global Composer config and path. |
| `composer_config_set` | Composer server | Safely updates lifecycle, lifecycle fallback, and pre-commit review-gate config after schema validation. |

**Why "off-CC" matters:** GLM (z.ai), Codex, and agy run on *separate* quotas. Generating and *applying* code in their own context — not returning text the main Claude session must re-ingest — is what actually preserves your Max5 quota. The eval harness scores on **total-CC tokens** (every Claude model in a run = real Max5 burn), with a correctness gate (tsc/tests) and N-run averaging.

## Install

```bash
# 1. Install the MCP server
npm install -g agent-composer

# 2. Bootstrap a project (creates composer.config.json + .env.json template +
#    .gitignore + .claude/settings.json with mcpServers.composer entry)
cd your-project
agent-composer init

# 3. Fill credentials
$EDITOR .env.json    # ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN

# 4. Install the plugin (manual until Claude Code plugin marketplace lands)
mkdir -p ~/.claude/plugins
git clone <this-repo> /tmp/composer
cp -R /tmp/composer/plugin/composer-mastermind ~/.claude/plugins/

# 5. Launch
claude
```

Verify the orchestrator skill loaded:

```
/composer-mastermind
```

Smoke-test the self-evolution loop:

```
/evolve --eval-mode synthetic
```

## Configuration

Two files at the consumer-project root, both gitignored or partially gitignored:

**`composer.config.json`** (committed) — provider routing + spend caps:

```json
{
  "roles": {
    "researcher": { "provider": "cli", "cli": ["codex", "--search", "--ask-for-approval", "never", "exec", "--ephemeral", "--sandbox", "read-only"], "timeoutMs": 180000, "retries": 0 },
    "coder":      { "provider": "anthropic", "baseUrl": "https://api.z.ai/api/anthropic", "apiKeyEnv": "ANTHROPIC_AUTH_TOKEN" },
    "coderCli":   { "provider": "cli", "cli": ["codex", "exec", "--ephemeral", "--sandbox", "workspace-write", "-c", "approval_policy=\"never\"", "-c", "model_reasoning_effort=\"medium\""], "timeoutMs": 900000, "retries": 0 },
    "reviewer":   { "provider": "cli", "cli": ["agy", "--dangerously-skip-permissions", "--print-timeout", "90s", "-p"], "timeoutMs": 120000, "retries": 0 },
    "reviewerClaude": {
      "provider": "cli",
      "model": "claude-opus-review",
      "cli": ["claude", "-p", "--model", "opus", "--permission-mode", "bypassPermissions", "--setting-sources", "project", "--disable-slash-commands", "--no-session-persistence", "--max-budget-usd", "0.50", "--tools", "Read,Glob,Grep,Bash", "--allowedTools", "Read,Glob,Grep,Bash(npx tsc --noEmit),Bash(npm test),Bash(npm run test:*),Bash(npx vitest*)"],
      "timeoutMs": 300000,
      "retries": 0
    }
  },
  "spendAuthorization": {
    "mode": "interactive",
    "maxUsdPerCall": 0.50,
    "maxUsdPerSession": 5.00
  }
}
```

For the old agy-only coding path, set `coderCli.cli` back to
`["agy", "--dangerously-skip-permissions", "-p"]`. For the old agy-only
research path, set `researcher.cli` to the same agy argv. The provider
contract does not change; Codex is piloted as the existing CLI executor.
When `coderCli` or `researcher` use `codex ... exec`, Composer captures
Codex's final message with `--output-last-message` automatically, so the
main session receives a short outcome instead of raw event output. Composer
refuses explicit `codex exec --sandbox danger-full-access` and
`--dangerously-bypass-approvals-and-sandbox` configs by default; set
`COMPOSER_ALLOW_DANGEROUS_CODEX=1` only inside an external sandbox.
The default Codex coding lane sets `timeoutMs` to 15 minutes and overrides
the nested Codex run to `model_reasoning_effort="medium"` so it does not
inherit slower global high-effort settings intended for the main orchestrator.
Keep `reviewer` as the default gate. Use `reviewerClaude` only when the user
asks for Claude review or when a risky diff needs an expensive second opinion.

### Codex lifecycle automation

`codexLifecycle` controls ambient Codex participation during feature/debug
work. The policy is deterministic and cheap: `composer_codex_lifecycle_decide`
scores the event first, then `composer_codex_lifecycle_run` only calls Codex
when the result is `run` or when the orchestrator asks after an `ask` decision
and passes `confirmed:true`.

```json
{
  "codexLifecycle": {
    "enabled": true,
    "mode": "auto",
    "execution": "background",
    "model": "gpt-5.4-mini",
    "triggers": {
      "postPlan": true,
      "postCodeApply": true,
      "postTestFailure": true,
      "afterFailedAttempts": true,
      "preCommit": false,
      "stopWarm": false
    },
    "thresholds": {
      "minScore": 60,
      "minExpectedOutputTokens": 500,
      "minChangedFiles": 2,
      "minDiffLines": 80,
      "failedAttempts": 2
    },
    "fallback": {
      "enabled": true,
      "order": ["reviewerClaude", "reviewer", "coder"]
    }
  }
}
```

Foreground runs return the Codex result in the same MCP call. Background runs
return a `jobId` and `resultPath`; the orchestrator must call
`composer_codex_lifecycle_result` before treating the lifecycle step as done.
Job records are stored outside the project worktree under Composer user state so
background output does not dirty `git status`. They use `succeeded`, `failed`,
`skipped`, or `unavailable`. `skipped` means policy chose not to call Codex.
`unavailable` means the primary and configured fallback providers could not run
because of auth, quota/usage exhaustion, rate limits, timeout, cancellation, or
another provider failure.
When `fallback.enabled` is true, Composer tries `coderCli` first and then each
role in `fallback.order`, recording every provider attempt in the job. Optional
lifecycle work can continue after surfacing that record, but it is not an
approval.

Lifecycle runs are companion/advisory passes. They are prompted not to mutate
files silently; any suggested changes should be applied deliberately through
the normal coding lane and then reviewed.

### Forced Codex pre-commit review

`codexReview.preCommitHook.enabled` is the hard quality gate for commits. It is
separate from `codexLifecycle.preCommit`: lifecycle participation is advisory,
while the review hook can block a commit.

```json
{
  "codexReview": {
    "enabled": true,
    "preCommitCommand": "adversarial-review",
    "scope": "auto",
    "model": "gpt-5.4-mini",
    "preCommitHook": {
      "enabled": true,
      "blockOnSeverity": "high",
      "timeoutMs": 900000,
      "failClosed": true
    },
    "warmCache": {
      "enabled": true,
      "maxAgeMinutes": 30
    }
  }
}
```

Claude Code's `PreToolUse` Bash hook protects `git commit` launched through
Claude Code by emitting `permissionDecision` JSON and exiting 0. It gates
Claude-issued Bash commits, but does not mechanically block a manual Terminal
`git commit`; that requires a real Git hook path that exits non-zero, such as
the local `.git/hooks/pre-commit` bridge installed for this checkout. With
`failClosed:true`, missing Codex auth, expired sessions, quota/usage
exhaustion, rate limits, timeouts, or invalid review output block gated commits
instead of silently allowing them. `agent-composer doctor` checks both the
config and whether the local Git pre-commit bridge is installed and executable.

The remaining local bypass is Git's own `git commit --no-verify`; protect that
path with branch protection or CI if every commit path must be enforced.

### Config from Claude Code

Use `composer_config_get` and `composer_config_set` when you want Claude Code to
toggle Composer behavior without editing JSON by hand. `composer_config_set`
accepts only scoped patches for `codexLifecycle` and `codexReview`; it validates
the resulting config before writing.

Examples:

```json
{
  "scope": "active",
  "codexLifecycle": {
    "enabled": true,
    "mode": "auto",
    "execution": "background",
    "fallback": {
      "enabled": true,
      "order": ["reviewerClaude", "reviewer", "coder"]
    }
  },
  "codexReview": {
    "enabled": true,
    "preCommitHook": {
      "enabled": true,
      "failClosed": true
    }
  }
}
```

`scope:"active"` follows the running Composer config path for reads. For writes,
Composer refuses an active path that resolves to the user-global fallback; use
`scope:"global"` explicitly when mutating
`~/.config/composer/composer.config.json`. Use `scope:"project"` for
`<repo>/composer.config.json`.

### Fast direct-tool mode

Composer keeps the CLI executor path, but the plugin now treats it more like a
small SDK harness:

- `composer_code_cli` is the default edit lane; the legacy `coder` subagent is
  only for rare patch-only GLM fallback.
- `composer_research`, `composer_review`, and `composer_review_claude` can be
  called directly because their providers already run off the main Claude Code
  context and return bounded summaries.
- The `researcher`, `reviewer`, and `reviewer-claude` subagents remain available
  when raw upstream output is expected to be large enough to need an isolated
  wrapper context.
- CLI calls append best-effort timing records to
  `/tmp/composer-cli-usage.jsonl`; GLM calls append timing/cache records to
  `/tmp/composer-glm-usage.jsonl`. These files contain durations and character
  counts plus success/error status, not prompts.

**`.env.json`** (NEVER commit) — credentials only:

```json
{
  "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic",
  "ANTHROPIC_AUTH_TOKEN": "<your-glm-or-anthropic-compatible-token>"
}
```

The MCP server reads `.env.json` via `fs.readFileSync` — it is **never** exposed to the orchestrator session.

### Soft-disable Composer

Composer hooks can be disabled without editing Claude Code settings:

```bash
# Disable for one launch
COMPOSER_ENABLED=0 claude

# Disable globally for already-configured hooks
touch ~/.claude/composer.disabled

# Re-enable globally
rm -f ~/.claude/composer.disabled
```

Project-local disable is also supported with `touch .composer-disabled`.
For scripts or tests, set `COMPOSER_DISABLED_FILE=/path/to/sentinel`.
This disables Composer hooks immediately. To fully suppress skill autoload,
also set `"composer-mastermind": "off"` in Claude Code `skillOverrides` and
restart CC.

## How dispatch works

Inside a Claude Code session, dispatch flow:

```
User asks for code work
   ↓
Composer-mastermind SKILL.md picks a direct MCP tool or fallback subagent
   ↓
Direct MCP call → composer_code_cli / composer_research / composer_review
or Task fallback → coder.md / researcher.md / reviewer.md / reviewer-claude.md
   ↓
MCP server routes to GLM (anthropic) or Codex/agy CLI per composer.config.json
   ↓
Provider returns bounded summary; orchestrator integrates
```

Composer also emits a deterministic dispatch hint for `Task`/`Agent` calls
when `scripts/dispatch_guard.sh` is installed. The hint classifies the
request before the worker starts, so the orchestrator can choose a cheaper
lane when the task is simple and reserve expensive paths for the cases that
need isolation or extra reasoning.

| Task shape | Default route |
|---|---|
| Tiny rename/comment/non-mutating request | Inline |
| Small self-contained diff review | Inline review |
| File mutation with path references | `composer_code_cli` |
| Research-first implementation | `composer_research`, then `composer_code_cli` |
| Security or large review | `composer_review` first; escalate to `composer_review_claude` only when needed |
| Explicit premium/Claude review | `composer_review_claude` |

## Measuring trust

Composer's route-confidence harness compares the same tasks across direct
Claude, GLM-chain, and Codex-CLI routes. The `cc-only` route removes the
worktree-local `.claude/` directory before running so the project plugin does
not bias the baseline. It writes JSONL records with
success, route adherence, typecheck status, changed-file count, wall time,
and **total Claude Code tokens** from `modelUsage`.

```bash
# Build first so the MCP server entry exists.
npm run build

# Run one representative task across all routes, three replicas each.
npm run eval:routes -- --task t8-csv-module --runs 3

# Re-summarize an existing JSONL file without spending more tokens.
npm run eval:routes -- --summary-only --input /tmp/composer-route-runs.jsonl
```

The headline checks are: `composer-codex-cli` should preserve or improve
success/typecheck rate while lowering median total-CC tokens versus
`cc-only`; `routeHonored` must stay high enough to prove the orchestrator is
actually using the route under test.

Five resilience layers ensure unattended `/evolve` runs cannot damage the host repo:

1. **Sandbox isolation** — each per-task eval runs in a throwaway `git worktree` at `/tmp/composer-eval-<pid>-<taskId>`
2. **Per-task fault isolation** — one task's spawn failure records `score: 0` and continues
3. **Stat-gate precondition guards** — Wilcoxon paired-test skips when arrays are asymmetric
4. **Spawn diagnostics** — stderr/stdout tail appended to error messages
5. **Per-task wall-time bound** — `execFile` `timeout: 180_000` with SIGTERM; absorbed by layer 2

## Security model

- **`agent-composer` publish surface**: `dist/`, `plugin/`, `composer.config.schema.json`, `README.md`, `package.json`. No tests, no source, no `.env*` (gitignored). Current npm dry-run package size is 84.4 KB.
- **Spend caps**: per-call (`maxUsdPerCall`, default $0.50) and per-session (`maxUsdPerSession`, default $5.00) enforced in the runner before any external API call. Configurable per project.
- **Self-evolution scope** (see ADR 0003): five layers gate any SKILL.md mutation — diff-path regex, text deny-list, stat gate, human-promote-only, audit trail. Auto-promote is permanently off the table.
- **Boundary hook**: PreToolUse fail-closed denial of `Edit`/`Update`/`Write`/`NotebookEdit` in the orchestrator session, plus MCP write/edit/exec variants. Native Bash is allowed for inspection and verification. The C0.5 subagent tools allowlist is append-only.

## Contributing

Clone, install, run tests:

```bash
git clone <this-repo>
cd composer
npm install
npx tsc --noEmit                                # type check
./node_modules/.bin/vitest run                  # 499 tests
./node_modules/.bin/ajv validate \              # schema lint
  --strict=false -c ajv-formats \
  -s composer.config.schema.json \
  -d composer.config.json
```

Per-task layer reference docs (in the source tree):

- `docs/STATUS.md` — current state + dogfood audit log + every /evolve run
- `docs/multi_agent_orchestration_plan.md` — architecture
- `docs/tdd_plan.md` — build sequence + quality rubric
- `docs/self_evolving_composer.md` — autonomous skill evolution (T1/T2/T3)
- `docs/adr/0001-contracts.md` — frozen C0.1–C0.5 contracts (append-only)
- `docs/adr/0002-meta-mcp.md` — Wave 4 packaging contract (M0.1–M0.5)
- `docs/adr/0003-self-evolution.md` — self-evolution mutation scope (S1–S5)

The `/evolve` loop is a GEPA-style reflective optimizer: it evaluates the parent skill, captures **failing-task transcripts**, and routes them into mutation operators (`add_counterexample` / `add_constraint` / `add_negative_example` / `reflect_and_rewrite`) so each candidate is shaped by real failures. A no-op guard skips mutations that produce no change. Recommended supervised invocation: `--eval-mode real --length-lambda 0.0001 --replicas 3 --tasks <code subset>`. It mutates only the project-local `.claude/skills/composer-mastermind/SKILL.md`, writes `SKILL.candidate.md` for **manual review** (auto-promote is permanently off), and the published plugin install is read-only. Release sync from dev to plugin happens via `scripts/release-sync.mjs --bump <semver>`.

## License

MIT.
