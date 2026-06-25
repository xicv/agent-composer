# ADR 0002 — Meta-MCP Packaging: Distributing Composer to Other Projects

- **Date**: 2026-05-24
- **Status**: Draft (stub — Wave 4 work)
- **Supersedes**: none
- **Companion**: ADR 0001 (Wave 0 contracts — append-only)

## Context

Composer is currently a project-local proof-of-architecture. The MCP server (`src/index.ts`), orchestrator skill (`.claude/skills/composer-mastermind/SKILL.md`), subagents (`.claude/agents/*.md`), boundary hooks (`scripts/boundary_guard.sh`, `scripts/learn.sh`), and config schema (`composer.config.json` + `composer.config.schema.json`) all live in this repo and assume this CWD.

Wave 0–3 deliberately built this way to prove the brain/executor split, token economy, and self-evolution loop without conflating packaging concerns. By 2026-05-24 (HEAD `c708640`), all four resilience layers (sandbox / per-task fault / stat-gate guards / spawn diagnostics) are shipped and 3-round real-mode `/evolve` is unattended-safe. The architectural claims are validated.

The next question — **"can we use composer in any project, not just this one?"** — is Wave 4. This ADR specifies the contract for that distribution.

## Decision

Ship composer as **two coordinated artefacts**:

1. **`@composer-mcp/server`** — npm package containing the MCP server binary + provider adapters. Installed per-project via `npx @composer-mcp/server` or globally via `npm i -g @composer-mcp/server`.
2. **`composer-mastermind` Claude Code plugin** — installable via `/plugin install composer-mastermind` (or `~/.claude/plugins/` git clone), bundling the orchestrator skill + subagent definitions + hooks + slash commands.

The two artefacts are kept separate because they have different lifecycles: the MCP server changes when the provider protocol or tool surface changes; the plugin changes when orchestration prompts or skill text evolve via `/evolve`.

### M0.1 — npm package shape (`@composer-mcp/server`)

```json
{
  "name": "@composer-mcp/server",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "composer-mcp": "./dist/index.js"
  },
  "files": ["dist/", "composer.config.schema.json", "README.md"],
  "engines": { "node": ">=20" },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29",
    "zod": "^3.x"
  }
}
```

Consumer projects add to their `.claude/settings.json`:

```json
{
  "mcpServers": {
    "composer": {
      "command": "npx",
      "args": ["-y", "@composer-mcp/server"]
    }
  }
}
```

The server reads `composer.config.json` from `CLAUDE_PROJECT_DIR` (or `process.cwd()`) and `.env.json` for credentials. Same shape as the in-repo version — no protocol changes.

### M0.2 — Plugin shape (`composer-mastermind`)

Directory layout under `~/.claude/plugins/composer-mastermind/`:

```
composer-mastermind/
├── plugin.json
├── skills/
│   └── composer-mastermind/
│       └── SKILL.md          # orchestrator brain
├── agents/
│   ├── researcher.md         # haiku-wrapped, C0.5 locked tools
│   ├── reviewer.md
│   ├── reviewer-claude.md
│   └── explorer.md
├── commands/
│   └── evolve.md             # /evolve slash command
└── hooks/
    ├── boundary_guard.sh
    └── learn.sh
```

`plugin.json`:

```json
{
  "name": "composer-mastermind",
  "version": "0.1.0",
  "description": "Multi-agent orchestrator: Claude as brain, GLM/Codex/agy as executors",
  "claudeCodeVersion": ">=4.6",
  "requires": ["@composer-mcp/server"],
  "settings": {
    "PreToolUse": ["bash:hooks/boundary_guard.sh"],
    "Stop": ["bash:hooks/learn.sh"]
  }
}
```

### M0.3 — `composer init` bootstrap CLI

Once `@composer-mcp/server` is installed and the plugin is present, a consumer project runs `npx composer-mcp init`. The CLI:

1. Detects `.claude/` directory; creates if missing.
2. Writes `composer.config.json` from the bundled schema (default `roles` set; prompts for provider overrides).
3. Writes `.env.json` (asks for `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`); `.env.json` added to `.gitignore` automatically.
4. Writes the MCP-server entry to `.claude/settings.json` if not present.
5. Prints next-step instructions: `claude` (launch), `/composer-mastermind` (verify skill loads), `/evolve --eval-mode synthetic` (smoke test).

The init flow is idempotent — re-running on an already-initialised project is a no-op (or prints diff if config drift detected).

### M0.4 — Project-vs-global state ownership

| Asset | Lives in | Why |
|---|---|---|
| MCP server binary | npm cache or global `node_modules` | Same code regardless of consumer; versioned by npm |
| Orchestrator skill (`SKILL.md`) | Plugin (`~/.claude/plugins/...`) by default; project-local override allowed at `.claude/skills/composer-mastermind/SKILL.md` | Lets `/evolve` mutate the local copy without touching the install |
| Subagent definitions | Plugin (read-only) | Identical across projects; pluggable via local override |
| `composer.config.json` | Project-local (committed) | Encodes which providers each project wants (GLM, agy, Kimi, mock) |
| `.env.json` | Project-local (gitignored) | Credentials; never leaves the project |
| Evals + baselines | Project-local | Each consumer project may want a different task set |

### M0.5 — Compatibility with existing in-repo install

The composer-monorepo (this repo) becomes the **development instance** of both artefacts:

- `src/index.ts` is the source of `@composer-mcp/server`. `npm run build` emits `dist/` matching the published shape.
- `.claude/skills/composer-mastermind/SKILL.md` is canonical until the plugin install supersedes it on consumer projects.
- The Wave 3 `/evolve` loop continues to operate on the project-local `SKILL.md`; what gets *promoted* via `mv ... SKILL.candidate.md SKILL.md` can be cherry-picked into the published plugin via a release commit.

The plugin's `composer-mastermind/SKILL.md` is the **frozen** version at each plugin release. `/evolve` mutates the project-local copy; plugin updates pull the latest frozen version. This keeps the per-project mutation freedom while letting the plugin ship a known-good baseline.

## Consequences

**Positive**:

- Composer becomes usable in arbitrary projects without cloning this repo.
- Two-artefact split keeps the slow-changing MCP protocol decoupled from the fast-iterating orchestrator prompt.
- `/evolve` continues to work locally without affecting other projects using the published plugin.
- npm versioning gives consumer projects a clear upgrade story.

**Negative**:

- Two release cycles to maintain (`@composer-mcp/server` + `composer-mastermind` plugin).
- Plugin install + MCP server install must be coordinated (plugin lists MCP server as required peer).
- First-time setup adds an `init` step consumers must run; can't be auto-discovered. Friction is the safety feature (matches `COMPOSER_DANGEROUSLY_BYPASS_PERMISSIONS` precedent in ADR 0001 amendment).

## Verification (Wave 4 acceptance criteria)

- `npx @composer-mcp/server --version` prints semver on a clean Node 20 install.
- Fresh project + `composer init` + `claude` boot sequence yields the composer-mastermind skill in `/help` skill list within 30 sec.
- `/evolve --eval-mode synthetic` runs to completion in <2 min with zero file edits to consumer project (other than its own SKILL.md if promoted).
- Plugin install via `/plugin install composer-mastermind` works on at least 2 unrelated test projects (TypeScript backend + Python ML, say).
- All four resilience layers (sandbox, per-task fault, stat-gate, spawn diagnostics) function in consumer projects — verified by running `/evolve --eval-mode real` with intentionally destructive test tasks.

## References

- [ADR 0001](./0001-contracts.md) — Wave 0 contracts (MCP tool names, subagent shape, hook protocol). M0.1–M0.5 do not modify any C0.X.
- [`docs/STATUS.md`](../STATUS.md) — current HEAD `c708640`, 288/288 vitest, 4 real `/evolve` runs.
- [`docs/multi_agent_orchestration_plan.md`](../multi_agent_orchestration_plan.md) §3 (Two-Layer Architecture) — the architecture this ADR packages for distribution.
- [`docs/self_evolving_composer.md`](../self_evolving_composer.md) §6 — explicit "not scope" list still applies (no per-tool LSP, no statusline experiments).

## Open questions (deferred to Wave 4 implementation)

1. **Provider credential portability.** Does each consumer project need its own GLM key, or do we support a `~/.config/composer/credentials.json` global store? Friction vs. security trade-off.
2. **Skill mutation visibility.** When `/evolve` promotes a candidate in a consumer project, should the user see a banner / commit-required marker? Probably yes; needs UX spec.
3. **Plugin update mechanism.** `claude-mem` uses `npx claude-mem@latest`; should `composer-mastermind` plugin updates auto-bump or require explicit `/plugin update composer-mastermind`?
4. **Telemetry boundary.** Real-mode `/evolve` runs cost real money. Should the plugin emit anonymized "round completed" pings to a central counter, or stay fully local? Default local; this ADR commits to local-only unless a future ADR amends.
