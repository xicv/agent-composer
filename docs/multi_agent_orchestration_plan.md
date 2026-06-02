# Project Composer: SOLID Multi-Agent Architecture (v2 — 2026-05-23)

> **Status**: Reviewed against Claude Code 2026 stack (Opus 4.7, MCP, Skills, Subagents, Hooks, Agent Teams) and Z.ai GLM Coding Plan endpoints. Replaces the v1 single-layer MCP design with a two-layer MCP + native-subagent architecture that gives true context isolation, deterministic boundary enforcement, and provider-pluggability via the Dependency Inversion Principle.

You hit two architectural breakthroughs early:

1. **Dependency Inversion** — decouple the *role* (researcher / coder / reviewer) from the *service provider* (Gemini / GLM / Kimi / MiniMax).
2. **Context Isolation** — keep worker noise out of Claude's main context window so the orchestrator stays sharp on long sessions.

The v1 plan delivered (1) cleanly through an MCP router with adapters. The v2 plan delivers (2) properly by wrapping each MCP tool inside a **native Claude Code subagent** — subagents own their own context window, return only a summary, and can be permission-locked to a single MCP tool. The router gives you provider freedom (Kimi, GLM, Gemini, MiniMax); the subagent layer gives you the same context-isolation guarantee Anthropic-native subagents offer.

---

## 1. Claude Code 2026 Stack — what each layer actually does

Verified against the latest Anthropic docs (see [Skills explained](https://claude.com/blog/skills-explained), [Create custom subagents](https://code.claude.com/docs/en/sub-agents), [Configure permissions](https://code.claude.com/docs/en/permissions)).

| Layer | Purpose | Where Composer uses it |
|-------|---------|----------------------|
| **MCP server** | Connectivity to external systems / providers | `composer-mcp` exposes `composer_research`, `composer_code`, `composer_review`, and optional escalation tools — each routed to a pluggable provider |
| **Skills** (`.claude/skills/<name>/SKILL.md`) | Reusable expertise, progressive disclosure, unbounded knowledge | `composer-mastermind` (router behavior), `composer-evolve` (self-improvement) |
| **Agent** (main session) | Orchestration, memory, planning, thinking | Claude (Opus 4.7) — never writes code itself |
| **Subagents** (`.claude/agents/<role>.md`) | Isolated context window, scoped tool access, separate model selection | `researcher.md`, `coder.md`, `reviewer.md`, `reviewer-claude.md` — each gets one MCP tool and nothing else |
| **Hooks** (`settings.json → hooks`) | Deterministic enforcement (cannot hallucinate) | `PreToolUse` blocks Bash/Edit/Write at the system level |
| **Agent Teams** | Experimental peer-to-peer Claude sessions | *Not used in v2* — token-expensive, session-resumption issues |
| **Channels** | MCP push messages into session | *Not used in v2* — research preview only as of April 2026 |

---

## 2. Context & Roles (Dependency Inversion)

The role names are deliberately provider-agnostic — Composer never says "Gemini Researcher".

| Role | Composer name | Default provider | Swappable to |
|------|---------------|------------------|--------------|
| Orchestrator | Claude (main session) | Anthropic Opus 4.7 | — (fixed; no API key needed under Max5 plan) |
| Researcher | `composer_research` | `agy` CLI (Gemini 3.1, `--print` mode) | Kimi / Perplexity / web-search MCP |
| Coder | `composer_code` | GLM 5.1 via Anthropic-compatible endpoint (decided 2026-05-23) | Kimi / MiniMax / DeepSeek (via OpenAI-compat adapter) |
| Reviewer | `composer_review` | `agy` CLI (Gemini 3.1, `--print` mode) | GLM / Kimi / Claude-Haiku |
| Premium reviewer | `composer_review_claude` | bounded `claude -p` CLI | Opus / Sonnet |
| Final integrator | Claude (main session) | Anthropic Opus 4.7 | — |

**Confirmed assumptions (user, 2026-05-23):**
- `agy --print` not billed externally. CLIProvider stays straightforward — no pexpect/tmux fallback needed for MVP.
- GLM coder uses Anthropic-native base URL + API key only. OpenAI-compat path becomes a *future* swap option, not a parallel default.
- Subagent reload latency acceptable.

**Workflow**: Claude → `composer_research` → Claude (plan) → `composer_code` → `composer_review` → Claude (integrate).

---

## 3. Two-Layer Architecture (this is the v2 upgrade)

```
┌─────────────────────────────────────────────────────────────┐
│   Main Claude session (Opus 4.7)                            │
│   - Reads composer-mastermind skill                         │
│   - Cannot Edit/Write/Bash (denied by settings + hook)      │
│   - Delegates via Task tool to subagents                    │
└──────────────┬──────────────────────────────────────────────┘
               │ Task() — only the subagent's summary comes back
   ┌───────────┼───────────┐
   ▼           ▼           ▼
┌────────┐ ┌────────┐ ┌────────┐
│researcher│ │ coder │ │reviewer│   .claude/agents/*.md
│ subagent │ │subagent│ │subagent│   isolated context windows
│ tools:   │ │tools:  │ │tools:  │   tool allowlist = single MCP tool
│ composer_│ │composer│ │composer│
│ research │ │ _code  │ │ _review│
└────┬─────┘ └───┬────┘ └───┬────┘
     │           │          │
     └───────────┼──────────┘
                 ▼
        ┌────────────────────┐
        │   composer-mcp     │  TypeScript MCP server
        │   (Node + zod)     │
        │   IProvider iface  │  Strategy pattern adapters
        └─┬──────┬──────┬────┘
          ▼      ▼      ▼
      ┌──────┐┌──────┐┌──────┐
      │ agy  ││ GLM  ││ Kimi │   pluggable providers
      │  CLI ││ HTTP ││ HTTP │   via composer.config.json
      └──────┘└──────┘└──────┘
```

**Why two layers, not one:**

- MCP tools alone return their result text *into the calling context*. A 5,000-token research dump from `agy` would bloat Claude's main window. Wrapping the MCP call inside a subagent means only the subagent's summary returns.
- Subagents can be `tools:`-restricted to *one* MCP tool. If `researcher.md` lists `tools: mcp__composer__composer_research`, Claude physically cannot ask the researcher to write code.
- Each subagent gets its own `model:` field — you can run `reviewer` on Claude Haiku 4.5 (3× cheaper) while keeping the orchestrator on Opus.

---

## 4. MCP Server (TypeScript) — verified API patterns

References: [@modelcontextprotocol/sdk TS docs](https://platform.claude.com/docs/en/api/sdks/typescript), [Build MCP server TypeScript tutorial 2026](https://www.digitalapplied.com/blog/build-mcp-server-typescript-tutorial-from-scratch-2026).

### `IProvider` interface (Open–Closed + Strategy)

```typescript
// src/providers/IProvider.ts
export interface IProvider {
  readonly name: string;
  healthCheck(): Promise<boolean>;
  execute(prompt: string, context?: string): Promise<string>;
}
```

### Concrete adapters (Liskov-substitutable)

```typescript
// src/providers/AnthropicCompatibleProvider.ts — DEFAULT for coder.
//   Wraps @anthropic-ai/sdk. Configure baseUrl + apiKey from
//   composer.config.json + .env. Works against GLM's Anthropic endpoint.

// src/providers/CLIProvider.ts — DEFAULT for researcher + reviewer.
//   Spawns agy via child_process.execFile (array args, NEVER shell).

// src/providers/OpenAICompatibleProvider.ts — OPTIONAL.
//   Stub interface only in MVP. Implement when user actually swaps
//   coder to Kimi / MiniMax / DeepSeek. YAGNI until then.
```

### Tool registration — use `registerTool()`, not legacy `tool()`

```typescript
server.registerTool(
  "composer_code",
  {
    description:
      "MANDATORY for ALL code writing, refactoring, debugging. " +
      "The orchestrator MUST delegate implementation to this tool. " +
      "Do not write code in the main session.",
    inputSchema: { prompt: z.string(), context: z.string().optional() },
    annotations: {
      title: "Composer Code",
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  async ({ prompt, context }) => {
    const provider = registry.getProviderForRole("coder");
    return { content: [{ type: "text", text: await provider.execute(prompt, context) }] };
  },
);
```

Quality of `description` is the single biggest factor in whether Claude actually calls the tool. The "MANDATORY" framing is documented best practice.

#### Tool annotations (added Wave-1 advisor pass, 2026-05-23)

Per MCP SDK 1.29 (verified via context7 query and [MCP tool annotations blog](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/)), tools should declare behavioural hints so the orchestrator can pick the right delegation. Hints are advisory, never enforceable — defense-in-depth still relies on the permission/hook layer.

| Tool | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` |
|---|---|---|---|---|
| `composer_research` | **true** — returns research notes | false | false (web state may shift) | **true** — talks to web/agy |
| `composer_code` | false — returns *new code text*, but does not modify repo state | false | false | false — LLM-only, no I/O |
| `composer_review` | **true** — returns findings only | false | **true** — same diff → same findings | false |
| `composer_review_claude` | **true** — returns findings only | false | **true** — same diff → same findings | false |

These annotations are append-only per ADR 0001 — they may be tightened in a Wave-2 amendment if real-traffic data shows mis-routing.

#### Skill description style (added 2026-05-23)

Per Anthropic's May-2026 skill-engineering guidance ([9 Tips for Building Claude Agent Skills](https://medium.com/@tahirbalarabe2/9-tips-for-building-claude-agent-skills-3bca85c47a26)), the YAML frontmatter `description` field should begin with `"Use when..."` for reliable autoload triggering. Subagent `description` fields follow the same pattern. The previous `"Use PROACTIVELY..."` phrasing still works but is less reliably matched against ambiguous user prompts.

### `composer.config.json` (Dependency Injection at runtime)

```json
{
  "roles": {
    "researcher": { "provider": "cli",       "cli": ["agy", "--dangerously-skip-permissions", "-p"] },
    "coder":      { "provider": "anthropic", "baseUrl": "https://open.bigmodel.cn/api/anthropic", "apiKeyEnv": "GLM_API_KEY", "model": "glm-4.6" },
    "reviewer":   { "provider": "cli",       "cli": ["agy", "--dangerously-skip-permissions", "-p"] },
    "reviewerClaude": { "provider": "cli",   "cli": ["claude", "-p", "--model", "opus", "--max-budget-usd", "0.50"] }
  }
}
```

A `ProviderFactory` reads this file and instantiates the right adapter at startup. Confirm the exact GLM Anthropic base URL against your GLM Coding Plan dashboard (either `open.bigmodel.cn/api/anthropic` or `api.z.ai/api/anthropic` depending on which entry-point your account uses). Swap GLM → Kimi later by replacing the `coder` block, no code change.

---

## 5. Native subagents — the missing v1 layer

Each subagent is a markdown file with YAML frontmatter. The `tools:` allowlist is the boundary that makes it impossible for a subagent to step outside its lane.

### `.claude/agents/coder.md`

```markdown
---
name: coder
description: Use PROACTIVELY for any code writing, refactoring, or implementation. Delegates to composer_code MCP tool.
tools: mcp__composer__composer_code, Read, Glob
model: haiku
---

You are the Composer Coder subagent. Your only job is to call the
composer_code MCP tool with the user's implementation request and
return its output to the orchestrator. You do not write code yourself.
You do not edit files. Read tools are available so you can quote the
relevant file path/context into the prompt argument.
```

`researcher.md` and `reviewer.md` follow the same shape with their respective MCP tool. Picking `model: haiku` for the wrapper keeps subagent overhead at ~3× lower cost than Opus.

---

## 6. Boundary Enforcement — defense in depth

Anthropic's `deny` permission has had two known enforcement bugs in 2026 ([#18846](https://github.com/anthropics/claude-code/issues/18846), [#6699](https://github.com/anthropics/claude-code/issues/6699)). Hooks are deterministic and cannot be hallucinated past. Use **both**.

### `.claude/settings.json`

```json
{
  "$schema": "https://json-schema.org/claude-code-settings.json",
  "permissions": {
    "deny": ["Bash", "Edit", "Write", "NotebookEdit"],
    "allow": [
      "Read", "Glob", "Grep",
      "Task",
      "mcp__composer__composer_research",
      "mcp__composer__composer_code",
      "mcp__composer__composer_review",
      "mcp__composer__composer_review_claude"
    ]
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Edit|Write|NotebookEdit",
        "hooks": [
          { "type": "command", "command": "${workspaceFolder}/scripts/boundary_guard.sh" }
        ]
      }
    ]
  },
  "mcpServers": {
    "composer": {
      "type": "stdio",
      "command": "npx",
      "args": ["tsx", "${workspaceFolder}/src/index.ts"]
    }
  }
}
```

### `scripts/boundary_guard.sh` (exit 2 = block + tell Claude why)

```bash
#!/usr/bin/env bash
TOOL=$(jq -r '.tool_name' <<< "$CLAUDE_TOOL_USE_INPUT")
case "$TOOL" in
  Bash|Edit|Write|NotebookEdit)
    cat <<EOF >&2
You attempted to use $TOOL directly. Composer orchestrator role forbids this.
Delegate via the Task tool to one of: researcher | coder | reviewer.
EOF
    exit 2 ;;
  *) exit 0 ;;
esac
```

`exit 2` is the documented hook signal: block the call AND surface stderr back into Claude's context as a reminder.

---

## 7. Mastermind Skill

`.claude/skills/composer-mastermind/SKILL.md` — auto-loaded, progressively disclosed.

```markdown
---
name: composer-mastermind
description: Composer orchestrator role. Use whenever the user requests code, research, or review work.
---

You are the Composer orchestrator. Your job is memory, planning, and delegation.

# Delegation rules (hard)

| If the user asks for...        | Use the Task tool to dispatch to |
|--------------------------------|----------------------------------|
| Information / context / docs   | `researcher` subagent            |
| Writing / refactoring code     | `coder` subagent                 |
| Reviewing implementation       | `reviewer` subagent              |

Never call composer_* MCP tools directly from the main session — always
go through the matching subagent so its context stays isolated.

# Token discipline

- You hold context, plans, and integration. Workers hold execution.
- A worker returning >2k tokens is a smell — re-issue with a tighter prompt.
- Use Read/Glob/Grep yourself only to pin file paths/line numbers for the workers' prompts.
```

---

## 8. Proposed File Tree

```
composer/
├── composer.config.json          # role → provider mapping
├── .env                          # ZAI_API_KEY, KIMI_API_KEY, ...
├── .claude/
│   ├── settings.json             # deny list + hooks + mcpServers
│   ├── agents/
│   │   ├── researcher.md
│   │   ├── coder.md
│   │   ├── reviewer.md
│   │   └── reviewer-claude.md
│   └── skills/
│       ├── composer-mastermind/
│       │   └── SKILL.md
│       └── composer-evolve/      # see docs/self_evolving_composer.md
│           └── SKILL.md
├── scripts/
│   └── boundary_guard.sh
├── src/
│   ├── index.ts                  # MCP server entry
│   ├── registry.ts               # ProviderFactory + role lookup
│   └── providers/
│       ├── IProvider.ts
│       ├── AnthropicCompatibleProvider.ts
│       ├── OpenAICompatibleProvider.ts
│       └── CLIProvider.ts
├── package.json                  # @modelcontextprotocol/sdk, zod, dotenv, openai, @anthropic-ai/sdk
└── docs/
    ├── multi_agent_orchestration_plan.md   # this file
    └── self_evolving_composer.md           # autonomous skill creation layer
```

---

## 9. Verification Plan

### Unit
1. `ProviderFactory` instantiates correct adapter per `composer.config.json`.
2. Each adapter's `healthCheck()` returns true with valid creds, false otherwise.
3. `CLIProvider` uses `execFile` (array args) — fuzz test with quoted/backticked queries to confirm no shell escape.

### Boundary
1. **Rebel test** — prompt main session: *"Use Bash to write hello.txt."* Expect: `deny` blocks → if it slips, hook returns exit 2 → Claude apologises and delegates.
2. **Hook isolation test** — call Bash via subagent that has no Bash in tools allowlist. Expect: tool not visible to subagent at all.

### End-to-end
1. Ask main session to build a small feature. Watch the Task tool dispatches: researcher → coder → reviewer → integration.
2. `claude mcp list` shows `composer` connected.
3. Token accounting: main-session token count for a 3-step feature should be < 30% of an equivalent monolithic session (measured via `/cost` or transcript).

---

## 9.5 Risk Mitigation Matrix (2026-05-23, post-research)

Defense-in-depth across the three highest-impact risks. Numbering matches the depth-research note that produced this section.

### Risk #1 — Orchestrator drift (Claude writes code in main session)

| Layer | Mechanism | Determinism |
|-------|-----------|-------------|
| Permission | `deny: ["Bash","Edit","Write","NotebookEdit"]` in `settings.json` | High (known bugs #18846/#6699) |
| Hook | PreToolUse returns `permissionDecision: "deny"` — fires *before* permission check, blocks even `--dangerously-skip-permissions` | Highest |
| Subagent | `tools:` allowlist scoped to one MCP tool per subagent (coder cannot Read; reviewer cannot Write) | Highest (runtime) |
| Skill | Negative-style instructions in `composer-mastermind/SKILL.md`. Pattern: "DO NOT use Edit. NEVER call Bash. ALWAYS dispatch via Task." Mirrors Anthropic's frontend-design skill convention | High |
| MCP tool desc | Each tool's `description` opens with "MANDATORY:" framing | Medium-High |
| UX | User invokes `@coder` / `@researcher` / `@reviewer` (April 2026 @-mention typeahead) for non-trivial tasks | Highest (human-in-loop) |
| Telemetry | PostToolUse on attempted Edit/Write logs to `.claude/learnings/drift.log` for skill retuning | Medium |
| Recursive | After first week, add "Gotchas" section to mastermind skill listing real drift incidents | Medium |

### Risk #2 — Token savings don't materialise

| Tool | Use |
|------|-----|
| `/usage` | Native per-session view |
| [`ccusage`](https://github.com/ryoppippi/ccusage) | Daily/weekly/monthly historical reports |
| [`Claude-Code-Usage-Monitor`](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor) | Real-time live monitor with ML predictions |
| Statusline JSON v2.1.92+ | Embed rate-limit data |
| A/B baseline | Run same feature twice — stock vs Composer — compare totals |
| PreCompact hook | Community kits recover ~15k tokens/session |
| SessionEnd alert | If main-session tokens > threshold, append warning to learning log |

**Plan**: ship MVP with `ccusage` daily report. Week 1 = gather 5 baseline runs. If main-session token reduction < 50% on multi-step tasks → retune mastermind skill via T1 log.

### Risk #3 — Hook/deny enforcement edges

| Rule | Reason |
|------|--------|
| Use **`exit 2`** for blocking (NOT `exit 1`) | `exit 1` is a non-blocking warning; dangerous command still runs |
| Fail-closed default | Missing `jq`, malformed JSON, syntax error → script defaults to `deny` |
| `permissionDecision: "deny"` over plain `exit 2` | Explicit, carries reason string surfaced to Claude |
| Match MCP-prefixed variants too | `Bash\|Edit\|Write\|NotebookEdit\|mcp__.*__(file_)?write\|.*write_file` |
| `permissionDecision: "ask"` on Read of `.env` / secrets | Second-tier instead of blanket allow |
| PreToolUse is idempotent | Logs OK, side-effects no — hook can fire >1× per call |
| Test harness | `tests/hooks/*.json` fixtures piped to script; assert exit code per fixture |
| Static check | `bash -n scripts/boundary_guard.sh` in CI; refuse to load on syntax error |

### Hardened `scripts/boundary_guard.sh`

```bash
#!/usr/bin/env bash
# Fail-closed: any unexpected condition → deny.
set -u

# 1. Tool dependency check
if ! command -v jq >/dev/null 2>&1; then
  printf '{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"boundary_guard: jq missing, failing closed"}\n'
  exit 0
fi

# 2. Read tool call JSON from stdin
INPUT="$(cat || true)"
if [[ -z "$INPUT" ]]; then
  printf '{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"boundary_guard: empty input, failing closed"}\n'
  exit 0
fi

TOOL="$(jq -r '.tool_name // empty' <<<"$INPUT")"
if [[ -z "$TOOL" ]]; then
  printf '{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"boundary_guard: malformed tool_name, failing closed"}\n'
  exit 0
fi

# 3. Block list (native + likely MCP variants)
case "$TOOL" in
  Bash|Edit|Write|NotebookEdit|mcp__*__write_file|mcp__*__edit_file|mcp__*__bash)
    jq -n \
      --arg t "$TOOL" \
      '{hookEventName:"PreToolUse", permissionDecision:"deny",
        permissionDecisionReason:("Composer orchestrator forbids direct " + $t + ". Delegate via Task → researcher/coder/reviewer.")}'
    exit 0 ;;
esac

# 4. Pass-through
exit 0
```

### Hook test fixtures (`tests/hooks/`)

```json
// 01_block_bash.json
{ "tool_name": "Bash", "tool_input": { "command": "ls" } }
// expect: jq output contains "permissionDecision":"deny"

// 02_allow_read.json
{ "tool_name": "Read", "tool_input": { "file_path": "/tmp/x" } }
// expect: exit 0, no deny payload

// 03_malformed.json
{ "tool_input": { "command": "ls" } }
// expect: deny "malformed tool_name"

// 04_mcp_write_variant.json
{ "tool_name": "mcp__github__write_file", "tool_input": {} }
// expect: deny
```

## 10. Resolved Decisions (2026-05-23)

> [!NOTE]
> 1. **GLM auth** — use the GLM Coding Plan Anthropic-native base URL + API key. Single adapter (`AnthropicCompatibleProvider`) for the coder. OpenAI-compat is a future-only swap.
> 2. **`agy --print` billing** — assumed *not* externally metered for now. CLIProvider built straight on `child_process.execFile`. Revisit only if Antigravity rolls out a metering change.
> 3. **Subagent latency** — accepted as long as it is not severe. No special-casing for trivial tasks in MVP; orchestrator delegates everything that touches code or research.

---

## 11. References (verified 2026-05)

- [Skills explained — Anthropic blog](https://claude.com/blog/skills-explained)
- [Create custom subagents — Claude Code docs](https://code.claude.com/docs/en/sub-agents)
- [Configure permissions — Claude Code docs](https://code.claude.com/docs/en/permissions)
- [Anthropic Shows How to Scale Claude Code with Subagents and MCP](https://winbuzzer.com/2026/03/24/anthropic-claude-code-subagent-mcp-advanced-patterns-xcxwbn/)
- [Claude Code: Hooks, Subagents, and Skills — Complete Guide](https://ofox.ai/blog/claude-code-hooks-subagents-skills-complete-guide-2026/)
- [Building MCP Servers — SitePoint](https://www.sitepoint.com/building-mcp-servers-custom-context-for-claude-code/)
- [Anthropic API format for GLM Coding Plan](https://aiengineerguide.com/til/anthropic-api-format-glm-coding-plan/)
- [Claude Code deny permissions bug #18846](https://github.com/anthropics/claude-code/issues/18846)
- [Claude Code deny permissions bug #6699](https://github.com/anthropics/claude-code/issues/6699)
- See also: [`docs/self_evolving_composer.md`](./self_evolving_composer.md) for the autonomous skill-creation layer (Hermes Agent + Karpathy autoresearch patterns).
- See also: [`docs/tdd_plan.md`](./tdd_plan.md) for the test-first build sequence (Wave 0/1/2/3, quality rubric, decoupled-feature graph, GLM/`agy`-routed evals).
