import { describe, it, expect } from "vitest";
import { runEvolve, rotateHoldout } from "../../src/evolve/runner.js";
import type { EvolveDeps, EvolveTask } from "../../src/evolve/runner.js";
import { addCounterexample } from "../../src/evolve/operators.js";
import type { IProvider } from "../../src/providers/IProvider.js";
import { buildReflectionPrompt } from "../../src/evolve/reflection.js";
import type { AuditFailure } from "../../src/evolve/reflection.js";

function silentProvider(reply: string = ""): IProvider {
  return {
    id: "cli",
    modelLabel: "mock",
    healthCheck: async () => true,
    execute: async () => ({ text: reply }),
  };
}

const tasks: EvolveTask[] = [
  { id: "t1", description: "task 1" },
  { id: "t2", description: "task 2" },
  { id: "t3", description: "task 3" },
];

describe("rotateHoldout — round-robin across 3 tasks", () => {
  it("cycles holdout per round", () => {
    expect(rotateHoldout(tasks, 0).holdout.id).toBe("t1");
    expect(rotateHoldout(tasks, 1).holdout.id).toBe("t2");
    expect(rotateHoldout(tasks, 2).holdout.id).toBe("t3");
    expect(rotateHoldout(tasks, 3).holdout.id).toBe("t1");
  });

  it("keeps non-holdout tasks as train+val", () => {
    const r = rotateHoldout(tasks, 0);
    expect(r.trainVal.map((t) => t.id)).toEqual(["t2", "t3"]);
  });

  it("throws when fewer than 2 tasks", () => {
    expect(() => rotateHoldout([tasks[0]!], 0)).toThrow();
  });
});

describe("runEvolve — orchestrator integration", () => {
  it("returns parent when plateau triggers on round 1 (deps stub)", async () => {
    const deps: EvolveDeps = {
      reflectionProvider: silentProvider("rewrite"),
      researchProvider: silentProvider("ecosystem snapshot"),
      evaluate: async () => ({ score: 0.5, transcripts: [] }),
      reReplicate: async () => true,
      skillDomain: "test",
    };
    const result = await runEvolve({
      parent: "## Skill\n",
      tasks,
      deps,
      maxRounds: 0,
    });
    expect(result.winner).toBe("## Skill\n");
    expect(result.history.length).toBe(0);
    expect(result.stoppedAt).toBe("maxRounds");
  });

  it("promotes a strictly-better candidate", async () => {
    let round = 0;
    const deps: EvolveDeps = {
      reflectionProvider: silentProvider("## Better\n"),
      researchProvider: silentProvider("snap"),
      evaluate: async (skill) => {
        const score = skill.includes("Better") ? 0.95 : 0.30;
        round++;
        return {
          score,
          transcripts: [{ task: `r${round}`, outcome: score > 0.5 ? "pass" : "fail" }],
        };
      },
      reReplicate: async () => true,
      skillDomain: "test",
      postflightOverride: async () => ({ accept: true, reason: "test" }),
    };
    const result = await runEvolve({
      parent: "## Skill\n",
      tasks,
      deps,
      maxRounds: 5, // round 4 picks reflect_and_rewrite which uses the reflectionProvider
      reRunSamples: 3,
    });
    expect(result.winner).toContain("Better");
    expect(result.history.length).toBeGreaterThan(0);
  });

  it("skips a no-op mutation (operator returned skill unchanged) — no variance-driven promotion", async () => {
    let evalCalls = 0;
    const deps: EvolveDeps = {
      reflectionProvider: silentProvider("x"),
      researchProvider: silentProvider("snap"),
      // would return wildly different scores if ever called — but the no-op
      // candidate must be skipped BEFORE any eval, so this must run 0 times.
      evaluate: async () => {
        evalCalls++;
        return { score: evalCalls % 2 === 0 ? 0.9 : 0.1, transcripts: [] };
      },
      reReplicate: async () => true,
      skillDomain: "test",
      // force an operator that returns the skill unchanged (the real
      // add_counterexample no-ops when ctx has no counterexample)
      pickOperator: () => ({ name: "noop", keepRate: 1, apply: async (sk: string) => sk }),
      postflightOverride: async () => ({ accept: true, reason: "test" }),
    };
    const result = await runEvolve({
      parent: "## Skill\n",
      tasks,
      deps,
      maxRounds: 3,
      reRunSamples: 3,
    });
    expect(result.winner).toBe("## Skill\n");
    // parentEval runs once per round (needed for transcripts), but the no-op
    // candidate is skipped before any CANDIDATE eval -> 3 evals (parent only),
    // never promoted.
    expect(evalCalls).toBe(3);
    expect(result.history.length).toBe(3);
    expect(result.history.every((h) => h.promoted === false && /no-op/.test(h.reason))).toBe(true);
  });

  it("routes a failing transcript into add_counterexample -> candidate mutates + promotes", async () => {
    const failTask = "t-fail";
    const deps: EvolveDeps = {
      reflectionProvider: silentProvider("x"),
      researchProvider: silentProvider("snap"),
      // parent (no counterexample) fails; candidate (with one) passes
      evaluate: async (skill) => {
        const hasCex = skill.includes("Counterexamples");
        return {
          score: hasCex ? 0.95 : 0.1,
          transcripts: [
            { task: failTask, outcome: hasCex ? "pass" : "fail: wrong output" },
          ],
        };
      },
      reReplicate: async () => true,
      skillDomain: "test",
      pickOperator: () => ({
        name: "add_counterexample",
        keepRate: 1,
        apply: async (sk: string, c) => addCounterexample(sk, c),
      }),
      postflightOverride: async () => ({ accept: true, reason: "test" }),
    };
    const result = await runEvolve({
      parent: "## Skill\n",
      tasks,
      deps,
      maxRounds: 1,
      reRunSamples: 3,
    });
    // the failing-task note was routed into ctx.counterexample and applied
    expect(result.winner).toContain("Counterexamples");
    expect(result.winner).toContain(failTask);
    expect(result.history.some((h) => h.promoted)).toBe(true);
  });

  it("budget exhaustion stops the loop early", async () => {
    const deps: EvolveDeps = {
      reflectionProvider: silentProvider("## X"),
      researchProvider: silentProvider("snap"),
      evaluate: async () => ({ score: 0.5, transcripts: [] }),
      reReplicate: async () => true,
      skillDomain: "test",
    };
    const result = await runEvolve({
      parent: "## Skill\n",
      tasks,
      deps,
      maxRounds: 100,
      budget: { maxCalls: 2, maxUsd: 100 },
    });
    expect(result.stoppedAt).toBe("budget");
  });

  it("auditFailures threads into reflection prompt and runEvolve completes without crash", async () => {
    const auditFailures: AuditFailure[] = [
      { route: "composer_code_cli", taskClass: "cross-file-code", status: "failed", note: "review caught a missing await" },
      { route: "composer_oracle_plan", userCorrection: true },
    ];

    // Verify buildReflectionPrompt includes the audit-failure section (unit-level assertion
    // directly on the prompt builder, since intercepting the reflect call inside runEvolve
    // would require provider-level spy setup beyond the existing harness pattern).
    const promptWithFailures = buildReflectionPrompt({
      parent: "## Skill\n",
      taskTranscripts: [],
      auditFailures,
    });
    expect(promptWithFailures).toContain("Recent route/audit failures");
    expect(promptWithFailures).toContain("composer_code_cli");
    expect(promptWithFailures).toContain("user-corrected");

    // Also verify runEvolve completes successfully when auditFailures is passed.
    const deps: EvolveDeps = {
      reflectionProvider: silentProvider("## Better\n"),
      researchProvider: silentProvider("snap"),
      evaluate: async () => ({ score: 0.5, transcripts: [] }),
      reReplicate: async () => true,
      skillDomain: "test",
      postflightOverride: async () => ({ accept: true, reason: "test" }),
    };
    const result = await runEvolve({
      parent: "## Skill\n",
      tasks,
      deps,
      maxRounds: 0,
      auditFailures,
    });
    expect(result.winner).toBe("## Skill\n");
    expect(result.stoppedAt).toBe("maxRounds");
  });

  it("postflight reject keeps parent as winner", async () => {
    const deps: EvolveDeps = {
      reflectionProvider: silentProvider("## Better\n"),
      researchProvider: silentProvider("snap"),
      evaluate: async (skill) => ({
        score: skill.includes("Better") ? 0.95 : 0.30,
        transcripts: [],
      }),
      reReplicate: async () => true,
      skillDomain: "test",
      postflightOverride: async () => ({ accept: false, reason: "deprecated API used" }),
    };
    const result = await runEvolve({
      parent: "## Skill\n",
      tasks,
      deps,
      maxRounds: 2,
      reRunSamples: 3,
    });
    expect(result.winner).toBe("## Skill\n");
    expect(result.postflightRejections.length).toBeGreaterThan(0);
  });
});
