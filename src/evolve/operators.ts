// Wave 3 Step 2 — mutation operators for self-evolve loop.
//
// 5 operators kept (Karpathy autoresearch empirical keep-rates):
//   add_counterexample   100%
//   tighten_language      67%
//   add_constraint        50%
//   add_negative_example  50%
//   reflect_and_rewrite   GEPA core
//
// Skipped: restructure + remove_bloat (both 0% keep-rate). Bloat drift
// is countered by lengthPenalty.ts, not by a remove_bloat operator.

export interface OperatorContext {
  counterexample?: string;
  constraint?: string;
  negativeExample?: string;
  /** GEPA reflection LM callback. Returns rewritten skill text. */
  reflect?: (text: string, ctx: OperatorContext) => Promise<string>;
  /** Preflight ecosystem snapshot, surfaced into reflect prompt by runner. */
  currentEcosystem?: string;
}

export interface OperatorMeta {
  name: string;
  /** Empirical keep-rate from Karpathy autoresearch dataset. */
  keepRate: number;
  apply: (skill: string, ctx: OperatorContext) => Promise<string>;
}

const HEDGES = /\b(probably|maybe|perhaps|might|consider(?:ing)?|kind of|sort of)\b\s*/gi;
const SOFT_SUBJECT = /\b(you should|you could|you might|you can)\s+/gi;

export function addCounterexample(skill: string, ctx: OperatorContext): string {
  const ex = ctx.counterexample?.trim();
  if (!ex) return skill;
  const header = "## Counterexamples";
  if (skill.includes(header)) {
    return skill.replace(header, `${header}\n\n- ${ex}\n`).replace(/\n\n- ${ex}\n\n/, `\n\n- ${ex}\n`);
  }
  const sep = skill.endsWith("\n") ? "\n" : "\n\n";
  return `${skill}${sep}${header}\n\n- ${ex}\n`;
}

export function tightenLanguage(skill: string, _ctx: OperatorContext): string {
  HEDGES.lastIndex = 0;
  SOFT_SUBJECT.lastIndex = 0;
  if (!HEDGES.test(skill) && !SOFT_SUBJECT.test(skill)) {
    HEDGES.lastIndex = 0;
    SOFT_SUBJECT.lastIndex = 0;
    return skill;
  }
  HEDGES.lastIndex = 0;
  SOFT_SUBJECT.lastIndex = 0;
  return skill
    .replace(SOFT_SUBJECT, "")
    .replace(HEDGES, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ ([.,;:])/g, "$1")
    .trim();
}

export function addConstraint(skill: string, ctx: OperatorContext): string {
  const c = ctx.constraint?.trim();
  if (!c) return skill;
  const header = "## Constraints";
  const line = `- ${c}`;
  if (skill.includes(header)) {
    if (skill.includes(line)) return skill;
    return skill.replace(header, `${header}\n\n${line}`);
  }
  const sep = skill.endsWith("\n") ? "\n" : "\n\n";
  return `${skill}${sep}${header}\n\n${line}\n`;
}

export function addNegativeExample(skill: string, ctx: OperatorContext): string {
  const ne = ctx.negativeExample?.trim();
  if (!ne) return skill;
  const line = `DO NOT ${ne}`;
  if (skill.includes(line)) return skill;
  const sep = skill.endsWith("\n") ? "\n" : "\n\n";
  return `${skill}${sep}${line}\n`;
}

export async function reflectAndRewrite(
  skill: string,
  ctx: OperatorContext,
): Promise<string> {
  if (!ctx.reflect) return skill;
  return ctx.reflect(skill, ctx);
}

export const OPERATORS: ReadonlyArray<OperatorMeta> = [
  {
    name: "add_counterexample",
    keepRate: 1.0,
    apply: async (s, c) => addCounterexample(s, c),
  },
  {
    name: "tighten_language",
    keepRate: 0.67,
    apply: async (s, c) => tightenLanguage(s, c),
  },
  {
    name: "add_constraint",
    keepRate: 0.5,
    apply: async (s, c) => addConstraint(s, c),
  },
  {
    name: "add_negative_example",
    keepRate: 0.5,
    apply: async (s, c) => addNegativeExample(s, c),
  },
  {
    name: "reflect_and_rewrite",
    keepRate: 0.0, // GEPA core; keep-rate measured live, not pre-seeded.
    apply: reflectAndRewrite,
  },
];

export function pickOperator(index: number): OperatorMeta {
  if (index < 0 || !Number.isInteger(index)) {
    throw new Error(`pickOperator: index must be non-negative integer, got ${index}`);
  }
  return OPERATORS[index % OPERATORS.length]!;
}
