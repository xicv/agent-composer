import type { ComposerConfig, RoleConfig, RoleName } from "./schema.js";
import { RoleNameSchema } from "./schema.js";
import { modePatch } from "./modes.js";

export type ResolvedProfileSource = "env" | "config" | "default";

export interface ResolvedEffectiveConfig {
  config: ComposerConfig;
  resolvedProfile: string | null;
  resolvedProfileSource: ResolvedProfileSource;
  effectiveFallbacks: Partial<Record<RoleName, RoleName[]>>;
  warnings: string[];
}

const ROLE_NAMES = RoleNameSchema.options;
const CODER_ROLES = ["coder", "coderCli"] as const satisfies readonly RoleName[];
const REVIEWER_ROLES = ["reviewer", "reviewerClaude"] as const satisfies readonly RoleName[];
export type RoleIntent = "READ" | "MUTATE";

const ROLE_INTENTS: Record<RoleName, RoleIntent> = {
  researcher: "READ",
  reviewer: "READ",
  reviewerClaude: "READ",
  oraclePlanner: "READ",
  coder: "MUTATE",
  coderCli: "MUTATE",
};

export function roleIntent(role: RoleName): RoleIntent {
  return ROLE_INTENTS[role];
}

export function resolveEffectiveConfig(
  config: ComposerConfig,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedEffectiveConfig {
  const envProfile = readNonEmpty(env["COMPOSER_PROFILE"]);
  const configProfile = config.activeProfile;
  const selected = envProfile ?? configProfile ?? null;
  const source: ResolvedProfileSource =
    envProfile !== undefined ? "env" : configProfile !== undefined ? "config" : "default";

  if (selected === null) {
    return {
      config: { ...config, roles: { ...config.roles } },
      resolvedProfile: null,
      resolvedProfileSource: "default",
      effectiveFallbacks: {},
      warnings: [],
    };
  }

  const profiles = config.profiles;
  const profile = profiles?.[selected];
  if (!profile) {
    const selector = source === "env" ? "COMPOSER_PROFILE" : "activeProfile";
    throw new Error(`${selector} '${selected}' not found in composer profiles`);
  }

  const effectiveRoles = {
    ...config.roles,
    ...(profile.roles ?? {}),
  };
  validateConfiguredRoles(effectiveRoles);
  const effectiveFallbacks = cloneFallbacks(profile.fallbacks ?? {});
  validateFallbacks(effectiveFallbacks, effectiveRoles);

  let effectiveConfig: ComposerConfig = {
    ...config,
    roles: effectiveRoles,
  };

  if (profile.mode) {
    const patch = modePatch(profile.mode);
    effectiveConfig = {
      ...effectiveConfig,
      codexLifecycle: mergeRecordLike(effectiveConfig.codexLifecycle, patch.codexLifecycle),
      codexReview: mergeRecordLike(effectiveConfig.codexReview, patch.codexReview),
    } as ComposerConfig;
  }

  return {
    config: effectiveConfig,
    resolvedProfile: selected,
    resolvedProfileSource: source,
    effectiveFallbacks,
    warnings: sameProviderReviewWarnings(effectiveRoles),
  };
}

function readNonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function validateConfiguredRoles(roles: Partial<Record<RoleName, RoleConfig>>): void {
  for (const role of ["researcher", "coder", "reviewer"] as const) {
    if (!roles[role]) {
      throw new Error(`Profile resolution left required role '${role}' unconfigured`);
    }
  }
}

function validateFallbacks(
  fallbacks: Partial<Record<RoleName, RoleName[]>>,
  roles: Partial<Record<RoleName, RoleConfig>>,
): void {
  for (const [source, targets] of roleEntries(fallbacks)) {
    if (!roles[source]) {
      throw new Error(`Profile fallback source '${source}' is not configured`);
    }
    const seen = new Set<RoleName>();
    for (const target of targets) {
      if (target === source) {
        throw new Error(`Profile fallback for '${source}' must not reference itself`);
      }
      if (seen.has(target)) {
        throw new Error(`Duplicate fallback target '${target}' for role '${source}'`);
      }
      seen.add(target);
      if (roleIntent(source) !== roleIntent(target)) {
        throw new Error(
          `Profile fallback for '${source}' (${roleIntent(source)}) must not target '${target}' (${roleIntent(target)}); fallback chains cannot cross read/mutate intents.`,
        );
      }
      if (!roles[target]) {
        throw new Error(`Profile fallback target '${target}' for role '${source}' is not configured`);
      }
    }
  }

  const visiting = new Set<RoleName>();
  const visited = new Set<RoleName>();
  const visit = (role: RoleName, path: RoleName[]): void => {
    if (visiting.has(role)) {
      throw new Error(`Profile fallback cycle detected: ${[...path, role].join(" -> ")}`);
    }
    if (visited.has(role)) return;
    visiting.add(role);
    for (const target of fallbacks[role] ?? []) {
      visit(target, [...path, role]);
    }
    visiting.delete(role);
    visited.add(role);
  };

  for (const role of ROLE_NAMES) {
    visit(role, []);
  }
}

function cloneFallbacks(
  fallbacks: Partial<Record<RoleName, RoleName[]>>,
): Partial<Record<RoleName, RoleName[]>> {
  const cloned: Partial<Record<RoleName, RoleName[]>> = {};
  for (const [role, targets] of roleEntries(fallbacks)) {
    cloned[role] = [...targets];
  }
  return cloned;
}

function sameProviderReviewWarnings(
  roles: Partial<Record<RoleName, RoleConfig>>,
): string[] {
  const warnings: string[] = [];
  const warned = new Set<string>();
  for (const coderRole of CODER_ROLES) {
    const coder = roles[coderRole];
    if (!coder) continue;
    for (const reviewerRole of REVIEWER_ROLES) {
      const reviewer = roles[reviewerRole];
      if (!reviewer) continue;
      if (providerIdentity(coder) !== providerIdentity(reviewer)) continue;
      const key = `${coderRole}:${reviewerRole}`;
      if (warned.has(key)) continue;
      warned.add(key);
      warnings.push(
        `Executor profile maps ${coderRole} and ${reviewerRole} to the same provider identity; cross-model review diversity is reduced.`,
      );
    }
  }
  return warnings;
}

function providerIdentity(role: RoleConfig): string {
  return JSON.stringify({
    provider: role.provider,
    model: role.model ?? null,
    baseUrl: role.baseUrl ?? null,
    cli: role.cli ?? null,
  });
}

function roleEntries<T>(
  record: Partial<Record<RoleName, T>>,
): Array<[RoleName, T]> {
  const entries: Array<[RoleName, T]> = [];
  for (const role of ROLE_NAMES) {
    const value = record[role];
    if (value !== undefined) entries.push([role, value]);
  }
  return entries;
}

function mergeRecordLike(
  before: unknown,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(isRecord(before) ? before : {}),
    ...patch,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
