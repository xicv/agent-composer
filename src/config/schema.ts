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

export const RoleConfigSchema = z
  .object({
    provider: ProviderIdSchema,
    apiKeyEnv: z.string().min(1).optional(),
    baseUrl: z.url().optional(),
    model: z.string().min(1).optional(),
    cli: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();
export type RoleConfig = z.infer<typeof RoleConfigSchema>;

export const RoleNameSchema = z.enum(["researcher", "coder", "reviewer"]);
export type RoleName = z.infer<typeof RoleNameSchema>;

export const ComposerConfigSchema = z
  .object({
    roles: z
      .object({
        researcher: RoleConfigSchema,
        coder: RoleConfigSchema,
        reviewer: RoleConfigSchema,
      })
      .strict(),
  })
  .strict();
export type ComposerConfig = z.infer<typeof ComposerConfigSchema>;
