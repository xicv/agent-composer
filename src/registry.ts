// Wave 1 F1.4 — ProviderFactory / role → IProvider resolver.
//
// Day 2 (2026-05-23): 'anthropic' and 'cli' now wire to real adapters
// (F1.1 + F1.2).

import type { IProvider } from "./providers/IProvider.js";
import { MockProvider } from "./providers/MockProvider.js";
import { AnthropicCompatibleProvider } from "./providers/AnthropicCompatibleProvider.js";
import { CLIProvider } from "./providers/CLIProvider.js";
import { SpendGuardProvider, SpendLedger, isPricedProvider } from "./providers/SpendGuardProvider.js";
import type {
  ComposerConfig,
  RoleConfig,
  RoleName,
} from "./config/schema.js";

/**
 * Wave 3 Step 4 — fallback when neither process.env.ANTHROPIC_MODEL
 * nor composer.config.json role.model are provided. Tracks the current
 * GLM family release (z.ai Anthropic-compat endpoint).
 */
export const DEFAULT_ANTHROPIC_MODEL = "glm-5.2";

export class ProviderConfigError extends Error {
  constructor(providerId: string, field: string) {
    super(
      `Provider '${providerId}' requires '${field}' in composer.config.json (or its env var).`,
    );
    this.name = "ProviderConfigError";
  }
}

export class ProviderRegistry {
  private readonly cache = new Map<RoleName, IProvider>();
  private readonly spendLedger = new SpendLedger();

  constructor(private config: ComposerConfig) {}

  setConfig(config: ComposerConfig): void {
    if (config === this.config) return;
    this.config = config;
    this.cache.clear();
  }

  getProviderForRole(role: RoleName): IProvider {
    const cached = this.cache.get(role);
    if (cached) return cached;
    const rc = this.config.roles[role];
    if (!rc) {
      throw new ProviderConfigError(role, "role not configured in composer.config.json roles");
    }
    const created = this.maybeGuard(this.buildProvider(rc), rc.maxTokens);
    this.cache.set(role, created);
    return created;
  }

  private maybeGuard(provider: IProvider, defaultMaxTokens?: number): IProvider {
    const auth = this.config.spendAuthorization;
    if (!auth || !isPricedProvider(provider.id)) return provider;
    return new SpendGuardProvider(provider, auth, this.spendLedger, defaultMaxTokens);
  }

  private buildProvider(roleConfig: RoleConfig): IProvider {
    switch (roleConfig.provider) {
      case "mock":
        return new MockProvider({ modelLabel: roleConfig.model });

      case "anthropic": {
        if (!roleConfig.baseUrl) throw new ProviderConfigError("anthropic", "baseUrl");
        if (!roleConfig.apiKeyEnv) throw new ProviderConfigError("anthropic", "apiKeyEnv");
        const apiKey = process.env[roleConfig.apiKeyEnv];
        if (!apiKey) {
          throw new ProviderConfigError(
            "anthropic",
            `env var ${roleConfig.apiKeyEnv} (set it via .env.json or shell)`,
          );
        }
        // Step 4 precedence: env > role.model > DEFAULT_ANTHROPIC_MODEL.
        const envModel = process.env["ANTHROPIC_MODEL"];
        const model =
          (typeof envModel === "string" && envModel.length > 0 ? envModel : undefined) ??
          roleConfig.model ??
          DEFAULT_ANTHROPIC_MODEL;
        return new AnthropicCompatibleProvider({
          baseUrl: roleConfig.baseUrl,
          apiKey,
          model,
          defaultMaxTokens: roleConfig.maxTokens,
          thinking: roleConfig.thinking,
        });
      }

      case "cli": {
        if (!roleConfig.cli || roleConfig.cli.length === 0) {
          throw new ProviderConfigError("cli", "cli (argv array)");
        }
        return new CLIProvider({
          cli: roleConfig.cli,
          model: roleConfig.model,
          timeoutMs: roleConfig.timeoutMs,
          totalWallClockMs: roleConfig.totalWallClockMs,
          maxBuffer: roleConfig.maxBuffer,
          retries: roleConfig.retries,
          maxResultChars: roleConfig.maxResultChars,
        });
      }
    }
  }
}
