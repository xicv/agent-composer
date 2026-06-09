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
    // Mechanical PreToolUse pre-commit gate; off by default.
    preCommitHook: CodexPreCommitHookSchema.optional(),
  })
  .strict();
export type CodexReview = z.infer<typeof CodexReviewSchema>;

export const ComposerConfigSchema = z
  .object({
    roles: z
      .object({
        researcher: RoleConfigSchema,
        coder: RoleConfigSchema,
        reviewer: RoleConfigSchema,
        reviewerClaude: RoleConfigSchema.optional(),
        coderCli: RoleConfigSchema.optional(),
      })
      .strict(),
    spendAuthorization: SpendAuthorizationSchema.optional(),
    codexReview: CodexReviewSchema.optional(),
  })
  .strict();
export type ComposerConfig = z.infer<typeof ComposerConfigSchema>;
