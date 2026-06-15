# gproj — Persistent Planner Brain (design)

> Status: design / brainstorming output. Date: 2026-06-15.
> Source idea: the viral "人定方向, GPT Pro 做需求分析和 review, Codex 只管执行" workflow.
> Decision record for a decoupled, cross-tool planner-brain CLI that Composer consumes.

## 1. Problem

A high-value workflow splits dev roles: **human** sets goal/constraints/acceptance; a **high-reasoning planner** (GPT-5 Pro) does requirement-clarification, task-decomposition, planning, and review; an **executor** (Codex CLI / Claude Code) only edits code, runs tests, produces diff/PR. In the source workflow the *ChatGPT Project* is the persistent "long-term brain" — every round's PRD, architecture, decisions, known-issues, run results, and review records sediment there, so the planner never restarts from zero and the user maintains no separate Obsidian/wiki.

Composer's north star is already this brain/executor split. The missing piece is **persistent planner state that survives rounds, re-ingests execution evidence, and emits machine-usable phase packages for whichever executor is chosen** — working identically for both Codex and Claude Code.

Today's Composer Oracle lane is a **stateless single-shot** dispatch to GPT-5 Pro (`composer_oracle_plan` / `composer_oracle_job_start|result`): one prompt → one answer to `.composer/oracle/answers/<id>.md`, no thread, no project, no memory accumulation. That amnesia is the gap.

## 2. Key findings (oracle deep-research, GPT-5 Pro, 2026-06-15)

Prior art, closest first:

| Tool | Persists memory | Planner≠executor | Cross-tool | Gap |
|---|---|---|---|---|
| ChatGPT Projects + manual | Yes (product) | Manual copy-paste | Human handoff only | No automation / reproducible state — closest UX prior art |
| Oracle browser + Project Sources | Partial (append-only v1) | Yes if plan-only | CLI/MCP/Codex skill | Brittle, incomplete as sole store |
| Hamster Studio | Yes (strong) | Yes | CLI+MCP | Closed, not local-first/executor-agnostic — closest productized analogue |
| Spec Kit | Yes (`.specify/specs/`) | Moderate | Codex + Claude | Artifacts, but no living planner-memory/review brain |
| OpenSpec | Yes (`openspec/changes/`) | Moderate | 20+ assistants | No accumulated review/run memory |
| Task Master | Yes (`.taskmaster/state.json`) | Weak | CC explicit, Codex referenced | Great task substrate, planner isn't a long-term brain |
| BMAD Method | Yes (`_bmad`) | Yes ("plan in web, build in IDE") | CC/ChatGPT/Cursor; Codex unproven | Closest conceptual |

**Gap nobody fills:** a vendor-neutral persistent planner brain that drives **both** Codex and CC, ingests **real executor evidence**, and keeps **compressed reviewable state** between rounds.

**Critical constraint:** there is **no public programmable ChatGPT-Project API.** The official programmable surfaces are the **Responses + Conversations API** (genuine thread continuity) and vector stores. Driving the real ChatGPT Project = browser automation (brittle). Therefore the **persistent planner state must be local and authoritative**; remote project/thread semantics are accelerants, not the store.

## 3. Decisions (locked with user)

1. **Persistence = local reconstructed memory.** A versioned on-disk store auto-assembled into a bounded context pack on every planner call. Planner stays stateless per-call but always *sees* the full memory.
2. **Form factor = standalone CLI + thin host shims.** A standalone project (own state format + `gproj` CLI). A CC skill and a Codex AGENTS/prompt each just shell the CLI. Optional MCP tools later. Composer is one consumer, not the owner.
3. **Loop automation = auto-dispatch both, human gates decisions.** The CLI shells the planner (oracle/GPT-5 Pro) AND the executor (codex / `claude -p`), feeds executor evidence back to the planner automatically, and stops at the human accept/adjust/reject gate each phase.

`gproj` = "GPT Project" — the CLI binary and the `.gproj/` on-disk store.

## 4. Architecture

### 4.1 On-disk project format (`.gproj/`, git-versioned, lives in target repo)

```
.gproj/
  project.md            # goal, constraints, success definition — HUMAN-owned north star
  prd.md                # evolving product brief (planner-authored)
  architecture.md       # agreed technical shape (planner-authored)
  acceptance.md         # explicit acceptance checklist
  decisions.ndjson      # append-only ADR-style "why we chose X" — anti-amnesia log
  known-issues.ndjson   # append-only open risks/debts/caveats
  phases/NN.md          # per-phase plan: goal / in-scope / out-of-scope / acceptance / tests / risk
  packages/NN-exec-prompt.md   # emitted master exec prompt for the phase
  runs/<id>.json        # executor evidence: prompt hash, changed files, diff stats, tests, failures
  reviews/<id>.md       # planner review verdict per run
  state.json            # current phase, status, pointers (Task-Master-style)
  backend.json          # optional stored conversation/session IDs for the planner backend
```

Rationale for split formats: **NDJSON/JSON for machine-ingested evidence** (decisions, known-issues, runs, state) so packs are tight and cheap; **Markdown for narrative** (project/prd/architecture/phase/review) so humans read and edit directly.

### 4.2 Context assembler — the actual "project memory"

Deterministic pack builder. Given the current phase, assembles `goal + architecture + decisions + this-phase plan + last-run evidence + open issues` under a **token budget**, pruning the rest. This bounded assembly is the anti-drift mechanism: the planner sees memory, never the raw repo.

### 4.3 CLI surface

```
gproj init "<goal>"        # scaffold project.md from a goal
gproj update               # assemble pack → planner refreshes prd/architecture/decisions
gproj package [phase]      # assemble pack → planner emits phases/NN.md + packages/NN-exec-prompt.md
gproj exec [phase]         # executor (codex / claude -p) runs the phase → capture diff+tests
gproj ingest-run <run>     # write executor evidence into runs/<id>.json
gproj review [phase]       # pack + run evidence → planner review mode → reviews/<id>.md verdict
gproj decide accept|adjust|reject   # HUMAN GATE — only manual step; advances or loops
gproj advance              # auto wrapper: package → exec → ingest-run → review, stop at decide
gproj status               # where am I, what's next
```

`package` and `ingest-run` remain separate underneath the `advance` auto-wrapper so a manual copy-paste fallback exists and each step is independently testable.

**Design point from the source workflow:** the planner reviews from **evidence packs, never repo access** ("GPT Pro 不需要进入代码库"). Evidence = diff + test output + the executor's self-authored review-prompt.

### 4.4 Pluggable backends

- **Planner adapter:** `oracle-browser` (GPT-Pro UX via the `oracle` CLI) and `openai-responses` (Responses + Conversations API = genuine programmable thread continuity). Local files stay authoritative; backend continuity is an accelerant.
- **Executor target:** `codex` or `claude-code` prompt styles.

### 4.5 Composer integration

Composer **consumes** the CLI; it does not absorb the logic. Composer maps its `oraclePlanner` lane → `gproj` planner adapter and `composer_code_cli` (codex) → `gproj` executor adapter, wrapping dispatches in its existing spend-gate + boundary-guard. The `.gproj/` store lives in the target repo, git-versioned. CC drives `gproj` via a thin skill; Codex via an AGENTS/prompt — one format, two tools, zero divergence.

## 5. MVP scope (ruthless YAGNI)

**In:**
- `.gproj/` format + context assembler.
- CLI: `init / update / package / exec / ingest-run / review / decide / advance / status`.
- Planner backends: `oracle-browser` + `openai-responses`.
- Executor targets: `codex` + `claude-code`.
- One CC skill that shells the CLI.

**Out (v1):**
- Bidirectional ChatGPT-Project sync.
- Repo-wide vector-store/RAG.
- Multi-user collaboration semantics.
- Fully autonomous continue/stop without human approval.
- Any UI beyond files + CLI.

One-sentence scope: **"a local project brain that emits executor-ready phase packets and re-ingests executor evidence into a persistent planner state."**

## 6. Pros / cons / failure modes

**Pros**
- Cross-tool (Codex + CC) from one authoritative format.
- Git-versioned, auditable, deterministic planner memory.
- Closes the manual copy-paste loop the source workflow leaves open.
- Decoupled — Composer is one consumer; other tools can adopt it.

**Cons / failure modes → mitigations**
- *Context drift / planner hallucinating repo state* → bounded evidence packs; planner reviews from diff+tests, never assumed repo state.
- *Planner reviewing without repo access misses real issues* → executor self-authors a structured review-prompt + ships diff/test evidence; high-risk phases can escalate to a repo-aware reviewer (`composer_review`).
- *GPT-5 Pro cost/latency per round* → planner calls are per-phase, not per-edit; cheap modes for `update`, deep modes only for `package`/`review`.
- *Dual truth stores (local vs ChatGPT Project) diverge* → local files authoritative; any ChatGPT mirror is best-effort, read-mostly.
- *Config-as-prose token tax* → deterministic CLI assembly, not prompt templates the agent must re-read each round.

## 7. Open questions

- Does the current Composer Oracle wrapper already preserve any upstream session/thread IDs we can reuse for the `oracle-browser` backend? (Unknown from current code; check `oracle-pro-safe.sh` session handling.)
- Standalone repo location + package name (`gproj` vs `brain` vs `planner`).
- Whether to borrow Spec Kit's `Spec→Plan→Tasks` artifact discipline directly or keep the leaner phase model above.

## 8. Next step

Hand to the writing-plans skill for a phased implementation plan (MVP scope, §5).
