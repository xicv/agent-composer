import { describe, it, expect } from "vitest";
import { runEvolve, rotateHoldout } from "../../src/evolve/runner.js";
import type { EvolveDeps, EvolveTask } from "../../src/evolve/runner.js";
import type { IProvider } from "../../src/providers/IProvider.js";

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
