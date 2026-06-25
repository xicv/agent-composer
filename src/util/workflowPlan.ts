export type WorkflowKind = "feature" | "debug" | "review" | "research";
export type WorkflowMode = "fast" | "balanced" | "strict";
export type WorkflowRisk = "low" | "medium" | "high";

export interface WorkflowPlanInput {
  goal: string;
  workflow?: WorkflowKind;     // default "feature"
  mode?: WorkflowMode;         // default "balanced"
  risk?: WorkflowRisk;         // default "medium"
  needsCurrentDocs?: boolean;  // default false
}

export interface WorkflowStep {
  tool: string;
  why: string;
  optional?: boolean;
}

export interface WorkflowPlan {
  goal: string;
  workflow: WorkflowKind;
  mode: WorkflowMode;
  risk: WorkflowRisk;
  steps: WorkflowStep[];
  notes: string[];
}

export function planWorkflow(input: WorkflowPlanInput): WorkflowPlan {
  const workflow = input.workflow ?? "feature";
  const mode = input.mode ?? "balanced";
  const risk = input.risk ?? "medium";
  const steps: WorkflowStep[] = [];
  const includeReview = mode !== "fast";
  const includeOracle = risk === "high";
  const includeResearch = input.needsCurrentDocs === true;

  switch (workflow) {
    case "feature":
      steps.push({ tool: "composer_handoff_create", why: "Capture a compact, provider-neutral brief for the workers." });
      if (includeResearch) steps.push({ tool: "composer_research", why: "Fetch current docs/API shape before implementing.", optional: true });
      if (includeOracle) steps.push({ tool: "composer_oracle_plan", why: "High risk / architecture uncertainty — get an extended-reasoning plan (sync).", optional: true });
      steps.push({ tool: "composer_code_cli", why: "Apply the implementation off the main session." });
      if (includeReview) steps.push({ tool: "composer_review", why: "Review the scoped diff (reviewScope: staged|branch) before commit." });
      steps.push({ tool: "composer_audit", why: "Record the route + outcome for evidence with action:\"record\".", optional: true });
      break;
    case "debug":
      if (includeOracle) steps.push({ tool: "composer_oracle_plan", why: "Hard root-cause — extended reasoning (sync).", optional: true });
      if (includeResearch) steps.push({ tool: "composer_research", why: "Look up error/API specifics.", optional: true });
      steps.push({ tool: "composer_code_cli", why: "Apply the fix off the main session." });
      if (includeReview) steps.push({ tool: "composer_review", why: "Review the fix diff." });
      steps.push({ tool: "composer_audit", why: "Record the outcome with action:\"record\".", optional: true });
      break;
    case "review":
      steps.push({ tool: "composer_review", why: "Review the scoped diff (use reviewScope to avoid pasting)." });
      steps.push({ tool: "composer_audit", why: "Record the verdict with action:\"record\".", optional: true });
      break;
    case "research":
      steps.push({ tool: "composer_research", why: "Gather external context/docs." });
      steps.push({ tool: "composer_handoff_create", why: "Persist findings for the implementing step.", optional: true });
      break;
  }

  const notes: string[] = [];
  if (mode === "fast") notes.push("fast mode: review + lifecycle gates skipped — use for tiny, low-risk changes.");
  if (mode === "strict") notes.push("strict mode: review gate + fail-closed pre-commit expected.");
  if (!includeOracle && (workflow === "feature" || workflow === "debug")) notes.push("Oracle skipped (risk<high). Tag [oracle:plan] explicitly if architecture is uncertain.");

  return { goal: input.goal, workflow, mode, risk, steps, notes };
}
