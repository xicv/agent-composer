import { describe, it, expect } from "vitest";
import {
  addCounterexample,
  tightenLanguage,
  addConstraint,
  addNegativeExample,
  reflectAndRewrite,
  OPERATORS,
  pickOperator,
  type OperatorContext,
} from "../../src/evolve/operators.js";

const baseSkill = `---
name: composer-mastermind
---

# composer-mastermind

DO NOT use Edit directly. ALWAYS dispatch via Task.
`;

describe("operators — addCounterexample", () => {
  it("appends a Counterexamples section when one is missing", () => {
    const ctx: OperatorContext = {
      counterexample: "User asked to fix typo → dispatched needlessly",
    };
    const out = addCounterexample(baseSkill, ctx);
    expect(out).toContain("## Counterexamples");
    expect(out).toContain("User asked to fix typo");
  });

  it("extends an existing Counterexamples section with a bullet", () => {
    const skill = baseSkill + "\n## Counterexamples\n\n- Old example\n";
    const out = addCounterexample(skill, { counterexample: "New example" });
    expect(out).toContain("- Old example");
    expect(out).toContain("- New example");
    expect(out.match(/## Counterexamples/g)).toHaveLength(1);
  });

  it("is a no-op when counterexample is empty", () => {
    expect(addCounterexample(baseSkill, { counterexample: "" })).toBe(baseSkill);
    expect(addCounterexample(baseSkill, {})).toBe(baseSkill);
  });
});

describe("operators — tightenLanguage", () => {
  it("strips hedges and soft-subject framing to leave directive text", () => {
    const skill = "You should probably use Task instead of Edit.";
    const out = tightenLanguage(skill, {});
    expect(out).not.toMatch(/probably|you should/i);
    expect(out).toBe("use Task instead of Edit.");
  });

  it("leaves already-directive text unchanged", () => {
    const skill = "Use Task. Never Edit.";
    expect(tightenLanguage(skill, {})).toBe(skill);
  });
});

describe("operators — addConstraint", () => {
  it("appends a new constraint bullet under Constraints", () => {
    const ctx: OperatorContext = { constraint: "NEVER spawn >1 worker per task" };
    const out = addConstraint(baseSkill, ctx);
    expect(out).toContain("## Constraints");
    expect(out).toContain("- NEVER spawn >1 worker per task");
  });

  it("dedupes when constraint already exists verbatim", () => {
    const skill = baseSkill + "\n## Constraints\n\n- NEVER use Bash\n";
    const out = addConstraint(skill, { constraint: "NEVER use Bash" });
    expect(out.match(/- NEVER use Bash/g)).toHaveLength(1);
  });

  it("is a no-op when constraint missing", () => {
    expect(addConstraint(baseSkill, {})).toBe(baseSkill);
  });
});

describe("operators — addNegativeExample", () => {
  it("adds a 'DO NOT' line to the skill body", () => {
    const ctx: OperatorContext = { negativeExample: "Edit src/providers/IProvider.ts" };
    const out = addNegativeExample(baseSkill, ctx);
    expect(out).toContain("DO NOT Edit src/providers/IProvider.ts");
  });

  it("is a no-op when missing", () => {
    expect(addNegativeExample(baseSkill, {})).toBe(baseSkill);
  });
});

describe("operators — reflectAndRewrite (GEPA core)", () => {
  it("delegates to ctx.reflect callback and returns its result", async () => {
    const ctx: OperatorContext = {
      reflect: async (text) => text + "\n\n[rewritten]",
    };
    const out = await reflectAndRewrite(baseSkill, ctx);
    expect(out).toContain("[rewritten]");
  });

  it("returns original text when no reflect callback supplied", async () => {
    expect(await reflectAndRewrite(baseSkill, {})).toBe(baseSkill);
  });
});

describe("operators — round-robin registry", () => {
  it("exposes exactly the 5 in-budget operators (skips restructure + remove_bloat)", () => {
    const names = OPERATORS.map((o) => o.name);
    expect(names).toEqual([
      "add_counterexample",
      "tighten_language",
      "add_constraint",
      "add_negative_example",
      "reflect_and_rewrite",
    ]);
  });

  it("pickOperator cycles round-robin by index", () => {
    expect(pickOperator(0).name).toBe("add_counterexample");
    expect(pickOperator(4).name).toBe("reflect_and_rewrite");
    expect(pickOperator(5).name).toBe("add_counterexample");
    expect(pickOperator(12).name).toBe(OPERATORS[12 % 5]!.name);
  });

  it("pickOperator rejects negative index", () => {
    expect(() => pickOperator(-1)).toThrow(/non-negative/);
  });
});
