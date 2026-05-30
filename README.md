# Composer — multi-agent orchestration for Claude Code

[![npm](https://img.shields.io/badge/npm-agent--composer-blue)](#install) [![tests](https://img.shields.io/badge/vitest-376%20passing-brightgreen)](#contributing) [![license](https://img.shields.io/badge/license-MIT-lightgrey)](#license)

> **Claude orchestrates. GLM and `agy` execute — and *apply* — off your Claude quota.** Composer is an MCP server + Claude Code plugin that lets the most-capable model hold the plan while cheaper models generate *and write* the code in their own context. Because the executors apply files themselves (instead of returning text the main session must re-ingest), composer measurably cuts Claude Max5 token burn (~64–71% on substantial multi-file tasks) while keeping the orchestrator's context lean and every change reviewable.

## What it is

Two coordinated artefacts:

| Artefact | Purpose |
|---|---|
| **`agent-composer`** (this npm package) | MCP server exposing `composer_research`, `composer_code`, `composer_code_chain`, `composer_code_cli`, `composer_review`. Wraps GLM (via Anthropic-compatible endpoint) and the `agy` CLI (Gemini). |
| **`composer-mastermind`** (Claude Code plugin) | Orchestrator skill + three haiku-wrapped subagents (`coder`, `researcher`, `reviewer`) + `boundary_guard` PreToolUse hook + `/evolve` slash command. |

Combined, they turn the main Claude session into a coordinator that never writes code, runs bash, or edits files directly. Work is dispatched through the three MCP tools; the boundary hook fails closed if a denied tool is requested.

## Tools

Five MCP tools, all routing work off the main Claude session:

| Tool | Executor | What it does |
|---|---|---|
| `composer_code_chain` | GLM authors → server applies | **Default for substantial edits.** GLM writes the complete files off-CC (`FILE: <path>` + fenced blocks); the MCP server applies them deterministically off-CC; the orchestrator only relays a summary. ~71% fewer total-CC tokens on multi-file tasks. |
| `composer_code_cli` | agy (Gemini CLI) | agy generates **and applies** the files itself off-CC, returns a summary. ~64% fewer total-CC tokens. |
| `composer_code` | GLM | Returns a patch as text; the caller integrates it (patch-only / legacy). |
| `composer_research` | agy | Research, docs, web lookup → structured summary. |
| `composer_review` | agy | Reviews the diff **and runs `tsc`/tests off-CC**; use a reviewer model different from the author for cross-model rigor (e.g. GLM writes → agy reviews). |

**Why "off-CC" matters:** GLM (z.ai) and agy (Gemini) run on *separate* quotas. Generating and *applying* code in their own context — not returning text the main Claude session must re-ingest — is what actually preserves your Max5 quota. The eval harness scores on **total-CC tokens** (every Claude model in a run = real Max5 burn), with a correctness gate (tsc/tests) and N-run averaging.

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
    "researcher": { "provider": "cli", "cli": ["agy", "--dangerously-skip-permissions", "-p"] },
    "coder":      { "provider": "anthropic", "baseUrl": "https://api.z.ai/api/anthropic", "apiKeyEnv": "ANTHROPIC_AUTH_TOKEN" },
    "coderCli":   { "provider": "cli", "cli": ["agy", "--dangerously-skip-permissions", "-p"] },
    "reviewer":   { "provider": "cli", "cli": ["agy", "--dangerously-skip-permissions", "-p"] }
  },
  "spendAuthorization": {
    "mode": "interactive",
    "maxUsdPerCall": 0.50,
    "maxUsdPerSession": 5.00
  }
}
```

**`.env.json`** (NEVER commit) — credentials only:

```json
{
  "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic",
  "ANTHROPIC_AUTH_TOKEN": "<your-glm-or-anthropic-compatible-token>"
}
```

The MCP server reads `.env.json` via `fs.readFileSync` — it is **never** exposed to the orchestrator session.

## How dispatch works

Inside a Claude Code session, dispatch flow:

```
User asks for code work
   ↓
Composer-mastermind SKILL.md picks a subagent
   ↓
Task → coder.md / researcher.md / reviewer.md
   ↓
Subagent calls mcp__composer__composer_code (etc.)
   ↓
MCP server routes to GLM (anthropic) or agy CLI (cli) per composer.config.json
   ↓
Subagent returns summary; orchestrator integrates
```

Five resilience layers ensure unattended `/evolve` runs cannot damage the host repo:

1. **Sandbox isolation** — each per-task eval runs in a throwaway `git worktree` at `/tmp/composer-eval-<pid>-<taskId>`
2. **Per-task fault isolation** — one task's spawn failure records `score: 0` and continues
3. **Stat-gate precondition guards** — Wilcoxon paired-test skips when arrays are asymmetric
4. **Spawn diagnostics** — stderr/stdout tail appended to error messages
5. **Per-task wall-time bound** — `execFile` `timeout: 180_000` with SIGTERM; absorbed by layer 2

## Security model

- **`agent-composer` publish surface**: `dist/`, `composer.config.schema.json`, `README.md`, `package.json`. No tests, no source, no `.env*` (gitignored). 34 KB tarball.
- **Spend caps**: per-call (`maxUsdPerCall`, default $0.50) and per-session (`maxUsdPerSession`, default $5.00) enforced in the runner before any external API call. Configurable per project.
- **Self-evolution scope** (see ADR 0003): five layers gate any SKILL.md mutation — diff-path regex, text deny-list, stat gate, human-promote-only, audit trail. Auto-promote is permanently off the table.
- **Boundary hook**: PreToolUse fail-closed denial of `Edit`/`Write`/`Bash`/`NotebookEdit` in the orchestrator session. The C0.5 subagent tools allowlist is append-only.

## Contributing

Clone, install, run tests:

```bash
git clone <this-repo>
cd composer
npm install
npx tsc --noEmit                                # type check
./node_modules/.bin/vitest run                  # 376 tests
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
