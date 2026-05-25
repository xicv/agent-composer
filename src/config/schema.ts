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
  })
  .strict();
export type RoleConfig = z.infer<typeof RoleConfigSchema>;

export const RoleNameSchema = z.enum(["researcher", "coder", "reviewer"]);
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

export const ComposerConfigSchema = z
  .object({
    roles: z
      .object({
        researcher: RoleConfigSchema,
        coder: RoleConfigSchema,
        reviewer: RoleConfigSchema,
      })
      .strict(),
    spendAuthorization: SpendAuthorizationSchema.optional(),
  })
  .strict();
export type ComposerConfig = z.infer<typeof ComposerConfigSchema>;
