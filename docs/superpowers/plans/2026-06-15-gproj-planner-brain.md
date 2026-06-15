# gproj — Persistent Planner Brain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `gproj`, a standalone cross-tool CLI that holds persistent planner-brain state on disk, assembles bounded context packs, and runs an auto-dispatch goal→package→exec→review loop that stops at a human decision gate.

**Architecture:** A standalone TS/Node (ESM) repo at `/Users/xicao/Projects/gproj`. An on-disk `.gproj/` store (Markdown for narrative, NDJSON/JSON for machine evidence) is the authoritative memory. A deterministic context assembler builds a token-budgeted pack each round. Pluggable planner backends (oracle-browser, openai-responses) and executor targets (codex, claude-code) sit behind narrow interfaces. Composer consumes the CLI; it does not absorb the logic.

**Tech Stack:** TypeScript (ESM), Node 24 LTS, `zod` for schemas/validation, `vitest` for tests, `node:util` `parseArgs` for CLI parsing (zero heavy CLI deps), `tsx` for dev run, `tsc` for typecheck/build.

**Spec:** `docs/superpowers/specs/2026-06-15-gproj-planner-brain-design.md` (in the composer repo).

---

## File structure (gproj repo)

```
gproj/
  package.json            # bin: { gproj: ./dist/cli.js }, type: module
  tsconfig.json
  vitest.config.ts
  src/
    cli.ts                # entry: parse argv → dispatch to a command
    format/
      paths.ts            # resolve .gproj/* paths from a root
      schema.ts           # zod: StateSchema, DecisionSchema, KnownIssueSchema, RunSchema, PhaseMeta
      store.ts            # read/write .gproj files (md, ndjson append, json)
    assembler/
      budget.ts           # estimateTokens(text), pruneToBudget(sections, maxTokens)
      pack.ts             # buildContextPack(root, phaseId, maxTokens) → string
    backends/
      planner.ts          # PlannerBackend interface + getPlannerBackend(name)
      executor.ts         # ExecutorTarget interface + getExecutorTarget(name)
      oracleBrowser.ts    # PlannerBackend via the `oracle` CLI
      openaiResponses.ts  # PlannerBackend via Responses + Conversations API
      codex.ts            # ExecutorTarget via `codex exec`
      claudeCode.ts       # ExecutorTarget via `claude -p`
    commands/
      init.ts update.ts package.ts exec.ts ingestRun.ts review.ts decide.ts advance.ts status.ts
  tests/
    format/{schema,store}.test.ts
    assembler/{budget,pack}.test.ts
    commands/{init,status,package,decide,advance}.test.ts
    backends/{planner,executor}.test.ts
```

---

## Phase 0 — Repo scaffold

### Task 0: Scaffold the standalone repo

**Files:**
- Create: `/Users/xicao/Projects/gproj/package.json`
- Create: `/Users/xicao/Projects/gproj/tsconfig.json`
- Create: `/Users/xicao/Projects/gproj/vitest.config.ts`
- Create: `/Users/xicao/Projects/gproj/.gitignore`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "gproj",
  "version": "0.0.1",
  "type": "module",
  "bin": { "gproj": "./dist/cli.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx src/cli.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": { "zod": "^3.23.8" },
  "devDependencies": { "typescript": "^5.6.0", "tsx": "^4.19.0", "vitest": "^2.1.0", "@types/node": "^22.0.0" }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ES2022", "moduleResolution": "Bundler",
    "strict": true, "esModuleInterop": true, "skipLibCheck": true,
    "outDir": "dist", "rootDir": "src", "declaration": false
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["tests/**/*.test.ts"], environment: "node" } });
```

- [ ] **Step 4: Create .gitignore**

```
node_modules
dist
.gproj/backend.json
```

- [ ] **Step 5: Install and verify**

Run: `cd /Users/xicao/Projects/gproj && npm install && npm run typecheck`
Expected: install succeeds, `tsc --noEmit` exits 0 (no src yet → no errors).

- [ ] **Step 6: Commit**

```bash
cd /Users/xicao/Projects/gproj && git init && git add -A && git commit -m "chore: scaffold gproj standalone repo"
```

---

## Phase 1 — Format + assembler (foundation)

### Task 1: zod schemas for the on-disk format

**Files:**
- Create: `/Users/xicao/Projects/gproj/src/format/schema.ts`
- Test: `/Users/xicao/Projects/gproj/tests/format/schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { StateSchema, DecisionSchema, RunSchema } from "../../src/format/schema.js";

describe("schemas", () => {
  it("parses a valid state", () => {
    const s = StateSchema.parse({ currentPhase: 1, status: "planning", phases: [] });
    expect(s.currentPhase).toBe(1);
  });
  it("rejects an unknown status", () => {
    expect(() => StateSchema.parse({ currentPhase: 1, status: "bogus", phases: [] })).toThrow();
  });
  it("parses an append-only decision record", () => {
    const d = DecisionSchema.parse({ ts: "2026-06-15T00:00:00Z", title: "use ndjson", why: "machine-ingestable" });
    expect(d.title).toBe("use ndjson");
  });
  it("parses a run evidence record", () => {
    const r = RunSchema.parse({ id: "r1", phase: 1, promptHash: "abc", changedFiles: ["a.ts"], diffStat: "+1 -0", testsPassed: true, failures: [] });
    expect(r.testsPassed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/xicao/Projects/gproj && npx vitest run tests/format/schema.test.ts`
Expected: FAIL — cannot find module `src/format/schema.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
import { z } from "zod";

export const PhaseMetaSchema = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  status: z.enum(["pending", "planned", "executing", "reviewing", "accepted", "rejected"]),
});

export const StateSchema = z.object({
  currentPhase: z.number().int().positive(),
  status: z.enum(["init", "planning", "packaged", "executing", "reviewing", "deciding", "done"]),
  phases: z.array(PhaseMetaSchema),
});

export const DecisionSchema = z.object({ ts: z.string(), title: z.string(), why: z.string() });
export const KnownIssueSchema = z.object({ ts: z.string(), issue: z.string(), severity: z.enum(["low", "medium", "high"]).default("medium") });
export const RunSchema = z.object({
  id: z.string(), phase: z.number().int().positive(), promptHash: z.string(),
  changedFiles: z.array(z.string()), diffStat: z.string(), testsPassed: z.boolean(), failures: z.array(z.string()),
});

export type State = z.infer<typeof StateSchema>;
export type Decision = z.infer<typeof DecisionSchema>;
export type KnownIssue = z.infer<typeof KnownIssueSchema>;
export type Run = z.infer<typeof RunSchema>;
export type PhaseMeta = z.infer<typeof PhaseMetaSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/xicao/Projects/gproj && npx vitest run tests/format/schema.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/xicao/Projects/gproj && git add src/format/schema.ts tests/format/schema.test.ts && git commit -m "feat(format): zod schemas for .gproj store"
```

### Task 2: path helpers + store read/write

**Files:**
- Create: `/Users/xicao/Projects/gproj/src/format/paths.ts`
- Create: `/Users/xicao/Projects/gproj/src/format/store.ts`
- Test: `/Users/xicao/Projects/gproj/tests/format/store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readState, writeState, appendNdjson, readNdjson, writeMarkdown, readMarkdown } from "../../src/format/store.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "gproj-")); });

describe("store", () => {
  it("round-trips state", () => {
    writeState(root, { currentPhase: 1, status: "init", phases: [] });
    expect(readState(root)?.status).toBe("init");
  });
  it("appends and reads ndjson decisions", () => {
    appendNdjson(root, "decisions.ndjson", { ts: "t", title: "x", why: "y" });
    appendNdjson(root, "decisions.ndjson", { ts: "t2", title: "z", why: "w" });
    expect(readNdjson(root, "decisions.ndjson").length).toBe(2);
  });
  it("round-trips markdown", () => {
    writeMarkdown(root, "prd.md", "# PRD\nhello");
    expect(readMarkdown(root, "prd.md")).toContain("hello");
  });
  it("returns null state when absent", () => {
    expect(readState(root)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/xicao/Projects/gproj && npx vitest run tests/format/store.test.ts`
Expected: FAIL — cannot find `src/format/store.js`.

- [ ] **Step 3: Write paths.ts**

```ts
import { join } from "node:path";
export const gprojDir = (root: string) => join(root, ".gproj");
export const filePath = (root: string, rel: string) => join(gprojDir(root), rel);
export const phasePath = (root: string, id: number) => filePath(root, `phases/${String(id).padStart(2, "0")}.md`);
export const execPromptPath = (root: string, id: number) => filePath(root, `packages/${String(id).padStart(2, "0")}-exec-prompt.md`);
export const runPath = (root: string, id: string) => filePath(root, `runs/${id}.json`);
export const reviewPath = (root: string, id: string) => filePath(root, `reviews/${id}.md`);
```

- [ ] **Step 4: Write store.ts**

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { StateSchema, type State } from "./schema.js";
import { filePath } from "./paths.js";

const ensureDir = (p: string) => mkdirSync(dirname(p), { recursive: true });

export function writeState(root: string, state: State): void {
  const p = filePath(root, "state.json");
  ensureDir(p);
  writeFileSync(p, JSON.stringify(StateSchema.parse(state), null, 2));
}
export function readState(root: string): State | null {
  const p = filePath(root, "state.json");
  if (!existsSync(p)) return null;
  return StateSchema.parse(JSON.parse(readFileSync(p, "utf8")));
}
export function appendNdjson(root: string, rel: string, record: unknown): void {
  const p = filePath(root, rel);
  ensureDir(p);
  appendFileSync(p, JSON.stringify(record) + "\n");
}
export function readNdjson(root: string, rel: string): unknown[] {
  const p = filePath(root, rel);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
export function writeMarkdown(root: string, rel: string, body: string): void {
  const p = filePath(root, rel);
  ensureDir(p);
  writeFileSync(p, body);
}
export function readMarkdown(root: string, rel: string): string | null {
  const p = filePath(root, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/xicao/Projects/gproj && npx vitest run tests/format/store.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
cd /Users/xicao/Projects/gproj && git add src/format/paths.ts src/format/store.ts tests/format/store.test.ts && git commit -m "feat(format): path helpers + store read/write"
```

### Task 3: token budget helper

**Files:**
- Create: `/Users/xicao/Projects/gproj/src/assembler/budget.ts`
- Test: `/Users/xicao/Projects/gproj/tests/assembler/budget.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { estimateTokens, pruneToBudget } from "../../src/assembler/budget.js";

describe("budget", () => {
  it("estimates ~1 token per 4 chars", () => {
    expect(estimateTokens("abcd".repeat(25))).toBe(25);
  });
  it("keeps high-priority sections, drops low ones over budget", () => {
    const sections = [
      { label: "goal", priority: 10, text: "x".repeat(40) },     // 10 tok
      { label: "issues", priority: 1, text: "y".repeat(400) },   // 100 tok
    ];
    const kept = pruneToBudget(sections, 20);
    expect(kept.map((s) => s.label)).toEqual(["goal"]);
  });
  it("keeps mandatory sections even when they exceed the budget", () => {
    const sections = [
      { label: "goal", priority: 10, mandatory: true, text: "x".repeat(4000) },
      { label: "arch", priority: 9, text: "y".repeat(40) },
    ];
    const kept = pruneToBudget(sections, 20);
    expect(kept.map((s) => s.label)).toContain("goal");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/xicao/Projects/gproj && npx vitest run tests/assembler/budget.test.ts`
Expected: FAIL — cannot find `src/assembler/budget.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
export interface Section { label: string; priority: number; text: string; mandatory?: boolean; }
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
export function pruneToBudget(sections: Section[], maxTokens: number): Section[] {
  const ordered = [...sections].sort((a, b) => b.priority - a.priority);
  const kept: Section[] = [];
  let used = 0;
  // mandatory sections are always kept, even if they push past the budget
  for (const s of ordered.filter((x) => x.mandatory)) { kept.push(s); used += estimateTokens(s.text); }
  for (const s of ordered.filter((x) => !x.mandatory)) {
    const cost = estimateTokens(s.text);
    if (used + cost <= maxTokens) { kept.push(s); used += cost; }
  }
  return kept.sort((a, b) => b.priority - a.priority);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/xicao/Projects/gproj && npx vitest run tests/assembler/budget.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/xicao/Projects/gproj && git add src/assembler/budget.ts tests/assembler/budget.test.ts && git commit -m "feat(assembler): token budget + prune"
```

### Task 4: context pack assembler

**Files:**
- Create: `/Users/xicao/Projects/gproj/src/assembler/pack.ts`
- Test: `/Users/xicao/Projects/gproj/tests/assembler/pack.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMarkdown, appendNdjson, writeState } from "../../src/format/store.js";
import { buildContextPack } from "../../src/assembler/pack.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gproj-"));
  writeState(root, { currentPhase: 1, status: "planning", phases: [] });
  writeMarkdown(root, "project.md", "# Goal\nBuild X");
  writeMarkdown(root, "architecture.md", "# Arch\nCLI + store");
  appendNdjson(root, "decisions.ndjson", { ts: "t", title: "local-first", why: "no project API" });
});

describe("buildContextPack", () => {
  it("includes goal, arch, and decisions", () => {
    const pack = buildContextPack(root, 1, 4000);
    expect(pack).toContain("Build X");
    expect(pack).toContain("CLI + store");
    expect(pack).toContain("local-first");
  });
  it("respects the token budget by dropping low-priority sections", () => {
    appendNdjson(root, "known-issues.ndjson", { ts: "t", issue: "z".repeat(8000), severity: "low" });
    const pack = buildContextPack(root, 1, 200);
    expect(pack).toContain("Build X");          // goal is highest priority, kept
    expect(pack).not.toContain("zzzz");          // huge low-priority issue dropped
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/xicao/Projects/gproj && npx vitest run tests/assembler/pack.test.ts`
Expected: FAIL — cannot find `src/assembler/pack.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readMarkdown, readNdjson, readState } from "../format/store.js";
import { pruneToBudget, type Section } from "./budget.js";
import { filePath } from "../format/paths.js";
import { RunSchema, type Run } from "../format/schema.js";

function latestRunForPhase(root: string, phase: number): Run | null {
  const dir = filePath(root, "runs");
  if (!existsSync(dir)) return null;
  const runs = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => { try { return RunSchema.parse(JSON.parse(readFileSync(filePath(root, `runs/${f}`), "utf8"))); } catch { return null; } })
    .filter((r): r is Run => r !== null && r.phase === phase);
  return runs.length ? runs[runs.length - 1] : null;
}

function latestReview(root: string, phase: number): string | null {
  const dir = filePath(root, "reviews");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.startsWith(`p${phase}-`) && f.endsWith(".md")).sort();
  if (!files.length) return null;
  return readFileSync(filePath(root, `reviews/${files[files.length - 1]}`), "utf8");
}

export function buildContextPack(root: string, phaseId: number, maxTokens: number): string {
  const sections: Section[] = [];
  const goal = readMarkdown(root, "project.md");
  if (goal) sections.push({ label: "GOAL", priority: 100, mandatory: true, text: goal });
  const phase = readMarkdown(root, `phases/${String(phaseId).padStart(2, "0")}.md`);
  if (phase) sections.push({ label: `PHASE ${phaseId}`, priority: 90, mandatory: true, text: phase });
  const run = latestRunForPhase(root, phaseId);
  if (run) sections.push({ label: "RUN EVIDENCE", priority: 85, mandatory: true, text: `tests: ${run.testsPassed ? "pass" : "fail"}\nchanged: ${run.changedFiles.join(", ")}\ndiffstat: ${run.diffStat}\nfailures:\n${run.failures.map((f) => `- ${f}`).join("\n")}` });
  const arch = readMarkdown(root, "architecture.md");
  if (arch) sections.push({ label: "ARCHITECTURE", priority: 80, text: arch });
  const decisions = readNdjson(root, "decisions.ndjson") as { title: string; why: string }[];
  if (decisions.length) sections.push({ label: "DECISIONS", priority: 70, text: decisions.map((d) => `- ${d.title}: ${d.why}`).join("\n") });
  const lastReview = latestReview(root, phaseId);
  if (lastReview) sections.push({ label: "LAST REVIEW", priority: 65, text: lastReview });
  const state = readState(root);
  if (state) sections.push({ label: "STATE", priority: 60, text: `phase ${state.currentPhase}, status ${state.status}` });
  const issues = readNdjson(root, "known-issues.ndjson") as { issue: string; severity: string }[];
  if (issues.length) sections.push({ label: "KNOWN ISSUES", priority: 40, text: issues.map((i) => `- [${i.severity}] ${i.issue}`).join("\n") });
  const kept = pruneToBudget(sections, maxTokens);
  return kept.sort((a, b) => b.priority - a.priority).map((s) => `## ${s.label}\n${s.text}`).join("\n\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/xicao/Projects/gproj && npx vitest run tests/assembler/pack.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/xicao/Projects/gproj && git add src/assembler/pack.ts tests/assembler/pack.test.ts && git commit -m "feat(assembler): bounded context pack builder"
```

---

## Phase 2 — Backend interfaces + core commands

### Task 5: planner + executor interfaces with stub backends

**Files:**
- Create: `/Users/xicao/Projects/gproj/src/backends/planner.ts`
- Create: `/Users/xicao/Projects/gproj/src/backends/executor.ts`
- Test: `/Users/xicao/Projects/gproj/tests/backends/planner.test.ts`
- Test: `/Users/xicao/Projects/gproj/tests/backends/executor.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/backends/planner.test.ts
import { describe, it, expect } from "vitest";
import { getPlannerBackend } from "../../src/backends/planner.js";
describe("planner registry", () => {
  it("returns a stub backend by name", async () => {
    const b = getPlannerBackend("stub");
    const out = await b.ask({ pack: "ctx", instruction: "plan phase 1" });
    expect(out).toContain("plan phase 1");
  });
  it("throws on unknown backend", () => {
    expect(() => getPlannerBackend("nope")).toThrow(/unknown planner/i);
  });
});
```

```ts
// tests/backends/executor.test.ts
import { describe, it, expect } from "vitest";
import { getExecutorTarget } from "../../src/backends/executor.js";
describe("executor registry", () => {
  it("returns a stub target by name", async () => {
    const t = getExecutorTarget("stub");
    const r = await t.run({ root: "/tmp", phase: 1, prompt: "do it" });
    expect(r.changedFiles).toBeInstanceOf(Array);
    expect(typeof r.testsPassed).toBe("boolean");
  });
  it("throws on unknown target", () => {
    expect(() => getExecutorTarget("nope")).toThrow(/unknown executor/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/xicao/Projects/gproj && npx vitest run tests/backends`
Expected: FAIL — cannot find planner.js / executor.js.

- [ ] **Step 3: Write planner.ts**

```ts
export interface PlannerAsk { pack: string; instruction: string; mode?: string; }
export interface PlannerBackend { name: string; ask(req: PlannerAsk): Promise<string>; }

const stub: PlannerBackend = { name: "stub", async ask(req) { return `STUB PLAN\n${req.instruction}\n---\n${req.pack}`; } };

export function getPlannerBackend(name: string): PlannerBackend {
  const registry: Record<string, PlannerBackend> = { stub };
  const b = registry[name];
  if (!b) throw new Error(`unknown planner backend: ${name}`);
  return b;
}
```

- [ ] **Step 4: Write executor.ts**

```ts
export interface ExecutorRun { root: string; phase: number; prompt: string; }
export interface ExecutorResult { changedFiles: string[]; diffStat: string; testsPassed: boolean; failures: string[]; raw: string; }
export interface ExecutorTarget { name: string; run(req: ExecutorRun): Promise<ExecutorResult>; }

const stub: ExecutorTarget = {
  name: "stub",
  async run() { return { changedFiles: [], diffStat: "+0 -0", testsPassed: true, failures: [], raw: "stub run" }; },
};

export function getExecutorTarget(name: string): ExecutorTarget {
  const registry: Record<string, ExecutorTarget> = { stub };
  const t = registry[name];
  if (!t) throw new Error(`unknown executor target: ${name}`);
  return t;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/xicao/Projects/gproj && npx vitest run tests/backends`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
cd /Users/xicao/Projects/gproj && git add src/backends/planner.ts src/backends/executor.ts tests/backends && git commit -m "feat(backends): planner+executor interfaces with stubs"
```

### Task 6: `init` + `status` commands and CLI entry

**Files:**
- Create: `/Users/xicao/Projects/gproj/src/commands/init.ts`
- Create: `/Users/xicao/Projects/gproj/src/commands/status.ts`
- Create: `/Users/xicao/Projects/gproj/src/cli.ts`
- Test: `/Users/xicao/Projects/gproj/tests/commands/init.test.ts`
- Test: `/Users/xicao/Projects/gproj/tests/commands/status.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/commands/init.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../src/commands/init.js";
import { readState, readMarkdown } from "../../src/format/store.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "gproj-")); });

describe("init", () => {
  it("scaffolds project.md and state.json", () => {
    runInit(root, "Build a coding agent");
    expect(readMarkdown(root, "project.md")).toContain("Build a coding agent");
    expect(readState(root)?.currentPhase).toBe(1);
    expect(readState(root)?.status).toBe("init");
  });
  it("is idempotent-safe: refuses to clobber existing project", () => {
    runInit(root, "first");
    expect(() => runInit(root, "second")).toThrow(/already initialized/i);
  });
});
```

```ts
// tests/commands/status.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../src/commands/init.js";
import { renderStatus } from "../../src/commands/status.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "gproj-")); });

describe("status", () => {
  it("reports phase, status, and next action", () => {
    runInit(root, "goal");
    const out = renderStatus(root);
    expect(out).toContain("phase 1");
    expect(out).toContain("init");
    expect(out.toLowerCase()).toContain("next");
  });
  it("reports uninitialized when no store", () => {
    expect(renderStatus(root)).toMatch(/not initialized/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/xicao/Projects/gproj && npx vitest run tests/commands/init.test.ts tests/commands/status.test.ts`
Expected: FAIL — cannot find init.js / status.js.

- [ ] **Step 3: Write init.ts**

```ts
import { existsSync } from "node:fs";
import { filePath } from "../format/paths.js";
import { writeState, writeMarkdown } from "../format/store.js";

export function runInit(root: string, goal: string): void {
  if (existsSync(filePath(root, "state.json"))) throw new Error("gproj already initialized in this directory");
  writeMarkdown(root, "project.md", `# Goal\n\n${goal}\n\n## Constraints\n\n(define)\n\n## Acceptance\n\n(define)\n`);
  writeMarkdown(root, "acceptance.md", "# Acceptance checklist\n\n- [ ] (define)\n");
  writeState(root, { currentPhase: 1, status: "init", phases: [] });
}
```

- [ ] **Step 4: Write status.ts**

```ts
import { readState } from "../format/store.js";

const NEXT: Record<string, string> = {
  init: "run `gproj package` to plan phase 1",
  packaged: "run `gproj exec` to execute the phase",
  executing: "run `gproj review` once execution finishes",
  reviewing: "run `gproj decide accept|adjust|reject`",
  deciding: "run `gproj decide accept|adjust|reject`",
  done: "project complete",
  planning: "run `gproj package` to emit the phase packet",
};

export function renderStatus(root: string): string {
  const s = readState(root);
  if (!s) return "gproj: not initialized (run `gproj init \"<goal>\"`)";
  return `gproj: phase ${s.currentPhase}, status ${s.status}\nnext: ${NEXT[s.status] ?? "(unknown)"}`;
}
```

- [ ] **Step 5: Write cli.ts**

```ts
#!/usr/bin/env node
import { parseArgs } from "node:util";
import { runInit } from "./commands/init.js";
import { renderStatus } from "./commands/status.js";

async function main(): Promise<void> {
  const { positionals } = parseArgs({ allowPositionals: true, args: process.argv.slice(2) });
  const [cmd, ...rest] = positionals;
  const root = process.cwd();
  switch (cmd) {
    case "init": {
      const goal = rest.join(" ");
      if (!goal) { console.error("usage: gproj init \"<goal>\""); process.exit(2); }
      runInit(root, goal);
      console.log(renderStatus(root));
      break;
    }
    case "status":
      console.log(renderStatus(root));
      break;
    default:
      console.error(`gproj: unknown command "${cmd ?? ""}". commands: init, status, package, exec, ingest-run, review, decide, advance`);
      process.exit(2);
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /Users/xicao/Projects/gproj && npx vitest run tests/commands/init.test.ts tests/commands/status.test.ts && npm run typecheck`
Expected: PASS (4 tests), tsc exits 0.

- [ ] **Step 7: Commit**

```bash
cd /Users/xicao/Projects/gproj && git add src/commands/init.ts src/commands/status.ts src/cli.ts tests/commands && git commit -m "feat(cli): init + status commands and entry point"
```

### Task 7: `package` command (planner emits phase plan + exec prompt)

**Files:**
- Create: `/Users/xicao/Projects/gproj/src/commands/package.ts`
- Modify: `/Users/xicao/Projects/gproj/src/cli.ts` (add `package` case)
- Test: `/Users/xicao/Projects/gproj/tests/commands/package.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../src/commands/init.js";
import { runPackage } from "../../src/commands/package.js";
import { readMarkdown, readState } from "../../src/format/store.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "gproj-")); runInit(root, "Build X"); });

describe("package", () => {
  it("writes a phase plan and an exec prompt using the planner backend", async () => {
    await runPackage(root, { plannerName: "stub", maxTokens: 4000 });
    expect(readMarkdown(root, "phases/01.md")).toContain("STUB PLAN");
    expect(readMarkdown(root, "packages/01-exec-prompt.md")).toBeTruthy();
    expect(readState(root)?.status).toBe("packaged");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/xicao/Projects/gproj && npx vitest run tests/commands/package.test.ts`
Expected: FAIL — cannot find package.js.

- [ ] **Step 3: Write package.ts**

```ts
import { buildContextPack } from "../assembler/pack.js";
import { getPlannerBackend } from "../backends/planner.js";
import { readState, writeState, writeMarkdown } from "../format/store.js";

export interface PackageOpts { plannerName: string; maxTokens: number; }

export async function runPackage(root: string, opts: PackageOpts): Promise<void> {
  const state = readState(root);
  if (!state) throw new Error("gproj not initialized");
  const phase = state.currentPhase;
  const pack = buildContextPack(root, phase, opts.maxTokens);
  const planner = getPlannerBackend(opts.plannerName);
  const plan = await planner.ask({ pack, instruction: `Produce a phase ${phase} plan: goal, in-scope, out-of-scope, acceptance, tests, risk.`, mode: "plan" });
  writeMarkdown(root, `phases/${String(phase).padStart(2, "0")}.md`, plan);
  const execPrompt = await planner.ask({ pack, instruction: `Produce a single master exec prompt for an executor to implement phase ${phase}. Reference the phase plan; do not expand scope.`, mode: "plan" });
  writeMarkdown(root, `packages/${String(phase).padStart(2, "0")}-exec-prompt.md`, execPrompt);
  writeState(root, { ...state, status: "packaged" });
}
```

- [ ] **Step 4: Add the `package` case to cli.ts**

Insert this case into the `switch (cmd)` block in `src/cli.ts`, after the `status` case:

```ts
    case "package": {
      const { runPackage } = await import("./commands/package.js");
      await runPackage(root, { plannerName: process.env.GPROJ_PLANNER ?? "stub", maxTokens: Number(process.env.GPROJ_MAX_TOKENS ?? 6000) });
      console.log(renderStatus(root));
      break;
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/xicao/Projects/gproj && npx vitest run tests/commands/package.test.ts && npm run typecheck`
Expected: PASS (1 test), tsc exits 0.

- [ ] **Step 6: Commit**

```bash
cd /Users/xicao/Projects/gproj && git add src/commands/package.ts src/cli.ts tests/commands/package.test.ts && git commit -m "feat(cli): package command emits phase plan + exec prompt"
```

### Task 8: `exec` + `ingest-run` (executor runs phase, evidence captured)

**Files:**
- Create: `/Users/xicao/Projects/gproj/src/commands/exec.ts`
- Create: `/Users/xicao/Projects/gproj/src/commands/ingestRun.ts`
- Modify: `/Users/xicao/Projects/gproj/src/cli.ts`
- Test: `/Users/xicao/Projects/gproj/tests/commands/exec.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../src/commands/init.js";
import { runPackage } from "../../src/commands/package.js";
import { runExec } from "../../src/commands/exec.js";
import { readState, readNdjson } from "../../src/format/store.js";
import { RunSchema } from "../../src/format/schema.js";
import { existsSync } from "node:fs";
import { runPath } from "../../src/format/paths.js";

let root: string;
beforeEach(async () => { root = mkdtempSync(join(tmpdir(), "gproj-")); runInit(root, "Build X"); await runPackage(root, { plannerName: "stub", maxTokens: 4000 }); });

describe("exec", () => {
  it("runs the executor and writes a valid run evidence record", async () => {
    const runId = await runExec(root, { executorName: "stub" });
    expect(existsSync(runPath(root, runId))).toBe(true);
    expect(readState(root)?.status).toBe("executing");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/xicao/Projects/gproj && npx vitest run tests/commands/exec.test.ts`
Expected: FAIL — cannot find exec.js.

- [ ] **Step 3: Write ingestRun.ts**

```ts
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { RunSchema, type Run } from "../format/schema.js";
import { runPath } from "../format/paths.js";

export function ingestRun(root: string, run: Run): void {
  const validated = RunSchema.parse(run);
  const p = runPath(root, validated.id);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(validated, null, 2));
}
```

- [ ] **Step 4: Write exec.ts**

```ts
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { getExecutorTarget } from "../backends/executor.js";
import { readState, writeState, readMarkdown } from "../format/store.js";
import { filePath } from "../format/paths.js";
import { ingestRun } from "./ingestRun.js";

export interface ExecOpts { executorName: string; }

function nextRunIndex(root: string, phase: number): number {
  const dir = filePath(root, "runs");
  if (!existsSync(dir)) return 1;
  return readdirSync(dir).filter((f) => f.startsWith(`p${phase}-r`) && f.endsWith(".json")).length + 1;
}

export async function runExec(root: string, opts: ExecOpts): Promise<string> {
  const state = readState(root);
  if (!state) throw new Error("gproj not initialized");
  const phase = state.currentPhase;
  const prompt = readMarkdown(root, `packages/${String(phase).padStart(2, "0")}-exec-prompt.md`);
  if (!prompt) throw new Error(`no exec prompt for phase ${phase}; run \`gproj package\` first`);
  const target = getExecutorTarget(opts.executorName);
  const result = await target.run({ root, phase, prompt });
  const id = `p${phase}-r${nextRunIndex(root, phase)}`;
  ingestRun(root, { id, phase, promptHash: createHash("sha1").update(prompt).digest("hex").slice(0, 12), changedFiles: result.changedFiles, diffStat: result.diffStat, testsPassed: result.testsPassed, failures: result.failures });
  writeState(root, { ...state, status: "executing" });
  return id;
}
```

- [ ] **Step 5: Add cli cases for `exec` and `ingest-run`**

Insert into the `switch` in `src/cli.ts`:

```ts
    case "exec": {
      const { runExec } = await import("./commands/exec.js");
      const id = await runExec(root, { executorName: process.env.GPROJ_EXECUTOR ?? "stub" });
      console.log(`run recorded: ${id}`);
      console.log(renderStatus(root));
      break;
    }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd /Users/xicao/Projects/gproj && npx vitest run tests/commands/exec.test.ts && npm run typecheck`
Expected: PASS (1 test), tsc exits 0.

- [ ] **Step 7: Commit**

```bash
cd /Users/xicao/Projects/gproj && git add src/commands/exec.ts src/commands/ingestRun.ts src/cli.ts tests/commands/exec.test.ts && git commit -m "feat(cli): exec runs executor and captures run evidence"
```

### Task 9: `review` + `decide` (planner verdict, human gate)

**Files:**
- Create: `/Users/xicao/Projects/gproj/src/commands/review.ts`
- Create: `/Users/xicao/Projects/gproj/src/commands/decide.ts`
- Modify: `/Users/xicao/Projects/gproj/src/cli.ts`
- Test: `/Users/xicao/Projects/gproj/tests/commands/decide.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../src/commands/init.js";
import { runPackage } from "../../src/commands/package.js";
import { runExec } from "../../src/commands/exec.js";
import { runReview } from "../../src/commands/review.js";
import { runDecide } from "../../src/commands/decide.js";
import { readState } from "../../src/format/store.js";

let root: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "gproj-"));
  runInit(root, "Build X");
  await runPackage(root, { plannerName: "stub", maxTokens: 4000 });
  await runExec(root, { executorName: "stub" });
});

describe("review + decide", () => {
  it("review writes a verdict and sets status deciding", async () => {
    await runReview(root, { plannerName: "stub", maxTokens: 4000 });
    expect(readState(root)?.status).toBe("deciding");
  });
  it("accept advances to the next phase", async () => {
    await runReview(root, { plannerName: "stub", maxTokens: 4000 });
    runDecide(root, "accept");
    expect(readState(root)?.currentPhase).toBe(2);
    expect(readState(root)?.status).toBe("planning");
  });
  it("reject returns to planning on the same phase", async () => {
    await runReview(root, { plannerName: "stub", maxTokens: 4000 });
    runDecide(root, "reject");
    expect(readState(root)?.currentPhase).toBe(1);
    expect(readState(root)?.status).toBe("planning");
  });
  it("rejects an unknown decision", async () => {
    await runReview(root, { plannerName: "stub", maxTokens: 4000 });
    expect(() => runDecide(root, "maybe" as never)).toThrow(/accept\|adjust\|reject/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/xicao/Projects/gproj && npx vitest run tests/commands/decide.test.ts`
Expected: FAIL — cannot find review.js / decide.js.

- [ ] **Step 3: Write review.ts**

```ts
import { buildContextPack } from "../assembler/pack.js";
import { getPlannerBackend } from "../backends/planner.js";
import { readState, writeState } from "../format/store.js";
import { existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { filePath, reviewPath } from "../format/paths.js";

export interface ReviewOpts { plannerName: string; maxTokens: number; }

function nextReviewIndex(root: string, phase: number): number {
  const dir = filePath(root, "reviews");
  if (!existsSync(dir)) return 1;
  return readdirSync(dir).filter((f) => f.startsWith(`p${phase}-v`) && f.endsWith(".md")).length + 1;
}

export async function runReview(root: string, opts: ReviewOpts): Promise<void> {
  const state = readState(root);
  if (!state) throw new Error("gproj not initialized");
  const phase = state.currentPhase;
  const pack = buildContextPack(root, phase, opts.maxTokens);
  const planner = getPlannerBackend(opts.plannerName);
  const verdict = await planner.ask({
    pack,
    instruction: `Review phase ${phase} from the evidence only (do NOT assume repo access). Answer: (1) goal met? (2) acceptance met? (3) over-engineered? (4) tests enough? (5) proceed to next phase?`,
    mode: "review",
  });
  const id = `p${phase}-v${nextReviewIndex(root, phase)}`;
  const p = reviewPath(root, id);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, verdict);
  writeState(root, { ...state, status: "deciding" });
}
```

- [ ] **Step 4: Write decide.ts**

```ts
import { readState, writeState } from "../format/store.js";

export type Decision = "accept" | "adjust" | "reject";

export function runDecide(root: string, decision: Decision): void {
  if (decision !== "accept" && decision !== "adjust" && decision !== "reject") {
    throw new Error("decision must be one of accept|adjust|reject");
  }
  const state = readState(root);
  if (!state) throw new Error("gproj not initialized");
  if (decision === "accept") {
    writeState(root, { ...state, currentPhase: state.currentPhase + 1, status: "planning" });
  } else {
    // adjust and reject both loop back to planning on the same phase
    writeState(root, { ...state, status: "planning" });
  }
}
```

- [ ] **Step 5: Add cli cases for `review` and `decide`**

Insert into the `switch` in `src/cli.ts`:

```ts
    case "review": {
      const { runReview } = await import("./commands/review.js");
      await runReview(root, { plannerName: process.env.GPROJ_PLANNER ?? "stub", maxTokens: Number(process.env.GPROJ_MAX_TOKENS ?? 6000) });
      console.log(renderStatus(root));
      break;
    }
    case "decide": {
      const { runDecide } = await import("./commands/decide.js");
      const d = rest[0] as "accept" | "adjust" | "reject";
      runDecide(root, d);
      console.log(renderStatus(root));
      break;
    }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd /Users/xicao/Projects/gproj && npx vitest run tests/commands/decide.test.ts && npm run typecheck`
Expected: PASS (4 tests), tsc exits 0.

- [ ] **Step 7: Commit**

```bash
cd /Users/xicao/Projects/gproj && git add src/commands/review.ts src/commands/decide.ts src/cli.ts tests/commands/decide.test.ts && git commit -m "feat(cli): review verdict + human decide gate"
```

### Task 10: `advance` auto-wrapper (package → exec → review, stop at decide)

**Files:**
- Create: `/Users/xicao/Projects/gproj/src/commands/advance.ts`
- Modify: `/Users/xicao/Projects/gproj/src/cli.ts`
- Test: `/Users/xicao/Projects/gproj/tests/commands/advance.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../src/commands/init.js";
import { runAdvance } from "../../src/commands/advance.js";
import { readState, readMarkdown } from "../../src/format/store.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "gproj-")); runInit(root, "Build X"); });

describe("advance", () => {
  it("runs package→exec→review in one shot and stops at deciding", async () => {
    await runAdvance(root, { plannerName: "stub", executorName: "stub", maxTokens: 4000 });
    expect(readMarkdown(root, "phases/01.md")).toBeTruthy();
    expect(readState(root)?.status).toBe("deciding");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/xicao/Projects/gproj && npx vitest run tests/commands/advance.test.ts`
Expected: FAIL — cannot find advance.js.

- [ ] **Step 3: Write advance.ts**

```ts
import { runPackage } from "./package.js";
import { runExec } from "./exec.js";
import { runReview } from "./review.js";

export interface AdvanceOpts { plannerName: string; executorName: string; maxTokens: number; }

export async function runAdvance(root: string, opts: AdvanceOpts): Promise<void> {
  await runPackage(root, { plannerName: opts.plannerName, maxTokens: opts.maxTokens });
  await runExec(root, { executorName: opts.executorName });
  await runReview(root, { plannerName: opts.plannerName, maxTokens: opts.maxTokens });
  // stops at status "deciding" — human runs `gproj decide`
}
```

- [ ] **Step 4: Add the `advance` case to cli.ts**

```ts
    case "advance": {
      const { runAdvance } = await import("./commands/advance.js");
      await runAdvance(root, {
        plannerName: process.env.GPROJ_PLANNER ?? "stub",
        executorName: process.env.GPROJ_EXECUTOR ?? "stub",
        maxTokens: Number(process.env.GPROJ_MAX_TOKENS ?? 6000),
      });
      console.log(renderStatus(root));
      break;
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/xicao/Projects/gproj && npx vitest run tests/commands/advance.test.ts && npm run typecheck`
Expected: PASS (1 test), tsc exits 0.

- [ ] **Step 6: Run full suite + commit**

Run: `cd /Users/xicao/Projects/gproj && npx vitest run && npm run typecheck`
Expected: all tests PASS, tsc exits 0.

```bash
cd /Users/xicao/Projects/gproj && git add src/commands/advance.ts src/cli.ts tests/commands/advance.test.ts && git commit -m "feat(cli): advance auto-wrapper stops at human decide gate"
```

---

## Phase 3 — Real backends

> The stub backends prove the loop. These tasks add real planner/executor adapters behind the same interfaces. Each shells an external CLI and parses its output; spawning is wrapped with a timeout (mirrors Composer's per-task wall-time bound).

### Task 11: `codex` executor target

**Files:**
- Create: `/Users/xicao/Projects/gproj/src/backends/codex.ts`
- Modify: `/Users/xicao/Projects/gproj/src/backends/executor.ts:` (register `codex`)
- Test: `/Users/xicao/Projects/gproj/tests/backends/codex.test.ts`

- [ ] **Step 1: Write the failing test (inject a fake spawn)**

```ts
import { describe, it, expect } from "vitest";
import { makeCodexTarget } from "../../src/backends/codex.js";

describe("codex executor", () => {
  it("parses changed files and test result from executor output", async () => {
    const fakeSpawn = async () => ({ stdout: "CHANGED: src/a.ts\nCHANGED: src/b.ts\nTESTS: pass\nDIFFSTAT: +12 -3", code: 0 });
    const target = makeCodexTarget(fakeSpawn);
    const r = await target.run({ root: "/tmp", phase: 1, prompt: "do it" });
    expect(r.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
    expect(r.testsPassed).toBe(true);
    expect(r.diffStat).toBe("+12 -3");
  });
  it("marks tests failed and captures failures", async () => {
    const fakeSpawn = async () => ({ stdout: "TESTS: fail\nFAILURE: expected 1 got 2", code: 0 });
    const target = makeCodexTarget(fakeSpawn);
    const r = await target.run({ root: "/tmp", phase: 1, prompt: "x" });
    expect(r.testsPassed).toBe(false);
    expect(r.failures).toContain("expected 1 got 2");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/xicao/Projects/gproj && npx vitest run tests/backends/codex.test.ts`
Expected: FAIL — cannot find codex.js.

- [ ] **Step 3: Write codex.ts**

```ts
import { spawn } from "node:child_process";
import type { ExecutorTarget, ExecutorResult, ExecutorRun } from "./executor.js";

export interface SpawnResult { stdout: string; code: number; }
export type SpawnFn = (req: ExecutorRun) => Promise<SpawnResult>;

const realSpawn: SpawnFn = (req) =>
  new Promise((resolve, reject) => {
    const child = spawn("codex", ["exec", "--cd", req.root, req.prompt], { timeout: 1_800_000 });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, code: code ?? 0 }));
  });

function parse(stdout: string): ExecutorResult {
  const changedFiles = [...stdout.matchAll(/^CHANGED:\s*(.+)$/gm)].map((m) => m[1].trim());
  const testsPassed = /^TESTS:\s*pass/m.test(stdout);
  const failures = [...stdout.matchAll(/^FAILURE:\s*(.+)$/gm)].map((m) => m[1].trim());
  const diffStat = (stdout.match(/^DIFFSTAT:\s*(.+)$/m)?.[1] ?? "").trim();
  return { changedFiles, diffStat, testsPassed, failures, raw: stdout };
}

export function makeCodexTarget(spawnFn: SpawnFn = realSpawn): ExecutorTarget {
  return { name: "codex", async run(req) { const { stdout } = await spawnFn(req); return parse(stdout); } };
}
```

- [ ] **Step 4: Register `codex` in executor.ts**

In `src/backends/executor.ts`, import and add to the registry:

```ts
import { makeCodexTarget } from "./codex.js";
// inside getExecutorTarget, change the registry line to:
const registry: Record<string, ExecutorTarget> = { stub, codex: makeCodexTarget() };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/xicao/Projects/gproj && npx vitest run tests/backends/codex.test.ts && npm run typecheck`
Expected: PASS (2 tests), tsc exits 0.

- [ ] **Step 6: Commit**

```bash
cd /Users/xicao/Projects/gproj && git add src/backends/codex.ts src/backends/executor.ts tests/backends/codex.test.ts && git commit -m "feat(backends): codex executor target"
```

### Task 12: `claude-code` executor target

**Files:**
- Create: `/Users/xicao/Projects/gproj/src/backends/claudeCode.ts`
- Modify: `/Users/xicao/Projects/gproj/src/backends/executor.ts` (register `claude-code`)
- Test: `/Users/xicao/Projects/gproj/tests/backends/claudeCode.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { makeClaudeCodeTarget } from "../../src/backends/claudeCode.js";

describe("claude-code executor", () => {
  it("parses a claude -p json result envelope", async () => {
    const fakeSpawn = async () => ({ stdout: JSON.stringify({ result: "CHANGED: x.ts\nTESTS: pass\nDIFFSTAT: +1 -0" }), code: 0 });
    const target = makeClaudeCodeTarget(fakeSpawn);
    const r = await target.run({ root: "/tmp", phase: 1, prompt: "do it" });
    expect(r.changedFiles).toEqual(["x.ts"]);
    expect(r.testsPassed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/xicao/Projects/gproj && npx vitest run tests/backends/claudeCode.test.ts`
Expected: FAIL — cannot find claudeCode.js.

- [ ] **Step 3: Write claudeCode.ts**

```ts
import { spawn } from "node:child_process";
import type { ExecutorTarget, ExecutorResult } from "./executor.js";
import type { SpawnFn, SpawnResult } from "./codex.js";

const realSpawn: SpawnFn = (req) =>
  new Promise<SpawnResult>((resolve, reject) => {
    const child = spawn("claude", ["-p", "--output-format", "json", req.prompt], { cwd: req.root, timeout: 1_800_000 }); // NOTE: bypassPermissions removed in Phase 5 (Task 23). With no flag, claude -p inherits the ambient permission default — NOT guaranteed safe; explicit allowed-tools + sandbox is Phase 6 item 1.
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, code: code ?? 0 }));
  });

function parse(stdout: string): ExecutorResult {
  let body = stdout;
  try { const j = JSON.parse(stdout) as { result?: string }; if (typeof j.result === "string") body = j.result; } catch { /* plain text */ }
  const changedFiles = [...body.matchAll(/^CHANGED:\s*(.+)$/gm)].map((m) => m[1].trim());
  const testsPassed = /^TESTS:\s*pass/m.test(body);
  const failures = [...body.matchAll(/^FAILURE:\s*(.+)$/gm)].map((m) => m[1].trim());
  const diffStat = (body.match(/^DIFFSTAT:\s*(.+)$/m)?.[1] ?? "").trim();
  return { changedFiles, diffStat, testsPassed, failures, raw: stdout };
}

export function makeClaudeCodeTarget(spawnFn: SpawnFn = realSpawn): ExecutorTarget {
  return { name: "claude-code", async run(req) { const { stdout } = await spawnFn(req); return parse(stdout); } };
}
```

- [ ] **Step 4: Register `claude-code` in executor.ts**

```ts
import { makeClaudeCodeTarget } from "./claudeCode.js";
// registry line:
const registry: Record<string, ExecutorTarget> = { stub, codex: makeCodexTarget(), "claude-code": makeClaudeCodeTarget() };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/xicao/Projects/gproj && npx vitest run tests/backends/claudeCode.test.ts && npm run typecheck`
Expected: PASS (1 test), tsc exits 0.

- [ ] **Step 6: Commit**

```bash
cd /Users/xicao/Projects/gproj && git add src/backends/claudeCode.ts src/backends/executor.ts tests/backends/claudeCode.test.ts && git commit -m "feat(backends): claude-code executor target"
```

### Task 13: `oracle-browser` planner backend

**Files:**
- Create: `/Users/xicao/Projects/gproj/src/backends/oracleBrowser.ts`
- Modify: `/Users/xicao/Projects/gproj/src/backends/planner.ts` (register `oracle-browser`)
- Test: `/Users/xicao/Projects/gproj/tests/backends/oracleBrowser.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { makeOracleBrowserBackend } from "../../src/backends/oracleBrowser.js";

describe("oracle-browser planner", () => {
  it("passes the pack as context and returns the answer text", async () => {
    let captured = "";
    const fakeSpawn = async (args: { prompt: string; context: string }) => { captured = args.context; return "ANSWER: plan here"; };
    const b = makeOracleBrowserBackend(fakeSpawn);
    const out = await b.ask({ pack: "CTX BODY", instruction: "plan phase 1", mode: "plan" });
    expect(out).toContain("plan here");
    expect(captured).toContain("CTX BODY");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/xicao/Projects/gproj && npx vitest run tests/backends/oracleBrowser.test.ts`
Expected: FAIL — cannot find oracleBrowser.js.

- [ ] **Step 3: Write oracleBrowser.ts**

```ts
import { spawn } from "node:child_process";
import type { PlannerBackend, PlannerAsk } from "./planner.js";

export type OracleSpawn = (args: { prompt: string; context: string; mode?: string }) => Promise<string>;

const realSpawn: OracleSpawn = ({ prompt, context, mode }) =>
  new Promise<string>((resolve, reject) => {
    const tag = mode ? `[oracle:${mode}] ` : "";
    const child = spawn("oracle", ["--context", context, `${tag}${prompt}`], { timeout: 1_500_000 });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.on("error", reject);
    child.on("close", () => resolve(stdout));
  });

export function makeOracleBrowserBackend(spawnFn: OracleSpawn = realSpawn): PlannerBackend {
  return { name: "oracle-browser", async ask(req: PlannerAsk) { return spawnFn({ prompt: req.instruction, context: req.pack, mode: req.mode }); } };
}
```

- [ ] **Step 4: Register `oracle-browser` in planner.ts**

```ts
import { makeOracleBrowserBackend } from "./oracleBrowser.js";
// registry:
const registry: Record<string, PlannerBackend> = { stub, "oracle-browser": makeOracleBrowserBackend() };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/xicao/Projects/gproj && npx vitest run tests/backends/oracleBrowser.test.ts && npm run typecheck`
Expected: PASS (1 test), tsc exits 0.

- [ ] **Step 6: Commit**

```bash
cd /Users/xicao/Projects/gproj && git add src/backends/oracleBrowser.ts src/backends/planner.ts tests/backends/oracleBrowser.test.ts && git commit -m "feat(backends): oracle-browser planner backend"
```

### Task 14: `openai-responses` planner backend (programmable thread continuity)

**Files:**
- Create: `/Users/xicao/Projects/gproj/src/backends/openaiResponses.ts`
- Modify: `/Users/xicao/Projects/gproj/src/backends/planner.ts` (register `openai-responses`)
- Test: `/Users/xicao/Projects/gproj/tests/backends/openaiResponses.test.ts`

- [ ] **Step 1: Write the failing test (inject a fake fetch + backend.json store)**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeOpenAIResponsesBackend } from "../../src/backends/openaiResponses.js";
import { filePath } from "../../src/format/paths.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "gproj-")); });

describe("openai-responses planner", () => {
  it("creates a conversation on first call and reuses it on the second", async () => {
    const calls: string[] = [];
    const fakeFetch = async (url: string, init: { body: string }) => {
      calls.push(url);
      if (url.endsWith("/conversations")) return { ok: true, json: async () => ({ id: "conv_123" }) };
      return { ok: true, json: async () => ({ output_text: "PLAN BODY" }) };
    };
    const b = makeOpenAIResponsesBackend({ apiKey: "k", root, fetchFn: fakeFetch as never });
    const out1 = await b.ask({ pack: "ctx", instruction: "plan 1" });
    const out2 = await b.ask({ pack: "ctx", instruction: "plan 2" });
    expect(out1).toContain("PLAN BODY");
    expect(out2).toContain("PLAN BODY");
    expect(calls.filter((u) => u.endsWith("/conversations")).length).toBe(1); // conversation created once
    expect(existsSync(filePath(root, "backend.json"))).toBe(true);
    expect(JSON.parse(readFileSync(filePath(root, "backend.json"), "utf8")).conversationId).toBe("conv_123");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/xicao/Projects/gproj && npx vitest run tests/backends/openaiResponses.test.ts`
Expected: FAIL — cannot find openaiResponses.js.

- [ ] **Step 3: Write openaiResponses.ts**

```ts
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { PlannerBackend, PlannerAsk } from "./planner.js";
import { filePath } from "../format/paths.js";

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; json: () => Promise<any> }>;
export interface OpenAIOpts { apiKey: string; root: string; baseUrl?: string; model?: string; fetchFn?: FetchLike; }

function readConvId(root: string): string | null {
  const p = filePath(root, "backend.json");
  if (!existsSync(p)) return null;
  return (JSON.parse(readFileSync(p, "utf8")).conversationId as string) ?? null;
}
function writeConvId(root: string, conversationId: string): void {
  const p = filePath(root, "backend.json");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ conversationId }, null, 2));
}

export function makeOpenAIResponsesBackend(opts: OpenAIOpts): PlannerBackend {
  const base = opts.baseUrl ?? "https://api.openai.com/v1";
  const model = opts.model ?? "gpt-5.5-pro";
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as FetchLike);
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` };
  return {
    name: "openai-responses",
    async ask(req: PlannerAsk): Promise<string> {
      let convId = readConvId(opts.root);
      if (!convId) {
        const r = await fetchFn(`${base}/conversations`, { method: "POST", headers, body: JSON.stringify({}) });
        if (!r.ok) throw new Error("openai: failed to create conversation");
        convId = (await r.json()).id as string;
        writeConvId(opts.root, convId);
      }
      const r = await fetchFn(`${base}/responses`, {
        method: "POST", headers,
        body: JSON.stringify({ model, conversation: convId, input: `${req.instruction}\n\n# CONTEXT\n${req.pack}` }),
      });
      if (!r.ok) throw new Error("openai: response failed");
      const j = await r.json();
      return (j.output_text as string) ?? JSON.stringify(j);
    },
  };
}
```

- [ ] **Step 4: Register in planner.ts (env-gated)**

```ts
import { makeOpenAIResponsesBackend } from "./openaiResponses.js";
// inside getPlannerBackend, before the lookup:
if (name === "openai-responses") {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("openai-responses requires OPENAI_API_KEY");
  return makeOpenAIResponsesBackend({ apiKey, root: process.cwd() });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/xicao/Projects/gproj && npx vitest run tests/backends/openaiResponses.test.ts && npm run typecheck`
Expected: PASS (1 test), tsc exits 0.

- [ ] **Step 6: Commit**

```bash
cd /Users/xicao/Projects/gproj && git add src/backends/openaiResponses.ts src/backends/planner.ts tests/backends/openaiResponses.test.ts && git commit -m "feat(backends): openai-responses planner with conversation continuity"
```

---

## Phase 4 — Cross-tool shims + Composer integration

### Task 15: Claude Code skill that shells the CLI

**Files:**
- Create: `/Users/xicao/Projects/gproj/shims/claude-skill/SKILL.md`
- Create: `/Users/xicao/Projects/gproj/shims/codex/AGENTS.gproj.md`
- Create: `/Users/xicao/Projects/gproj/README.md`

- [ ] **Step 1: Write the CC skill**

```markdown
---
name: gproj
description: Use when the user wants to run a persistent planner-brain loop (goal → plan → execute → review → decide) across rounds without losing context. Shells the `gproj` CLI; state lives in .gproj/.
---

# gproj — persistent planner brain

Drive the loop by shelling the CLI. NEVER reimplement its logic inline.

- New project: `gproj init "<goal>"`
- One round (auto, stops at human gate): `gproj advance`
- Inspect: `gproj status`
- Human decision after review: `gproj decide accept|adjust|reject`
- Backends via env: `GPROJ_PLANNER=oracle-browser|openai-responses`, `GPROJ_EXECUTOR=codex|claude-code`.

The planner reviews from evidence (diff + tests) only — never give it raw repo access. The `.gproj/` store is git-versioned; commit it with the code.
```

- [ ] **Step 2: Write the Codex shim**

```markdown
# gproj (Codex)

This repo uses gproj for planner-brain state. Drive it with the CLI:
`gproj init "<goal>"` · `gproj advance` · `gproj status` · `gproj decide accept|adjust|reject`.
Set `GPROJ_EXECUTOR=codex`. Do not expand scope beyond the current phase's exec prompt in `.gproj/packages/`.
```

- [ ] **Step 3: Write README.md**

```markdown
# gproj

A cross-tool persistent planner brain. Human sets direction; a high-reasoning planner clarifies/plans/reviews; an executor (Codex or Claude Code) edits code. State lives on disk in `.gproj/` and is assembled into a bounded context pack each round.

## Install
`npm i -g gproj` (or `npm link` from a clone).

## Use
```
gproj init "Build a meeting agent"
GPROJ_PLANNER=oracle-browser GPROJ_EXECUTOR=codex gproj advance
gproj status
gproj decide accept
```

## Backends
- Planner: `stub` | `oracle-browser` | `openai-responses`
- Executor: `stub` | `codex` | `claude-code`
```

- [ ] **Step 4: Commit**

```bash
cd /Users/xicao/Projects/gproj && git add shims README.md && git commit -m "docs: CC skill + Codex shim + README"
```

### Task 16: Composer consumes gproj (config + doc note)

> Composer integrates `gproj` as one consumer: it maps its `oraclePlanner` lane to `GPROJ_PLANNER=oracle-browser` and `composer_code_cli` to `GPROJ_EXECUTOR=codex` when driving a gproj project. This task only documents the integration contract; no Composer code change is required for MVP because Composer drives `gproj` via Bash like any CLI.

**Files (in the composer repo):**
- Create: `docs/integrations/gproj.md`

- [ ] **Step 1: Write the integration note**

```markdown
# gproj integration

Composer consumes the standalone `gproj` CLI (repo: /Users/xicao/Projects/gproj). It does NOT absorb gproj's logic.

- Planner lane: Composer's `oraclePlanner` (oracle CLI) → `GPROJ_PLANNER=oracle-browser`.
- Executor lane: `composer_code_cli` (codex) → `GPROJ_EXECUTOR=codex`.
- Spend + boundary: gproj dispatches inherit Composer's `spendAuthorization` and `boundary_guard` because Composer invokes `gproj` via Bash.
- State: `.gproj/` lives in the target repo, git-versioned. The orchestrator runs `gproj advance`, surfaces the review verdict, and asks the user before `gproj decide`.
```

- [ ] **Step 2: Commit (composer repo)**

```bash
git -C /Users/xicao/Projects/composer add docs/integrations/gproj.md && git -C /Users/xicao/Projects/composer commit -m "docs: gproj integration contract"
```

---

## Self-review notes

- **Spec coverage:** format (§4.1) → Tasks 1–2; assembler (§4.2) → Tasks 3–4; CLI verbs (§4.3) → Tasks 6–10; planner/executor backends (§4.4) → Tasks 5, 11–14; Composer integration (§4.5) → Task 16; CC skill (form factor decision) → Task 15. MVP scope (§5) fully covered. `update` verb from §4.3 is intentionally deferred post-MVP (package subsumes its planner-refresh for v1) — noted here as the one §4.3 item not built.
- **Type consistency:** `PlannerBackend.ask(PlannerAsk)` and `ExecutorTarget.run(ExecutorRun)→ExecutorResult` are defined once (Task 5) and reused unchanged (Tasks 11–14). `State.status` enum values are produced only by commands that the status `NEXT` map (Task 6) covers.
- **Known deferral:** the `review.ts` reads run evidence from JSON files under `runs/` (written by `ingestRun`), not an `runs.ndjson`; the unused `readNdjson(root, "runs.ndjson")` line in Task 9 Step 3 should be deleted during implementation (left as a no-op to avoid an extra import churn in the plan; remove it).
---

## Phase 5 — Verified Run Evidence (SHIPPED 2026-06-16, gproj commit 6077594)

> Implementation + tests live in the standalone **gproj** repo (`/Users/xicao/Projects/gproj`, commit `6077594`, 55 vitest passing, tsc clean) — NOT in this composer repo. This composer document is the plan/record only; the code is cross-repo by design (composer consumes gproj).

Built in response to the oracle deep-review (`.composer/oracle/answers/20260616-071333-review.md`), which found the MVP unsound because `exec` trusted executor stdout as authoritative evidence ("review of a press release"). 55 vitest, tsc clean.

**NOT YET SAFE FOR UNATTENDED EXECUTION.** Phase 5 closes only the evidence-trust hole (the planner can no longer be fooled by executor self-report). The executor trust boundary is still open: dropping the bypassPermissions default removes one explicit danger flag but does NOT reduce risk to a safe level (claude -p then inherits an ambient permission default that may be permissive) — real isolation (worktree/container sandbox), crash recovery, file locking, and secret redaction remain UNBUILT (Phase 6). Do not run write-executors unattended on a repo you care about until Phase 6 ships.

- **Project config** `src/config/projectConfig.ts` (`.gproj/config.json`): testCommand, typecheckCommand, plannerBackend/executorBackend, plannerModel, maxPackTokens, sandbox.mode, redactions. `loadConfig` merges over defaults; malformed JSON throws a clear error.
- **gproj-owned verifier** `src/verifier/git.ts` (baseHead/postHead, `git status --porcelain`, diffstat, non-repo safe) + `src/verifier/tests.ts` (runs configured test/typecheck; **fail-closed** when none configured; spawnSync timeout + maxBuffer + abnormal-result handling).
- **RunSchema v2** + **exec rewired**: executor output is now `executorClaims` (UNTRUSTED); `run.testsPassed`/`changedFiles`/`diffStat` derive from the verifier/git ONLY. Key test: executor prints `TESTS: pass` but the verifier command exits 1 → evidence says failed.
- **pack** renders verified facts first, executor claims labelled UNTRUSTED; `latestRunForPhase` sorts by numeric run index (not readdir order).
- **Removed an explicit danger flag (NOT a safety guarantee)**: dropped `--permission-mode bypassPermissions` from the claude executor default. With no flag, `claude -p` inherits the ambient/global permission default, which may itself be permissive — so this is not hardening. Treat the claude write-executor as EXPERIMENTAL/unsafe-for-unattended-use; explicit allowed-tools + sandbox is Phase 6 item 1.

## Phase 6 — backlog (deferred, from oracle review — not yet built)

Ranked, still open before "usable for unattended daily 10k-LOC work":
1. **Sandbox/worktree execution** for write executors (run in a disposable git worktree; merge on accept). The bypass default is dropped but full isolation is not built.
2. **Crash recovery**: append-only run journal (packaging/executing/verifying/…/aborted), `packageId`/`attemptId`, `gproj recover`, atomic state transitions.
3. **File locking** around state/id-allocation/NDJSON/backend.json (max-index ids race across concurrent processes).
4. **Pack manifest + fail-closed `PACK_TOO_LARGE`**: per-section caps, rolling compaction of unbounded decisions/known-issues, model-aware token estimate (replace chars/4).
5. **Secret redaction / prompt-injection defense**: pack sanitizer (denylist `.env*`, key/token regexes), treat executor output as untrusted data, store raw logs separately.
6. **Backend hardening**: oracle-browser pass pack via stdin/temp-file not argv (E2BIG) + shared `runChild()` wrapper; openai-responses scope conversationId by {project,branch,phase} + lock; default a cheaper planner model than gpt-5.5-pro + print cost before paid calls.
7. **`gproj status`/`doctor` surface**: report phase, verified changed files, verified tests, dropped context, backend/model, cost, lock holder, recovery recommendation — without opening `.gproj/`.
8. **Phase/package versioning**: don't overwrite `packages/NN-exec-prompt.md` without preserving the package id that produced a run.
