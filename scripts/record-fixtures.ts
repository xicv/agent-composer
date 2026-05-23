#!/usr/bin/env node
// Wave 1 Day 2 — one-shot real-provider fixture recorder.
//
// USAGE:
//   npx tsx scripts/record-fixtures.ts anthropic   # ~$0.0001 GLM
//   npx tsx scripts/record-fixtures.ts cli         # free (agy --print)
//   npx tsx scripts/record-fixtures.ts all
//
// Outputs JSON tapes under tests/fixtures/tapes/. Replay tests under
// tests/providers/ auto-detect the tape and run it through TapeProvider.
//
// NORTH STAR: real calls happen ONCE here, frozen in git, replayed forever
// in vitest. No CI run ever burns API tokens against GLM/agy.

import { applyEnvJson, getEnv } from "../src/config/env.js";
import { AnthropicCompatibleProvider } from "../src/providers/AnthropicCompatibleProvider.js";
import { CLIProvider } from "../src/providers/CLIProvider.js";
import { RecordingProvider } from "../tests/util/recorder.js";

const TAPE_DIR = "tests/fixtures/tapes";
const PROBE_PROMPT =
  "Reply with exactly the two characters 'OK' and nothing else.";

async function recordAnthropic(): Promise<void> {
  applyEnvJson();
  const { ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL } = getEnv();
  if (!ANTHROPIC_AUTH_TOKEN || !ANTHROPIC_BASE_URL) {
    throw new Error(
      "Missing ANTHROPIC_AUTH_TOKEN or ANTHROPIC_BASE_URL in .env.json",
    );
  }
  const model = process.env["COMPOSER_GLM_MODEL"] ?? "glm-4.6";
  const inner = new AnthropicCompatibleProvider({
    baseUrl: ANTHROPIC_BASE_URL,
    apiKey: ANTHROPIC_AUTH_TOKEN,
    model,
  });
  const rec = new RecordingProvider(inner, `${TAPE_DIR}/anthropic-glm.json`);
  const out = await rec.execute({ prompt: PROBE_PROMPT, maxTokens: 32 });
  rec.flush();
  process.stdout.write(
    `[anthropic] tape saved. model=${model} reply=${JSON.stringify(out.text)} in=${out.tokensIn} out=${out.tokensOut}\n`,
  );
}

async function recordCli(): Promise<void> {
  const inner = new CLIProvider({
    cli: ["agy", "--dangerously-skip-permissions", "-p"],
    model: "gemini-3.1-cli",
    timeoutMs: 60_000,
  });
  const rec = new RecordingProvider(inner, `${TAPE_DIR}/cli-agy.json`);
  const out = await rec.execute({ prompt: PROBE_PROMPT });
  rec.flush();
  const preview =
    out.text.length > 200 ? out.text.slice(0, 200) + "..." : out.text;
  process.stdout.write(
    `[cli] tape saved. reply_preview=${JSON.stringify(preview)}\n`,
  );
}

const target = process.argv[2] ?? "all";
const targets = new Set(
  target === "all" ? ["anthropic", "cli"] : [target],
);

async function main(): Promise<void> {
  if (targets.has("anthropic")) await recordAnthropic();
  if (targets.has("cli")) await recordCli();
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`record-fixtures: failed: ${msg}\n`);
  process.exit(1);
});
