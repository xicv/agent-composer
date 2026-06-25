// Wave 2 F2.2 — eval task + result schemas.
// Lives under tests/ because the runner is a QA tool, not part of the
// MCP server runtime. Wave 3 autoresearch imports from here via tsx.

import { z } from "zod";

export const TaskClassSchema = z.enum([
  "pure-function-add",
  "bug-fix-from-test",
  "cross-file-refactor",
  "research-first-feature",
  "review-catch",
  "multi-step-plan",
  "refuse-out-of-scope",
]);
export type TaskClass = z.infer<typeof TaskClassSchema>;

export const SubagentRoleSchema = z.enum(["researcher", "coder", "reviewer"]);
export type SubagentRole = z.infer<typeof SubagentRoleSchema>;

export const EvalTaskExpectSchema = z
  .object({
    /** Substrings the worker output must contain to count as success. */
    outputContains: z.array(z.string().min(1)).optional(),
    /** Subagent dispatch sequence the orchestrator should follow. */
    dispatchSequence: z.array(SubagentRoleSchema).optional(),
    /**
     * Whether dispatch is mandatory for routing credit. Added 2026-05-24
     * after first dogfood audit: thin tasks (small reviews, refusals)
     * are correctly handled inline — forcing dispatch costs more than
     * it saves. When false: no-dispatch + success counts as correct
     * routing; dispatched + matching sequence also counts. Default true
     * preserves Wave-2 strict scoring for heavy task classes.
     */
    dispatchRequired: z.boolean().optional(),
    /** Max acceptable orchestrator-side token count (0 / omitted = no cap). */
    maxMainTokens: z.number().int().nonnegative().optional(),
  })
  .strict();
export type EvalTaskExpect = z.infer<typeof EvalTaskExpectSchema>;

export const EvalTaskSchema = z
  .object({
    id: z.string().min(1),
    class: TaskClassSchema,
    prompt: z.string().min(1),
    expect: EvalTaskExpectSchema,
  })
  .strict();
export type EvalTask = z.infer<typeof EvalTaskSchema>;

export const EvalResultSchema = z
  .object({
    taskId: z.string(),
    success: z.boolean(),
    mainSessionTokens: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
    wallSeconds: z.number().optional(),
    workerCalls: z.number().int().nonnegative(),
    workerTextSample: z.string(),
  })
  .strict();
export type EvalResult = z.infer<typeof EvalResultSchema>;
