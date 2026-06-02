import { z } from "zod";

import {
  classifyDispatch,
  neutralDispatchHint,
  type DispatchHint,
} from "../util/dispatchHint.js";

const HookInputSchema = z.object({
  tool_input: z.object({
    prompt: z.string().optional(),
    subagent_type: z.string().optional(),
    description: z.string().optional(),
  }).optional(),
}).passthrough();

export function computeHintFromHookInput(raw: string): DispatchHint {
  try {
    if (raw.trim().length === 0) return neutralDispatchHint();

    const parsedJson = JSON.parse(raw) as unknown;
    const parsed = HookInputSchema.safeParse(parsedJson);
    if (!parsed.success || parsed.data.tool_input === undefined) {
      return neutralDispatchHint();
    }

    const prompt = parsed.data.tool_input.prompt;
    if (prompt === undefined || prompt.trim().length === 0) {
      return neutralDispatchHint();
    }

    return classifyDispatch({
      prompt,
      subagentType: parsed.data.tool_input.subagent_type,
      description: parsed.data.tool_input.description,
    });
  } catch {
    return neutralDispatchHint();
  }
}

async function main(): Promise<void> {
  try {
    const raw = await readStdin();
    process.stdout.write(`${JSON.stringify(computeHintFromHookInput(raw))}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify(neutralDispatchHint())}\n`);
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      raw += chunk;
    });
    process.stdin.on("end", () => {
      resolve(raw);
    });
    process.stdin.on("error", (error) => {
      reject(error);
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify(neutralDispatchHint())}\n`);
    process.exit(0);
  });
}
