import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

export const GOAL_DIR = ".composer/goals";
const ACTIVE_GOAL_INDEX = ".active";
const GOAL_LOCK_TTL_MS = 30 * 60 * 1000;

export type GoalState = "active" | "blocked" | "achieved" | "failed" | "cancelled";
export const TERMINAL_GOAL_STATES = new Set<GoalState>(["achieved", "cancelled", "failed"]);

export function isTerminal(state: GoalState): boolean {
  return TERMINAL_GOAL_STATES.has(state);
}

export const GoalCheckSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  status: z.enum(["pending", "pass", "fail"]),
  lastRunAt: z.string().datetime().optional(),
}).strict();

export const NextActionToolSchema = z.enum([
  "none",
  "composer_code_cli",
  "composer_codex_lifecycle_run",
  "composer_oracle_plan",
  "composer_review",
  "composer_goal_status",
  "composer_goal_step",
  "composer_route_decide",
]);

export const NextActionSchema = z.object({
  tool: NextActionToolSchema,
  args: z.record(z.string(), z.unknown()).optional(),
  manualChecks: z.array(z.string().min(1)).optional(),
  reason: z.string().min(1),
}).strict();

export const GoalHistoryEntrySchema = z.object({
  turn: z.number().int().nonnegative(),
  action: z.string().min(1),
  verdict: z.string().min(1).optional(),
  reason: z.string().min(1).optional(),
}).strict();

export const GoalSchema = z.object({
  goalId: z.string().min(1),
  objective: z.string().min(1),
  condition: z.string().min(1),
  checks: z.array(GoalCheckSchema).refine(hasUniqueCheckNames, {
    message: "check names must be unique",
  }),
  state: z.enum(["active", "blocked", "achieved", "failed", "cancelled"]),
  turns: z.number().int().nonnegative(),
  maxTurns: z.number().int().positive(),
  maxCost: z.number().nonnegative().optional(),
  stallCount: z.number().int().nonnegative().optional(),
  maxConsecutiveStalls: z.number().int().positive().optional(),
  spentUsd: z.number().nonnegative().optional(),
  conditionMet: z.boolean().optional(),
  requireCompletenessCheck: z.boolean().optional(),
  completenessVerified: z.boolean().optional(),
  workflow: z.string().min(1).optional(),
  mode: z.string().min(1).optional(),
  risk: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastAction: z.string().min(1).optional(),
  lastVerdict: z.string().min(1).optional(),
  lastReason: z.string().min(1).optional(),
  history: z.array(GoalHistoryEntrySchema).optional(),
}).strict();

export type GoalCheck = z.infer<typeof GoalCheckSchema>;
export type NextAction = z.infer<typeof NextActionSchema>;
export type GoalRecord = z.infer<typeof GoalSchema>;

export interface StepGoalSignals {
  checkResults?: Array<{ name: string; passed: boolean }>;
  conditionMet?: boolean;
  spentUsd?: number;
  failedAttempts?: number;
  stuck?: boolean;
  budgetExtension?: { maxTurns?: number; maxCost?: number };
  reviewVerdict?: string;
  testsPassed?: boolean;
  completenessVerified?: boolean;
}

export interface StartGoalInput {
  objective: string;
  condition: string;
  checks?: { name: string; command: string }[];
  maxTurns?: number;
  maxCost?: number;
  maxConsecutiveStalls?: number;
  requireCompletenessCheck?: boolean;
  workflow?: string;
  mode?: string;
  risk?: string;
  now?: string | (() => string);
  idHint?: string;
}

export function startGoal(root: string, input: StartGoalInput): GoalRecord {
  return withGoalLock(root, () => {
    const open = scanActiveGoal(root);
    if (open) {
      throw new Error(`open goal already exists: ${open.goalId} (${open.state})`);
    }

    assertUniqueCheckNames(input.checks ?? []);

    const now = currentIso(input.now);
    const goalId = nextGoalId(root, input.idHint ?? input.objective, now);
    const record = GoalSchema.parse({
      goalId,
      objective: input.objective,
      condition: input.condition,
      checks: (input.checks ?? []).map((check) => ({
        name: check.name,
        command: check.command,
        status: "pending" as const,
      })),
      state: "active",
      turns: 0,
      maxTurns: input.maxTurns ?? 12,
      maxCost: input.maxCost,
      stallCount: 0,
      maxConsecutiveStalls: input.maxConsecutiveStalls ?? 3,
      requireCompletenessCheck: input.requireCompletenessCheck,
      workflow: input.workflow,
      mode: input.mode,
      risk: input.risk,
      createdAt: now,
      updatedAt: now,
      history: [],
    });
    writeGoal(root, record, { exclusive: true });
    writeActiveGoalIndex(root, record.goalId);
    return record;
  });
}

export function readActiveGoal(root: string): GoalRecord | null {
  const indexed = readIndexedActiveGoal(root);
  if (indexed) return indexed;
  const scanned = scanActiveGoal(root);
  refreshActiveGoalIndex(root, scanned);
  return scanned;
}

function scanActiveGoal(root: string): GoalRecord | null {
  const dir = goalDir(root);
  if (!existsSync(dir)) return null;
  const records = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readGoal(root, name.slice(0, -".json".length)))
    .filter((record): record is GoalRecord => record !== null)
    .filter((record) => !isTerminal(record.state))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return records[0] ?? null;
}

export function readLatestGoal(root: string): GoalRecord | null {
  const dir = goalDir(root);
  if (!existsSync(dir)) return null;
  const records = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readGoal(root, name.slice(0, -".json".length)))
    .filter((record): record is GoalRecord => record !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return records[0] ?? null;
}

export function readGoal(root: string, goalId: string): GoalRecord | null {
  const dir = goalDir(root);
  if (!existsSync(dir)) return null;
  const filePath = goalPath(root, goalId);
  if (!existsSync(filePath)) return null;

  const realGoalDir = realpathSync(dir);
  const realPath = realpathSync(filePath);
  if (!isInside(realGoalDir, realPath)) {
    throw new Error(`goalId must resolve under ${GOAL_DIR}; got ${goalId}`);
  }

  try {
    return parseGoalFile(goalId, readFileSync(realPath, "utf8"));
  } catch (error) {
    return classifyGoalReadError(error);
  }
}

export function classifyGoalReadError(error: unknown): null {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
  throw error;
}

function parseGoalFile(goalId: string, raw: string): GoalRecord | null {
  try {
    const parsed = GoalSchema.parse(JSON.parse(raw));
    if (parsed.goalId !== goalId) {
      return null;
    }
    return GoalSchema.parse({
      ...parsed,
      spentUsd: parsed.spentUsd ?? 0,
    });
  } catch {
    return null;
  }
}

export function clearGoal(root: string, goalId?: string): GoalRecord | null {
  return withGoalLock(root, () => {
    const existing = goalId ? readGoal(root, goalId) : readActiveGoal(root);
    if (!existing) return null;
    if (isTerminal(existing.state)) return existing;
    const updated = GoalSchema.parse({
      ...existing,
      state: "cancelled",
      updatedAt: new Date().toISOString(),
    });
    writeGoal(root, updated);
    clearActiveGoalIndex(root, updated.goalId);
    return updated;
  });
}

export function stepGoal(
  root: string,
  input: {
    goalId?: string;
    signals?: StepGoalSignals;
  },
): { record: GoalRecord; nextAction: NextAction } {
  return withGoalLock(root, () => {
    const existing = input.goalId ? readGoal(root, input.goalId) : readActiveGoal(root);
    if (!existing) {
      throw new Error(input.goalId ? `goal not found: ${input.goalId}` : "no active goal");
    }
    if (isTerminal(existing.state)) {
      throw new Error(`cannot step goal ${existing.goalId}: state is ${existing.state} (terminal)`);
    }

    const signals = input.signals ?? {};
    let base = existing;
    const budgetExtension = signals.budgetExtension;
    const reactivatedWithBudgetExtension = base.state === "blocked" && budgetExtension !== undefined;
    if (reactivatedWithBudgetExtension) {
      base = GoalSchema.parse({
        ...base,
        state: "active",
        stallCount: 0,
        maxTurns: budgetExtension.maxTurns !== undefined
          ? Math.max(base.maxTurns, budgetExtension.maxTurns)
          : base.maxTurns,
        maxCost: maxOptional(base.maxCost, budgetExtension.maxCost),
        updatedAt: new Date().toISOString(),
      });
    }

    const turns = base.turns + 1;
    const spentUsd = (base.spentUsd ?? 0) + (signals.spentUsd ?? 0);
    const beforeChecks = base.checks;
    const checks = applyCheckResults(base.checks, signals.checkResults ?? []);
    const beforeByName = new Map(beforeChecks.map((check) => [check.name, check.status]));
    const madeProgress =
      checks.some((check) => check.status === "pass" && beforeByName.get(check.name) !== "pass") ||
      (signals.conditionMet === true && base.conditionMet !== true) ||
      (signals.completenessVerified === true && base.completenessVerified !== true);
    const newStallCount =
      signals.budgetExtension !== undefined || madeProgress
        ? 0
        : (base.stallCount ?? 0) + 1;
    let record = GoalSchema.parse({
      ...base,
      checks,
      turns,
      spentUsd,
      stallCount: newStallCount,
      conditionMet: signals.conditionMet !== undefined ? signals.conditionMet : base.conditionMet,
      completenessVerified: signals.completenessVerified !== undefined
        ? signals.completenessVerified
        : base.completenessVerified,
      updatedAt: new Date().toISOString(),
    });

    const overBudget = turns > record.maxTurns || isProjectedOverBudget(record);
    const normalAction = decideNextAction(record, beforeChecks, signals);
    const stallLimit = record.maxConsecutiveStalls ?? 3;
    let nextAction: NextAction;
    let verdict: GoalState;
    if (normalAction.tool === "none") {
      nextAction = normalAction;
      verdict = "achieved";
    } else if (overBudget) {
      const failed = record.checks.some((check) => check.status === "fail");
      verdict = failed ? "failed" : "blocked";
      nextAction = {
        tool: "composer_goal_status",
        reason: failed
          ? "condition not met within budget - goal failed"
          : "budget/turn cap reached - extend budget (budgetExtension) or clear",
      };
    } else if (newStallCount >= stallLimit) {
      nextAction = {
        tool: "composer_goal_status",
        reason: `convergence stall: ${newStallCount} consecutive steps without progress - change approach, escalate to oracle (composer_oracle_plan), extend budget, or clear the goal`,
      };
      verdict = "blocked";
    } else {
      nextAction = normalAction;
      verdict = "active";
    }
    record = recordWithAction(record, verdict, nextAction);
    writeGoal(root, record);
    updateActiveGoalIndexForRecord(root, record);
    return { record, nextAction };
  });
}

function applyCheckResults(
  checks: GoalCheck[],
  checkResults: Array<{ name: string; passed: boolean }>,
): GoalCheck[] {
  if (checkResults.length === 0) return checks;
  const checkNames = new Set(checks.map((check) => check.name));
  const resultNames = new Set<string>();
  for (const result of checkResults) {
    if (resultNames.has(result.name)) {
      throw new Error(`duplicate check name in checkResults: ${result.name}`);
    }
    resultNames.add(result.name);
    if (!checkNames.has(result.name)) {
      throw new Error(`unknown check name in checkResults: ${result.name}`);
    }
  }
  const byName = new Map(checkResults.map((result) => [result.name, result.passed]));
  return checks.map((check) => {
    const passed = byName.get(check.name);
    if (passed === undefined) return check;
    return {
      ...check,
      status: passed ? "pass" as const : "fail" as const,
      lastRunAt: new Date().toISOString(),
    };
  });
}

function recordWithAction(record: GoalRecord, state: GoalState, nextAction: NextAction): GoalRecord {
  return GoalSchema.parse({
    ...record,
    state,
    lastAction: nextAction.tool,
    lastVerdict: state,
    lastReason: nextAction.reason,
    updatedAt: new Date().toISOString(),
    history: [
      ...(record.history ?? []),
      {
        turn: record.turns,
        action: nextAction.tool,
        verdict: state,
        reason: nextAction.reason,
      },
    ].slice(-100),
  });
}

function decideNextAction(
  record: GoalRecord,
  beforeChecks: GoalCheck[],
  signals: StepGoalSignals,
): NextAction {
  const persisted = record.conditionMet;
  const callerVetoes = persisted === false;
  const allPass = record.checks.length > 0
    && record.checks.every((check) => check.status === "pass");
  const achieved = !callerVetoes && (
    allPass || (record.checks.length === 0 && persisted === true)
  );

  if (achieved) {
    if (record.requireCompletenessCheck === true && record.completenessVerified !== true) {
      return {
        tool: "composer_review",
        reason: "condition met — run an independent completeness check (composer_review), then call composer_goal_step with completenessVerified=true to close the goal",
      };
    }
    return {
      tool: "none",
      reason: "condition met",
    };
  }

  if (callerVetoes && allPass) {
    return {
      tool: "composer_code_cli",
      reason: "condition not yet met - keep working",
    };
  }

  const pendingChecks = record.checks.filter((check) => check.status === "pending");
  if (pendingChecks.length > 0) {
    const pendingNames = pendingChecks.map((check) => check.name);
    return {
      tool: "composer_goal_status",
      manualChecks: pendingNames,
      reason: "composer_goal_status shows the declared check commands; run them yourself, then call composer_goal_step with --check-result name=pass|fail for each",
    };
  }

  const noCheckProgress = record.checks.length > 0
    && !record.checks.some((check) => check.status === "pass")
    && !record.checks.some((check, index) => beforeChecks[index]?.status !== check.status);
  if (signals.stuck === true || (record.turns >= Math.ceil(record.maxTurns / 2) && noCheckProgress)) {
    return {
      tool: "composer_oracle_plan",
      reason: "stuck - strategic replan",
    };
  }

  if ((signals.failedAttempts ?? 0) >= 2) {
    return {
      tool: "composer_codex_lifecycle_run",
      reason: "2+ failed attempts - tactical rescue",
    };
  }

  if (record.checks.some((check) => check.status === "fail")) {
    return {
      tool: "composer_code_cli",
      reason: "checks failing - fix",
    };
  }

  return {
    tool: "composer_code_cli",
    reason: "begin work toward condition",
  };
}

function assertUniqueCheckNames(checks: Array<{ name: string }>): void {
  const seen = new Set<string>();
  for (const check of checks) {
    if (seen.has(check.name)) {
      throw new Error(`duplicate check name: ${check.name}`);
    }
    seen.add(check.name);
  }
}

function hasUniqueCheckNames(checks: Array<{ name: string }>): boolean {
  try {
    assertUniqueCheckNames(checks);
    return true;
  } catch {
    return false;
  }
}

function maxOptional(current: number | undefined, candidate: number | undefined): number | undefined {
  if (candidate === undefined) return current;
  if (current === undefined) return candidate;
  return Math.max(current, candidate);
}

function writeGoal(root: string, record: GoalRecord, options: { exclusive?: boolean } = {}): string {
  const validated = GoalSchema.parse(record);
  const dir = goalDir(root);
  ensureGoalDirectory(dir);
  const filePath = goalPath(root, validated.goalId);
  const tmpPath = resolve(dir, `.${validated.goalId}.${process.pid}.${randomUUID()}.tmp`);
  const payload = `${JSON.stringify(validated, null, 2)}\n`;
  writeFileSync(tmpPath, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    if (options.exclusive) {
      linkSync(tmpPath, filePath);
      rmSync(tmpPath, { force: true });
    } else {
      renameSync(tmpPath, filePath);
    }
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
  return filePath;
}

function activeGoalIndexPath(root: string): string {
  return resolve(goalDir(root), ACTIVE_GOAL_INDEX);
}

function readIndexedActiveGoal(root: string): GoalRecord | null {
  const dir = goalDir(root);
  if (!existsSync(dir)) return null;
  const indexPath = activeGoalIndexPath(root);
  try {
    if (!existsSync(indexPath)) return null;
    if (lstatSync(indexPath).isSymbolicLink()) return null;
    const goalId = readFileSync(indexPath, "utf8").trim();
    if (goalId.length === 0) return null;
    const record = readGoal(root, goalId);
    if (!record) return null;
    if (record.goalId !== goalId || isTerminal(record.state)) return null;
    return record;
  } catch {
    return null;
  }
}

function refreshActiveGoalIndex(root: string, record: GoalRecord | null): void {
  try {
    if (record && !isTerminal(record.state)) {
      writeActiveGoalIndex(root, record.goalId);
    } else {
      rmSync(activeGoalIndexPath(root), { force: true });
    }
  } catch {
    // The index is only a fast-path hint.
  }
}

function updateActiveGoalIndexForRecord(root: string, record: GoalRecord): void {
  if (isTerminal(record.state)) {
    clearActiveGoalIndex(root, record.goalId);
  } else {
    writeActiveGoalIndex(root, record.goalId);
  }
}

function writeActiveGoalIndex(root: string, goalId: string): void {
  const dir = goalDir(root);
  ensureGoalDirectory(dir);
  const indexPath = activeGoalIndexPath(root);
  const tmpPath = resolve(dir, `.${ACTIVE_GOAL_INDEX}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmpPath, `${goalId}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(tmpPath, indexPath);
    chmodSync(indexPath, 0o600);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
}

function clearActiveGoalIndex(root: string, goalId: string): void {
  const indexPath = activeGoalIndexPath(root);
  try {
    if (!existsSync(indexPath)) return;
    if (lstatSync(indexPath).isSymbolicLink()) return;
    const indexedGoalId = readFileSync(indexPath, "utf8").trim();
    if (indexedGoalId === goalId) {
      rmSync(indexPath, { force: true });
    }
  } catch {
    // The index is only a fast-path hint.
  }
}

function withGoalLock<T>(root: string, fn: () => T): T {
  const lock = acquireGoalLock(root);
  if (!lock.acquired) {
    throw new Error(`goal store is locked by pid ${lock.holder.pid}`);
  }
  try {
    return fn();
  } finally {
    lock.release();
  }
}

type GoalLockHolder = {
  pid: number;
  token: string;
  startedAt: string;
};

type GoalLockResult =
  | { acquired: true; release: () => void }
  | { acquired: false; holder: GoalLockHolder };

function acquireGoalLock(root: string): GoalLockResult {
  const dir = goalDir(root);
  ensureGoalDirectory(dir);
  const lockPath = resolve(dir, ".lock");
  const token = randomUUID();
  const holder = {
    pid: process.pid,
    token,
    startedAt: new Date().toISOString(),
  };

  try {
    return writeGoalLock(lockPath, holder, token);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const existing = readGoalLockHolder(lockPath);
  if (!existing || !isProcessAlive(existing.pid) || isStaleLock(existing.startedAt)) {
    rmSync(lockPath, { force: true });
    try {
      return writeGoalLock(lockPath, holder, token);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const racer = readGoalLockHolder(lockPath);
        if (racer) return { acquired: false, holder: racer };
      }
      throw error;
    }
  }

  return { acquired: false, holder: existing };
}

function writeGoalLock(lockPath: string, holder: GoalLockHolder, token: string): GoalLockResult {
  writeFileSync(lockPath, JSON.stringify(holder), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return {
    acquired: true,
    release: () => {
      try {
        const current = readGoalLockHolder(lockPath);
        if (current?.pid === process.pid && current.token === token) {
          rmSync(lockPath, { force: true });
        }
      } catch {
        // Best-effort cleanup only.
      }
    },
  };
}

function readGoalLockHolder(lockPath: string): GoalLockHolder | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as GoalLockHolder;
    if (
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid) ||
      typeof parsed.token !== "string" ||
      typeof parsed.startedAt !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function ensureGoalDirectory(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink()) {
    throw new Error(`Goal directory must not be a symlink: ${GOAL_DIR}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Goal path must be a directory: ${GOAL_DIR}`);
  }
}

function goalDir(root: string): string {
  return resolve(root, GOAL_DIR);
}

function goalPath(root: string, goalId: string): string {
  const dir = goalDir(root);
  const filePath = resolve(dir, `${goalId}.json`);
  if (!isInside(dir, filePath)) {
    throw new Error(`goalId must resolve under ${GOAL_DIR}; got ${goalId}`);
  }
  return filePath;
}

function nextGoalId(root: string, hint: string, now: string): string {
  const base = `${slugify(hint)}-${slugify(now)}`.slice(0, 96);
  let candidate = base || `goal-${slugify(now)}`;
  let counter = 2;
  while (existsSync(goalPath(root, candidate))) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  return candidate;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function currentIso(now?: string | (() => string)): string {
  if (typeof now === "function") return now();
  if (typeof now === "string") return now;
  return new Date().toISOString();
}

function isProjectedOverBudget(record: GoalRecord): boolean {
  return record.maxCost !== undefined && (record.spentUsd ?? 0) >= record.maxCost;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isStaleLock(startedAt: string): boolean {
  const t = Date.parse(startedAt);
  if (Number.isNaN(t)) return true;
  return Date.now() - t > GOAL_LOCK_TTL_MS;
}

function isInside(parent: string, child: string): boolean {
  const normalizedParent = parent.endsWith("/") ? parent : `${parent}/`;
  const normalizedChild = child.endsWith("/") ? child : child;
  return normalizedChild === parent || normalizedChild.startsWith(normalizedParent);
}
