import { z } from "zod";

export type Tier = "cheap" | "premium";
export type Reasoning = "none" | "low" | "high";
export type PromptSize = "lite" | "full";
export type TaskClass =
  | "unknown"
  | "refuse"
  | "review-inline"
  | "review"
  | "bug-explain"
  | "research-first-code"
  | "cross-file-code"
  | "simple-code"
  | "trivial";
export type RouteTarget =
  | "inline"
  | "refuse"
  | "review-inline"
  | "task-reviewer"
  | "task-researcher-coder"
  | "composer-code-cli"
  | "composer-code-chain"
  | "composer-review-claude";
export type ProviderRole =
  | "researcher"
  | "coder"
  | "coderCli"
  | "reviewer"
  | "reviewerClaude";

export interface DispatchSignals {
  promptChars: number;
  estOutputTokens: number;
  hasCode: boolean;
  hasFileRef: boolean;
  hasDestructive: boolean;
  hasResearch: boolean;
  isWriteRequest: boolean;
  isSecuritySensitive: boolean;
  complexityScore: number;
  isReviewWithInlineDiff: boolean;
}

export interface RoutePolicy {
  taskClass: TaskClass;
  target: RouteTarget;
  providerRole?: ProviderRole;
  requiresReview: boolean;
  confidence: number;
  rationale: string;
}

export interface DispatchHint {
  tier: Tier;
  reasoning: Reasoning;
  promptSize: PromptSize;
  recommendDispatch: boolean;
  route: RoutePolicy;
  rationale: string;
  signals: DispatchSignals;
}

export interface ClassifyInput {
  prompt: string;
  subagentType?: string;
  description?: string;
}

export interface WorkerPromptParts {
  objective: string;
  files?: string[];
  constraints?: string[];
  acceptance?: string[];
  brief?: string;
}

const ClassifyInputSchema = z.object({
  prompt: z.string(),
  subagentType: z.string().optional(),
  description: z.string().optional(),
});

const WorkerPromptPartsSchema = z.object({
  objective: z.string().min(1),
  files: z.array(z.string()).optional(),
  constraints: z.array(z.string()).optional(),
  acceptance: z.array(z.string()).optional(),
  brief: z.string().optional(),
});

const CODE_KEYWORD = /\b(?:function|class|const|let|import|export|def)\b|=>/;
const FILE_REF =
  /\b(?:(?:src|tests|lib|app)\/[A-Za-z0-9._/-]+|[A-Za-z0-9._/-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|vue|svelte|css|scss|html|py|rs|go|java|kt|swift|rb|php|sh|ya?ml)(?::\d+)?)\b/i;
const DESTRUCTIVE =
  /(?:\brm\s+-rf\b|\bdrop\s+table\b|\bdelete\s+from\b|\btruncate\b|\breset\s+--hard\b|--force\b|\bdestroy\b)/i;
const SENSITIVE = /security|auth|crypto|payment/i;
const REVIEW = /\b(review|audit)\b/i;
const PREMIUM_REVIEW =
  /\b(?:premium review|claude review|claude reviewer|review with claude|second opinion|escalate to claude)\b/i;
const BUG_EXPLAIN = /\b(find|explain|identify)\b.{0,40}\bbug\b|\boff-by-one\b|\bmissing await\b/i;
const RESEARCH = /\b(research|look up|lookup|docs?|documentation|best practice|current|latest|web search)\b/i;
const WRITE_REQUEST = /\b(add|implement|create|edit|modify|refactor|fix|write|update|change)\b/i;
const DIFF_OR_CODE_BLOCK = /```|^diff --git |^@@ |^(?:---|\+\+\+) /m;

const HIGH_COMPLEXITY_TERMS: ReadonlyArray<RegExp> = [
  /\brefactor(?:ing|s|ed)?\b/i,
  /\bmigrat(?:e|es|ed|ing|ion|ions)\b/i,
  /\barchitecture\b/i,
  /\bredesign(?:ing|s|ed)?\b/i,
  /\bmulti[- ]file\b/i,
  /\bend[- ]to[- ]end\b/i,
  /\bschema\b/i,
  /\bconcurrency\b/i,
  /\brewrite(?:s|ing|n)?\b/i,
];

const LOW_COMPLEXITY_TERMS: ReadonlyArray<RegExp> = [
  /\btypo\b/i,
  /\brename(?:s|d|ing)?\b/i,
  /\bformat(?:s|ted|ting)?\b/i,
  /\bcomment(?:s|ed|ing)?\b/i,
  /\bbump(?:s|ed|ing)?\b/i,
  /\bone[- ]line\b/i,
  /\btrivial\b/i,
];

export function classifyDispatch(input: ClassifyInput): DispatchHint {
  const validated = ClassifyInputSchema.parse(input);
  const prompt = validated.prompt;
  const description = validated.description ?? "";
  const corpus = `${description}\n${prompt}`;
  const promptChars = prompt.length;
  const hasCode = detectCode(prompt);
  const hasFileRef = FILE_REF.test(prompt);
  const hasDestructive = DESTRUCTIVE.test(prompt);
  const hasResearch = RESEARCH.test(corpus);
  const isWriteRequest = WRITE_REQUEST.test(corpus);
  const isSecuritySensitive = SENSITIVE.test(corpus);
  const complexityScore = computeComplexityScore(prompt, {
    hasCode,
    hasFileRef,
  });
  const estOutputTokens =
    Math.round((promptChars / 4) * (1 + complexityScore * 2)) +
    (hasCode ? 200 : 0);
  const isReviewWithInlineDiff =
    REVIEW.test(corpus) && DIFF_OR_CODE_BLOCK.test(prompt);
  const signals: DispatchSignals = {
    promptChars,
    estOutputTokens,
    hasCode,
    hasFileRef,
    hasDestructive,
    hasResearch,
    isWriteRequest,
    isSecuritySensitive,
    complexityScore,
    isReviewWithInlineDiff,
  };
  const route = classifyRoute({ corpus, signals });

  const recommendDispatch =
    route.target !== "inline" &&
    route.target !== "refuse" &&
    route.target !== "review-inline";
  const tier: Tier =
    complexityScore >= 0.6 || promptChars > 2000 || route.target === "composer-review-claude"
      ? "premium"
      : "cheap";
  const reasoning: Reasoning =
    complexityScore >= 0.6 ? "high" : complexityScore >= 0.25 ? "low" : "none";
  const promptSize: PromptSize =
    route.target === "task-researcher-coder" ||
    complexityScore >= 0.4 ||
    (hasFileRef && estOutputTokens > 800)
      ? "full"
      : "lite";

  return {
    tier,
    reasoning,
    promptSize,
    recommendDispatch,
    route,
    rationale: rationaleFor({ recommendDispatch, route, signals }),
    signals,
  };
}

export function neutralDispatchHint(): DispatchHint {
  return classifyDispatch({ prompt: "" });
}

export function buildWorkerPrompt(
  hint: DispatchHint,
  parts: WorkerPromptParts,
): string {
  const validated = WorkerPromptPartsSchema.parse(parts);
  const sections = [formatBlock("Objective", validated.objective)];
  const files = nonEmptyItems(validated.files ?? []);
  if (files.length > 0) sections.push(formatList("Files", files));

  if (hint.promptSize === "full") {
    const constraints = nonEmptyItems(validated.constraints ?? []);
    const acceptance = nonEmptyItems(validated.acceptance ?? []);
    const brief = validated.brief ?? "";
    if (constraints.length > 0) sections.push(formatList("Constraints", constraints));
    if (acceptance.length > 0) sections.push(formatList("Acceptance", acceptance));
    if (brief.trim().length > 0) sections.push(formatBlock("Brief", brief));
  }

  return sections.join("\n\n");
}

function detectCode(prompt: string): boolean {
  if (/```/.test(prompt)) return true;
  if (hasIndentedBlock(prompt)) return true;

  const matchCount = Array.from(prompt.matchAll(new RegExp(CODE_KEYWORD.source, "g"))).length;
  if (matchCount === 0) return false;

  const wordCount = prompt.match(/\b[\w-]+\b/g)?.length ?? 1;
  const density = matchCount / Math.max(1, wordCount);
  return matchCount >= 2 || density >= 0.02;
}

function hasIndentedBlock(prompt: string): boolean {
  for (const line of prompt.split(/\r?\n/)) {
    if (/^(?: {4,}|\t)\S/.test(line)) {
      return true;
    }
  }
  return false;
}

function computeComplexityScore(
  prompt: string,
  signals: Pick<DispatchSignals, "hasCode" | "hasFileRef">,
): number {
  let score = 0;
  for (const term of HIGH_COMPLEXITY_TERMS) {
    if (term.test(prompt)) score += 0.3;
  }
  for (const term of LOW_COMPLEXITY_TERMS) {
    if (term.test(prompt)) score -= 0.2;
  }
  if (signals.hasCode) score += 0.15;
  if (signals.hasFileRef) score += 0.1;
  if (prompt.length > 1200) score += 0.2;
  return roundScore(clamp(score, 0, 1));
}

function classifyRoute(input: {
  corpus: string;
  signals: DispatchSignals;
}): RoutePolicy {
  const { corpus, signals } = input;
  const wantsPremiumReview = PREMIUM_REVIEW.test(corpus);

  if (signals.hasDestructive && signals.promptChars < 200) {
    return routePolicy({
      taskClass: "refuse",
      target: "refuse",
      confidence: 0.95,
      rationale: "Tiny destructive prompt should be refused inline, not delegated.",
    });
  }

  if (signals.isReviewWithInlineDiff && signals.estOutputTokens <= 600) {
    return routePolicy({
      taskClass: "review-inline",
      target: "review-inline",
      confidence: 0.86,
      rationale: "Self-contained small diff review is cheaper inline than a cold reviewer dispatch.",
    });
  }

  if (REVIEW.test(corpus) && (signals.isSecuritySensitive || signals.promptChars > 1200 || wantsPremiumReview)) {
    return routePolicy({
      taskClass: "review",
      target: wantsPremiumReview ? "composer-review-claude" : "task-reviewer",
      providerRole: wantsPremiumReview ? "reviewerClaude" : "reviewer",
      confidence: wantsPremiumReview ? 0.85 : signals.isSecuritySensitive ? 0.8 : 0.78,
      rationale: wantsPremiumReview
        ? "Explicit premium review request should use the Claude reviewer lane."
        : signals.isSecuritySensitive
          ? "Security-sensitive review should start in the isolated reviewer lane before premium escalation."
          : "Large review prompt should be isolated in the reviewer context.",
    });
  }

  if (BUG_EXPLAIN.test(corpus) && !signals.hasFileRef && signals.estOutputTokens <= 700) {
    return routePolicy({
      taskClass: "bug-explain",
      target: "inline",
      confidence: 0.74,
      rationale: "Small bug explanation can stay inline; no file mutation or broad context needed.",
    });
  }

  if (signals.hasResearch && signals.isWriteRequest) {
    return routePolicy({
      taskClass: "research-first-code",
      target: "task-researcher-coder",
      providerRole: "researcher",
      requiresReview: true,
      confidence: 0.82,
      rationale: "Research-first implementation needs a researcher brief before code execution.",
    });
  }

  if (signals.isWriteRequest && (signals.complexityScore >= 0.4 || signals.hasFileRef)) {
    return routePolicy({
      taskClass: signals.complexityScore >= 0.4 ? "cross-file-code" : "simple-code",
      target: "composer-code-cli",
      providerRole: "coderCli",
      requiresReview: true,
      confidence: signals.complexityScore >= 0.4 ? 0.8 : 0.68,
      rationale: "Code mutation should be applied off the main session by the CLI executor.",
    });
  }

  if (LOW_COMPLEXITY_TERMS.some((term) => term.test(corpus))) {
    return routePolicy({
      taskClass: "trivial",
      target: "inline",
      confidence: 0.7,
      rationale: "Trivial non-mutating prompt is cheaper inline.",
    });
  }

  return routePolicy({
    taskClass: "unknown",
    target: "inline",
    confidence: 0.55,
    rationale: "No strong route signal; default to inline to avoid unnecessary cold dispatch.",
  });
}

function routePolicy(policy: Omit<RoutePolicy, "requiresReview"> & { requiresReview?: boolean }): RoutePolicy {
  return {
    requiresReview: false,
    ...policy,
    confidence: roundScore(clamp(policy.confidence, 0, 1)),
  };
}

function rationaleFor(input: {
  recommendDispatch: boolean;
  route: RoutePolicy;
  signals: DispatchSignals;
}): string {
  const { recommendDispatch, route, signals } = input;
  if (recommendDispatch) {
    return `Route ${route.target}: ${route.rationale} Estimated ${signals.estOutputTokens} tokens, complexity ${signals.complexityScore}.`;
  }
  return `Route ${route.target}: ${route.rationale} Estimated ${signals.estOutputTokens} tokens, complexity ${signals.complexityScore}.`;
}

function nonEmptyItems(items: ReadonlyArray<string>): string[] {
  return items.filter((item) => item.trim().length > 0);
}

function formatBlock(label: string, body: string): string {
  return `${label}:\n${body}`;
}

function formatList(label: string, items: ReadonlyArray<string>): string {
  return `${label}:\n${items.map((item) => `- ${item}`).join("\n")}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}
