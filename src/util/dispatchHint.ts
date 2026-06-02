import { z } from "zod";

export type Tier = "cheap" | "premium";
export type Reasoning = "none" | "low" | "high";
export type PromptSize = "lite" | "full";

export interface DispatchSignals {
  promptChars: number;
  estOutputTokens: number;
  hasCode: boolean;
  hasFileRef: boolean;
  hasDestructive: boolean;
  complexityScore: number;
  isReviewWithInlineDiff: boolean;
}

export interface DispatchHint {
  tier: Tier;
  reasoning: Reasoning;
  promptSize: PromptSize;
  recommendDispatch: boolean;
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
const FILE_REF = /(\.[a-z0-9]{1,5}\b|src\/|tests\/|lib\/|app\/)[A-Za-z0-9._/-]*(:\d+)?/i;
const DESTRUCTIVE =
  /(?:\brm\s+-rf\b|\bdrop\s+table\b|\bdelete\s+from\b|\btruncate\b|\breset\s+--hard\b|--force\b|\bdestroy\b)/i;
const SENSITIVE = /security|auth|crypto|payment/i;
const REVIEW = /\b(review|audit)\b/i;
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
  const promptChars = prompt.length;
  const hasCode = detectCode(prompt);
  const hasFileRef = FILE_REF.test(prompt);
  const hasDestructive = DESTRUCTIVE.test(prompt);
  const complexityScore = computeComplexityScore(prompt, {
    hasCode,
    hasFileRef,
  });
  const estOutputTokens =
    Math.round((promptChars / 4) * (1 + complexityScore * 2)) +
    (hasCode ? 200 : 0);
  const isReviewWithInlineDiff =
    REVIEW.test(`${description}\n${prompt}`) && DIFF_OR_CODE_BLOCK.test(prompt);

  let recommendDispatch =
    estOutputTokens > 500 || (hasFileRef && complexityScore > 0.3);
  if (isReviewWithInlineDiff && estOutputTokens <= 600) {
    recommendDispatch = false;
  }
  if (hasDestructive && promptChars < 200) {
    recommendDispatch = false;
  }

  const sensitive = SENSITIVE.test(`${description}\n${prompt}`);
  const tier: Tier =
    complexityScore >= 0.6 || promptChars > 2000 || sensitive
      ? "premium"
      : "cheap";
  const reasoning: Reasoning =
    complexityScore >= 0.6 ? "high" : complexityScore >= 0.25 ? "low" : "none";
  const promptSize: PromptSize =
    complexityScore >= 0.4 || (hasFileRef && estOutputTokens > 800)
      ? "full"
      : "lite";
  const signals: DispatchSignals = {
    promptChars,
    estOutputTokens,
    hasCode,
    hasFileRef,
    hasDestructive,
    complexityScore,
    isReviewWithInlineDiff,
  };

  return {
    tier,
    reasoning,
    promptSize,
    recommendDispatch,
    rationale: rationaleFor({ recommendDispatch, signals, sensitive }),
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

function rationaleFor(input: {
  recommendDispatch: boolean;
  signals: DispatchSignals;
  sensitive: boolean;
}): string {
  const { recommendDispatch, signals, sensitive } = input;
  if (signals.hasDestructive && signals.promptChars < 200) {
    return `No dispatch: destructive tiny prompt mirrors guard deny at ${signals.promptChars} chars.`;
  }
  if (signals.isReviewWithInlineDiff && signals.estOutputTokens <= 600) {
    return `No dispatch: inline review carve-out keeps ${signals.estOutputTokens} estimated tokens local.`;
  }
  if (recommendDispatch) {
    return `Dispatch: estimated ${signals.estOutputTokens} tokens with complexity ${signals.complexityScore} and fileRef=${signals.hasFileRef}.`;
  }
  if (sensitive) {
    return `No dispatch: sensitive keyword selects premium tier while estimate stays ${signals.estOutputTokens} tokens.`;
  }
  return `No dispatch: estimated ${signals.estOutputTokens} tokens, complexity ${signals.complexityScore}, fileRef=${signals.hasFileRef}.`;
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
