import { roleIntent } from "../config/profiles.js";
import type { RoleName } from "../config/schema.js";
import { ProviderConfigError } from "../registry.js";
import { SpendLimitError } from "../providers/SpendGuardProvider.js";
import type {
  IProviderExecuteInput,
  IProviderExecuteOutput,
  ProviderId,
} from "../providers/IProvider.js";

export type DispatchErrorClass =
  | "UNAVAILABLE"
  | "SPEND_CAP_CALL"
  | "SPEND_CAP_SESSION"
  | "AUTH"
  | "VALIDATION"
  | "TIMEOUT"
  | "RATE_LIMIT";

export interface DispatchFallbackAttempt {
  role: RoleName;
  providerId: ProviderId | "unknown";
  errorClass: DispatchErrorClass;
  durationMs: number;
}

export interface DispatchFallbackSummary {
  primaryRole: RoleName;
  providerRole: RoleName;
  fallbackUsed: boolean;
  attempts: DispatchFallbackAttempt[];
}

export interface DispatchWithFallbackContext {
  registry: {
    getProviderForRole(role: RoleName): {
      readonly id: ProviderId;
      readonly modelLabel: string;
      execute(input: IProviderExecuteInput): Promise<IProviderExecuteOutput>;
    };
  };
  effectiveFallbacks: Partial<Record<RoleName, RoleName[]>>;
}

export class DispatchUnavailableError extends Error {
  readonly attempts: DispatchFallbackAttempt[];

  constructor(primaryRole: RoleName, attempts: DispatchFallbackAttempt[]) {
    super(
      `No available provider succeeded for role '${primaryRole}' after ${attempts.length} attempt(s).`,
    );
    this.name = "DispatchUnavailableError";
    this.attempts = attempts;
  }
}

export async function dispatchWithFallback(
  ctx: DispatchWithFallbackContext,
  primaryRole: RoleName,
  input: IProviderExecuteInput,
): Promise<{ output: IProviderExecuteOutput; summary: DispatchFallbackSummary }> {
  const chain = providerRoleChain(primaryRole, ctx.effectiveFallbacks);
  const hasRuntimeFallback = chain.length > 1;
  const attempts: DispatchFallbackAttempt[] = [];

  for (const role of chain) {
    const started = Date.now();
    let providerId: ProviderId | "unknown" = "unknown";
    try {
      const provider = ctx.registry.getProviderForRole(role);
      providerId = provider.id;
      const output = await provider.execute(input);
      return {
        output,
        summary: {
          primaryRole,
          providerRole: role,
          fallbackUsed: role !== primaryRole,
          attempts,
        },
      };
    } catch (error) {
      const errorClass = classifyDispatchError(error, providerId);
      const attempt = {
        role,
        providerId,
        errorClass,
        durationMs: Math.max(0, Date.now() - started),
      };
      if (!hasRuntimeFallback) {
        throw error;
      }
      attempts.push(attempt);
      if (isTerminalDispatchError(errorClass)) {
        throw attachDispatchAttempts(error, attempts);
      }
    }
  }

  throw new DispatchUnavailableError(primaryRole, attempts);
}

export function classifyDispatchError(error: unknown, _providerId: ProviderId | "unknown"): DispatchErrorClass {
  if (error instanceof SpendLimitError) {
    if (error.kind === "spend_cap_call") return "SPEND_CAP_CALL";
    if (error.kind === "spend_cap_session") return "SPEND_CAP_SESSION";
  }
  if (error instanceof ProviderConfigError) {
    return "AUTH";
  }

  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  if (/\b(timed out|timeout|etimedout)\b/.test(normalized)) return "TIMEOUT";
  if (
    /\b(rate limit|rate-limit|too many requests|429)\b/.test(
      normalized,
    )
  ) {
    return "RATE_LIMIT";
  }
  if (
    /\b(auth|authenticated|authentication|credential|credentials|login|logged in|unauthori[sz]ed|forbidden|access token|api key|401|403|config)\b/.test(
      normalized,
    )
  ) {
    return "AUTH";
  }
  if (
    /\b(validation|schema|invalid input|bad request|malformed|zod|400)\b/.test(
      normalized,
    )
  ) {
    return "VALIDATION";
  }
  if (
    /\b(temporarily unavailable|overloaded|overloaded_error|econnreset|ecconnreset|econnrefused|enotfound|fetch failed|socket hang up|connection error|network|5\d\d)\b/.test(
      normalized,
    )
  ) {
    return "UNAVAILABLE";
  }
  return "UNAVAILABLE";
}

export function isTerminalDispatchError(errorClass: DispatchErrorClass): boolean {
  return errorClass === "SPEND_CAP_SESSION" || errorClass === "VALIDATION";
}

function providerRoleChain(
  primaryRole: RoleName,
  fallbacks: Partial<Record<RoleName, RoleName[]>>,
): RoleName[] {
  if (roleIntent(primaryRole) === "MUTATE") return [primaryRole];
  const chain: RoleName[] = [primaryRole];
  for (const role of fallbacks[primaryRole] ?? []) {
    if (!chain.includes(role)) chain.push(role);
  }
  return chain;
}

function attachDispatchAttempts(error: unknown, attempts: DispatchFallbackAttempt[]): Error {
  if (error instanceof Error) {
    Object.defineProperty(error, "attempts", {
      value: attempts,
      configurable: true,
      enumerable: true,
    });
    return error;
  }
  const wrapped = new Error(String(error));
  Object.defineProperty(wrapped, "attempts", {
    value: attempts,
    configurable: true,
    enumerable: true,
  });
  return wrapped;
}
