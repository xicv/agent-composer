// Wave 1 F1.4 — ProviderFactory / role → IProvider resolver.
//
// Day 2 (2026-05-23): 'anthropic' and 'cli' now wire to real adapters
// (F1.1 + F1.2). 'openai_compatible' still throws — YAGNI until a
// concrete need surfaces.

import type { IProvider } from "./providers/IProvider.js";
import { MockProvider } from "./providers/MockProvider.js";
import { AnthropicCompatibleProvider } from "./providers/AnthropicCompatibleProvider.js";
import { CLIProvider } from "./providers/CLIProvider.js";
import type {
  ComposerConfig,
  RoleConfig,
  RoleName,
} from "./config/schema.js";

export class ProviderNotImplementedError extends Error {
  constructor(providerId: string) {
    super(
      `Provider '${providerId}' is not wired. Composer ships 'mock', 'anthropic', and 'cli' adapters; 'openai_compatible' is YAGNI until needed.`,
    );
    this.name = "ProviderNotImplementedError";
  }
}

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

  constructor(private readonly config: ComposerConfig) {}

  getProviderForRole(role: RoleName): IProvider {
    const cached = this.cache.get(role);
    if (cached) return cached;
    const created = this.buildProvider(this.config.roles[role]);
    this.cache.set(role, created);
    return created;
  }

  private buildProvider(roleConfig: RoleConfig): IProvider {
    switch (roleConfig.provider) {
      case "mock":
        return new MockProvider({ modelLabel: roleConfig.model });

      case "anthropic": {
        if (!roleConfig.baseUrl) throw new ProviderConfigError("anthropic", "baseUrl");
        if (!roleConfig.apiKeyEnv) throw new ProviderConfigError("anthropic", "apiKeyEnv");
        if (!roleConfig.model) throw new ProviderConfigError("anthropic", "model");
        const apiKey = process.env[roleConfig.apiKeyEnv];
        if (!apiKey) {
          throw new ProviderConfigError(
            "anthropic",
            `env var ${roleConfig.apiKeyEnv} (set it via .env.json or shell)`,
          );
        }
        return new AnthropicCompatibleProvider({
          baseUrl: roleConfig.baseUrl,
          apiKey,
          model: roleConfig.model,
        });
      }

      case "cli": {
        if (!roleConfig.cli || roleConfig.cli.length === 0) {
          throw new ProviderConfigError("cli", "cli (argv array)");
        }
        return new CLIProvider({
          cli: roleConfig.cli,
          model: roleConfig.model,
        });
      }

      case "openai_compatible":
        throw new ProviderNotImplementedError(roleConfig.provider);
    }
  }
}
