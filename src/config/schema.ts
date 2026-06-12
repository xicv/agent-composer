// Wave 1 F1.4 — zod mirror of composer.config.schema.json (C0.2).
// If the JSON schema changes, this MUST mirror it; tests assert symmetry.

import { z } from "zod";

export const ProviderIdSchema = z.enum([
  "anthropic",
  "openai_compatible",
  "cli",
  "mock",
]);
export type ProviderIdParsed = z.infer<typeof ProviderIdSchema>;

export const ThinkingConfigSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("enabled"),
      budgetTokens: z.number().int().min(1024),
    })
    .strict(),
  z
    .object({
      type: z.literal("disabled"),
    })
    .strict(),
]);
export type ThinkingConfig = z.infer<typeof ThinkingConfigSchema>;

export const RoleConfigSchema = z
  .object({
    provider: ProviderIdSchema,
    apiKeyEnv: z.string().min(1).optional(),
    baseUrl: z.url().optional(),
    model: z.string().min(1).optional(),
    cli: z.array(z.string().min(1)).min(1).optional(),
    maxTokens: z.number().int().min(1).optional(),
    thinking: ThinkingConfigSchema.optional(),
    timeoutMs: z.number().int().min(1).optional(),
    maxBuffer: z.number().int().min(1).optional(),
    retries: z.number().int().min(0).optional(),
    maxResultChars: z.number().int().min(0).optional(),
  })
  .strict();
export type RoleConfig = z.infer<typeof RoleConfigSchema>;

export const RoleNameSchema = z.enum([
  "researcher",
  "coder",
  "reviewer",
  "reviewerClaude",
  "coderCli",
  "oraclePlanner",
]);
export type RoleName = z.infer<typeof RoleNameSchema>;

export const SpendAuthorizationModeSchema = z.enum([
  "interactive",
  "auto",
  "deny",
]);
export type SpendAuthorizationMode = z.infer<typeof SpendAuthorizationModeSchema>;

export const SpendAuthorizationSchema = z
  .object({
    mode: SpendAuthorizationModeSchema,
    maxUsdPerSession: z.number().nonnegative().optional(),
    maxUsdPerCall: z.number().nonnegative().optional(),
  })
  .strict();
export type SpendAuthorization = z.infer<typeof SpendAuthorizationSchema>;

export const CodexReviewCommandSchema = z.enum(["review", "adversarial-review"]);
export const CodexReviewModeSchema = z.enum(["ask", "auto"]);
export const CodexReviewExecutionSchema = z.enum(["foreground", "background"]);
export const CodexReviewScopeSchema = z.enum(["auto", "working-tree", "branch"]);
export const CodexSeveritySchema = z.enum(["critical", "high", "medium", "low"]);

export const CodexPreCommitHookSchema = z
  .object({
    enabled: z.boolean(),
    blockOnSeverity: CodexSeveritySchema.optional(),
    timeoutMs: z.number().int().min(1).optional(),
    failClosed: z.boolean().optional(),
  })
  .strict();
export type CodexPreCommitHook = z.infer<typeof CodexPreCommitHookSchema>;

export const CodexWarmCacheSchema = z
  .object({
    enabled: z.boolean().default(false),
    maxAgeMinutes: z.number().int().min(1).default(30),
    timeoutMs: z.number().int().min(1).default(300000),
  })
  .strict();
export type CodexWarmCache = z.infer<typeof CodexWarmCacheSchema>;

export const CodexReviewNotifySchema = z
  .object({
    desktop: z.boolean().default(false),
  })
  .strict();
export type CodexReviewNotify = z.infer<typeof CodexReviewNotifySchema>;

export const CodexReviewTriggersSchema = z
  .object({
    preCommit: z.boolean().optional(),
    postPlan: z.boolean().optional(),
  })
  .strict();

// Gates an optional cross-LLM (Codex) review at composer's own trigger points; off by default.
export const CodexReviewSchema = z
  .object({
    enabled: z.boolean(),
    triggers: CodexReviewTriggersSchema.optional(),
    preCommitCommand: CodexReviewCommandSchema.optional(),
    postPlanCommand: CodexReviewCommandSchema.optional(),
    mode: CodexReviewModeSchema.optional(),
    execution: CodexReviewExecutionSchema.optional(),
    scope: CodexReviewScopeSchema.optional(),
    base: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    // Mechanical PreToolUse pre-commit gate; off by default.
    preCommitHook: CodexPreCommitHookSchema.optional(),
    warmCache: CodexWarmCacheSchema.optional(),
    notify: CodexReviewNotifySchema.optional(),
  })
  .strict();
export type CodexReview = z.infer<typeof CodexReviewSchema>;

export const CodexRescueSchema = z
  .object({
    enabled: z.boolean().default(true),
    mode: z.enum(["ask", "auto"]).default("ask"),
    model: z.string().min(1).default("gpt-5.4-mini"),
  })
  .strict();
export type CodexRescue = z.infer<typeof CodexRescueSchema>;

export const CodexLifecycleEventSchema = z.enum([
  "postResearch",
  "postPlan",
  "postCodeApply",
  "postTestFailure",
  "afterFailedAttempts",
  "preCommit",
  "stopWarm",
]);
export type CodexLifecycleEvent = z.infer<typeof CodexLifecycleEventSchema>;

export const CodexLifecycleModeSchema = z.enum(["ask", "auto"]);
export type CodexLifecycleMode = z.infer<typeof CodexLifecycleModeSchema>;

export const CodexLifecycleExecutionSchema = z.enum(["foreground", "background"]);
export type CodexLifecycleExecution = z.infer<typeof CodexLifecycleExecutionSchema>;

export const DEFAULT_CODEX_LIFECYCLE_TRIGGERS = {
  postResearch: false,
  postPlan: true,
  postCodeApply: true,
  postTestFailure: true,
  afterFailedAttempts: true,
  preCommit: false,
  stopWarm: false,
};

export const CodexLifecycleTriggersSchema = z
  .object({
    postResearch: z.boolean().default(false),
    postPlan: z.boolean().default(true),
    postCodeApply: z.boolean().default(true),
    postTestFailure: z.boolean().default(true),
    afterFailedAttempts: z.boolean().default(true),
    preCommit: z.boolean().default(false),
    stopWarm: z.boolean().default(false),
  })
  .strict();
export type CodexLifecycleTriggers = z.infer<typeof CodexLifecycleTriggersSchema>;

export const DEFAULT_CODEX_LIFECYCLE_THRESHOLDS = {
  minScore: 60,
  minExpectedOutputTokens: 500,
  minChangedFiles: 2,
  minDiffLines: 80,
  failedAttempts: 2,
};

export const CodexLifecycleThresholdsSchema = z
  .object({
    minScore: z.number().min(0).max(100).default(60),
    minExpectedOutputTokens: z.number().int().min(1).default(500),
    minChangedFiles: z.number().int().min(1).default(2),
    minDiffLines: z.number().int().min(1).default(80),
    failedAttempts: z.number().int().min(1).default(2),
  })
  .strict();
export type CodexLifecycleThresholds = z.infer<typeof CodexLifecycleThresholdsSchema>;

export const DEFAULT_CODEX_LIFECYCLE_FALLBACK_ORDER = [
  "reviewerClaude",
  "reviewer",
  "coder",
] as const;

const CodexLifecycleFallbackRoleSchema = z.enum([
  "researcher",
  "coder",
  "reviewer",
  "reviewerClaude",
  "coderCli",
]);

export const CodexLifecycleFallbackSchema = z
  .object({
    enabled: z.boolean().default(false),
    order: z
      .array(CodexLifecycleFallbackRoleSchema)
      .min(1)
      .default(() => [...DEFAULT_CODEX_LIFECYCLE_FALLBACK_ORDER]),
  })
  .strict();
export type CodexLifecycleFallback = z.infer<typeof CodexLifecycleFallbackSchema>;

// Decides when Codex should participate beyond the mechanical review gate.
// It does not invoke Codex; it is a deterministic policy surface for Coco.
export const CodexLifecycleSchema = z
  .object({
    enabled: z.boolean().default(false),
    mode: CodexLifecycleModeSchema.default("ask"),
    execution: CodexLifecycleExecutionSchema.default("background"),
    model: z.string().min(1).default("gpt-5.4-mini"),
    triggers: CodexLifecycleTriggersSchema.default(() => ({
      ...DEFAULT_CODEX_LIFECYCLE_TRIGGERS,
    })),
    thresholds: CodexLifecycleThresholdsSchema.default(() => ({
      ...DEFAULT_CODEX_LIFECYCLE_THRESHOLDS,
    })),
    fallback: CodexLifecycleFallbackSchema.default(() => ({
      enabled: false,
      order: [...DEFAULT_CODEX_LIFECYCLE_FALLBACK_ORDER],
    })),
  })
  .strict();
export type CodexLifecycle = z.infer<typeof CodexLifecycleSchema>;
export type CodexLifecycleInput = z.input<typeof CodexLifecycleSchema>;

export const ComposerConfigSchema = z
  .object({
    roles: z
      .object({
        researcher: RoleConfigSchema,
        coder: RoleConfigSchema,
        reviewer: RoleConfigSchema,
        reviewerClaude: RoleConfigSchema.optional(),
        coderCli: RoleConfigSchema.optional(),
        oraclePlanner: RoleConfigSchema.optional(),
      })
      .strict(),
    spendAuthorization: SpendAuthorizationSchema.optional(),
    codexReview: CodexReviewSchema.optional(),
    codexRescue: CodexRescueSchema.optional(),
    codexLifecycle: CodexLifecycleSchema.optional(),
  })
  .strict();
export type ComposerConfig = z.infer<typeof ComposerConfigSchema>;
