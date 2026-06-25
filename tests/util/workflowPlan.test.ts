import { describe, it, expect } from "vitest";
import { planWorkflow } from "../../src/util/workflowPlan.js";

describe("planWorkflow", () => {
  it("returns defaults when only goal is supplied", () => {
    const plan = planWorkflow({ goal: "add logging" });
    expect(plan.workflow).toBe("feature");
    expect(plan.mode).toBe("balanced");
    expect(plan.risk).toBe("medium");
    expect(plan.goal).toBe("add logging");
    expect(Array.isArray(plan.steps)).toBe(true);
    expect(Array.isArray(plan.notes)).toBe(true);
  });

  it("feature+fast omits composer_review", () => {
    const plan = planWorkflow({ goal: "tiny fix", workflow: "feature", mode: "fast" });
    const tools = plan.steps.map((s) => s.tool);
    expect(tools).not.toContain("composer_review");
  });

  it("feature+balanced includes composer_review", () => {
    const plan = planWorkflow({ goal: "add feature", workflow: "feature", mode: "balanced" });
    const tools = plan.steps.map((s) => s.tool);
    expect(tools).toContain("composer_review");
  });

  it("feature+strict includes composer_review", () => {
    const plan = planWorkflow({ goal: "add feature", workflow: "feature", mode: "strict" });
    const tools = plan.steps.map((s) => s.tool);
    expect(tools).toContain("composer_review");
  });

  it("feature+risk:high includes composer_oracle_plan", () => {
    const plan = planWorkflow({ goal: "redesign auth", workflow: "feature", risk: "high" });
    const tools = plan.steps.map((s) => s.tool);
    expect(tools).toContain("composer_oracle_plan");
  });

  it("feature+risk:low does NOT include composer_oracle_plan", () => {
    const plan = planWorkflow({ goal: "rename var", workflow: "feature", risk: "low" });
    const tools = plan.steps.map((s) => s.tool);
    expect(tools).not.toContain("composer_oracle_plan");
  });

  it("feature+needsCurrentDocs includes composer_research", () => {
    const plan = planWorkflow({ goal: "fetch api docs", workflow: "feature", needsCurrentDocs: true });
    const tools = plan.steps.map((s) => s.tool);
    expect(tools).toContain("composer_research");
  });

  it("feature without needsCurrentDocs does NOT include composer_research", () => {
    const plan = planWorkflow({ goal: "add helper", workflow: "feature" });
    const tools = plan.steps.map((s) => s.tool);
    expect(tools).not.toContain("composer_research");
  });

  it("debug workflow includes composer_code_cli", () => {
    const plan = planWorkflow({ goal: "fix null ptr", workflow: "debug" });
    const tools = plan.steps.map((s) => s.tool);
    expect(tools).toContain("composer_code_cli");
  });

  it("debug+balanced includes composer_review", () => {
    const plan = planWorkflow({ goal: "fix bug", workflow: "debug", mode: "balanced" });
    const tools = plan.steps.map((s) => s.tool);
    expect(tools).toContain("composer_review");
  });

  it("debug+fast omits composer_review", () => {
    const plan = planWorkflow({ goal: "fix bug", workflow: "debug", mode: "fast" });
    const tools = plan.steps.map((s) => s.tool);
    expect(tools).not.toContain("composer_review");
  });

  it("debug+risk:high includes composer_oracle_plan", () => {
    const plan = planWorkflow({ goal: "hard root cause", workflow: "debug", risk: "high" });
    const tools = plan.steps.map((s) => s.tool);
    expect(tools).toContain("composer_oracle_plan");
  });

  it("review workflow shape: composer_review then composer_audit", () => {
    const plan = planWorkflow({ goal: "review pr", workflow: "review" });
    const tools = plan.steps.map((s) => s.tool);
    expect(tools[0]).toBe("composer_review");
    expect(tools).toContain("composer_audit");
    expect(tools).not.toContain("composer_code_cli");
  });

  it("research workflow shape: composer_research then composer_handoff_create", () => {
    const plan = planWorkflow({ goal: "look up zod docs", workflow: "research" });
    const tools = plan.steps.map((s) => s.tool);
    expect(tools[0]).toBe("composer_research");
    expect(tools).toContain("composer_handoff_create");
  });

  it("fast mode note mentions review+lifecycle gates skipped", () => {
    const plan = planWorkflow({ goal: "tiny", mode: "fast" });
    expect(plan.notes.some((n) => n.includes("fast mode"))).toBe(true);
  });

  it("strict mode note mentions strict mode", () => {
    const plan = planWorkflow({ goal: "serious", mode: "strict" });
    expect(plan.notes.some((n) => n.includes("strict mode"))).toBe(true);
  });

  it("feature+balanced+medium notes that Oracle was skipped", () => {
    const plan = planWorkflow({ goal: "add feature", workflow: "feature", mode: "balanced", risk: "medium" });
    expect(plan.notes.some((n) => n.includes("Oracle skipped"))).toBe(true);
  });

  it("debug+medium notes that Oracle was skipped", () => {
    const plan = planWorkflow({ goal: "fix bug", workflow: "debug", risk: "medium" });
    expect(plan.notes.some((n) => n.includes("Oracle skipped"))).toBe(true);
  });

  it("feature+high does NOT add Oracle-skipped note", () => {
    const plan = planWorkflow({ goal: "redesign", workflow: "feature", risk: "high" });
    expect(plan.notes.every((n) => !n.includes("Oracle skipped"))).toBe(true);
  });
});
