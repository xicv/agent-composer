import { describe, expect, it } from "vitest";

import type { DoctorCheck, DoctorReport } from "../../src/cli/doctor.js";
import type { ComposerStatus } from "../../src/cli/status.js";
import {
  buildDailyReadiness,
  dailyReadinessExitCode,
  renderDailyReadinessHuman,
} from "../../src/util/dailyReadiness.js";

describe("dailyReadiness", () => {
  it("keeps optional doctor warnings advisory while reporting ready", () => {
    const readiness = buildDailyReadiness({
      status: makeStatus(),
      doctor: report([{ name: "oracle runtime", status: "warn", detail: "oracle CLI not found (optional)" }]),
      generatedAt: "2026-07-01T00:00:00.000Z",
    });

    expect(readiness.state).toBe("ready");
    expect(readiness.summary).toContain("ready for daily use");
    expect(readiness.warnings).toHaveLength(1);
    expect(readiness.nextAction).toBe("composer_route_decide");
    expect(dailyReadinessExitCode(readiness)).toBe(0);
  });

  it("reports disabled before other readiness states", () => {
    const readiness = buildDailyReadiness({
      status: makeStatus({ integrations: { composerDisabled: true } }),
      doctor: report(),
    });

    expect(readiness.state).toBe("disabled");
    expect(readiness.nextAction).toBe("/composer enable");
    expect(dailyReadinessExitCode(readiness)).toBe(1);
  });

  it("blocks when config or doctor checks fail", () => {
    const readiness = buildDailyReadiness({
      status: makeStatus({ config: { exists: false } }),
      doctor: report([{ name: "codex CLI", status: "fail", detail: "codex CLI not found" }]),
    });

    expect(readiness.state).toBe("blocked");
    expect(readiness.blockers.map((issue) => issue.name)).toEqual(["config", "codex CLI"]);
    expect(readiness.nextAction).toBe("agent-composer init");
    expect(dailyReadinessExitCode(readiness)).toBe(1);
  });

  it("degrades on workflow signals that need attention", () => {
    const readiness = buildDailyReadiness({
      status: makeStatus({ latest: { testsPassed: false } }),
      doctor: report(),
    });

    expect(readiness.state).toBe("degraded");
    expect(readiness.warnings[0]).toMatchObject({
      name: "latest tests",
      action: "composer_audit_read",
    });
    expect(readiness.nextAction).toBe("composer_audit_read");
  });

  it("renders a compact human summary", () => {
    const readiness = buildDailyReadiness({
      status: makeStatus(),
      doctor: report(),
      statusLine: "CMP strict · R:on",
    });

    expect(renderDailyReadinessHuman(readiness)).toContain("state:            ready");
    expect(renderDailyReadinessHuman(readiness)).toContain("CMP strict");
  });
});

function report(checks: DoctorCheck[] = []): DoctorReport {
  return {
    checks,
    healthy: checks.every((check) => check.status !== "fail"),
  };
}

function makeStatus(overrides: {
  config?: Partial<ComposerStatus["config"]>;
  integrations?: Partial<ComposerStatus["integrations"]>;
  executorProfile?: Partial<ComposerStatus["executorProfile"]>;
  latest?: Partial<ComposerStatus["latest"]>;
  goal?: ComposerStatus["goal"];
} = {}): ComposerStatus {
  const base: ComposerStatus = {
    config: {
      path: "/tmp/project/composer.config.json",
      exists: true,
      mode: "strict",
    },
    executorProfile: {
      active: null,
      source: "default",
      available: [],
      warnings: [],
    },
    integrations: {
      codexReview: true,
      codexLifecycle: true,
      oraclePlanner: false,
      gitHook: "on",
      gitHookInstalled: true,
      composerDisabled: false,
    },
    active: {},
    latestJob: {},
    latest: {},
    recommendation: {
      nextAction: "composer_route_decide",
      reason: "ask Composer which lane fits the next task",
    },
  };

  return {
    ...base,
    ...overrides,
    config: { ...base.config, ...overrides.config },
    executorProfile: { ...base.executorProfile, ...overrides.executorProfile },
    integrations: { ...base.integrations, ...overrides.integrations },
    latest: { ...base.latest, ...overrides.latest },
  };
}
