// Wave 4 M0.3 — composer init bootstrap CLI.
//
// Scaffolds a consumer project so it can launch the composer MCP server:
//   - .claude/ directory
//   - composer.config.json (default roles + spendAuthorization caps)
//   - .env.json placeholder (gitignored)
//   - .gitignore entry for .env.json
//   - .claude/settings.json mcpServers["composer"] entry
//
// Idempotent: each step checks existing state and skips if already correct.
// Never overwrites a present, non-default file (no --force flag in this slice).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type InitStepStatus = "created" | "updated" | "skipped";

export interface InitStep {
  name: string;
  status: InitStepStatus;
  path?: string;
  reason?: string;
}

export interface InitOptions {
  cwd: string;
  /** When false, do not print to stdout. Defaults true. */
  verbose?: boolean;
  /** Override the default base URL written into .env.json stub. */
  defaultBaseUrl?: string;
  /** Override the default auth token placeholder. */
  defaultAuthToken?: string;
}

export interface InitResult {
  steps: InitStep[];
}

const DEFAULT_COMPOSER_CONFIG = {
  roles: {
    researcher: { provider: "cli", cli: ["agy", "--dangerously-skip-permissions", "-p"] },
    coder: { provider: "anthropic", baseUrl: "https://api.z.ai/api/anthropic", apiKeyEnv: "ANTHROPIC_AUTH_TOKEN" },
    reviewer: { provider: "cli", cli: ["agy", "--dangerously-skip-permissions", "-p"] },
  },
  spendAuthorization: {
    mode: "interactive",
    maxUsdPerCall: 0.5,
    maxUsdPerSession: 5.0,
  },
};

const DEFAULT_ENV_TEMPLATE = (baseUrl: string, token: string) => ({
  ANTHROPIC_BASE_URL: baseUrl,
  ANTHROPIC_AUTH_TOKEN: token,
});

const DEFAULT_BASE_URL = "https://api.z.ai/api/anthropic";
const DEFAULT_AUTH_TOKEN_PLACEHOLDER = "<replace-with-your-glm-or-anthropic-compatible-token>";

const DEFAULT_MCP_SETTINGS = {
  mcpServers: {
    composer: {
      command: "npx",
      args: ["-y", "agent-composer"],
    },
  },
};

export function runInit(opts: InitOptions): InitResult {
  const cwd = resolve(opts.cwd);
  const steps: InitStep[] = [];
  const log = (...args: unknown[]) => {
    if (opts.verbose !== false) process.stdout.write(args.map(String).join(" ") + "\n");
  };

  steps.push(ensureClaudeDir(cwd));
  steps.push(writeComposerConfig(cwd));
  steps.push(
    writeEnvJsonStub(
      cwd,
      opts.defaultBaseUrl ?? DEFAULT_BASE_URL,
      opts.defaultAuthToken ?? DEFAULT_AUTH_TOKEN_PLACEHOLDER,
    ),
  );
  steps.push(ensureEnvGitignored(cwd));
  steps.push(wireMcpServer(cwd));

  for (const s of steps) {
    const tag = s.status === "created" ? "+" : s.status === "updated" ? "~" : "=";
    log(`  ${tag} ${s.name}${s.path ? ` (${s.path})` : ""}${s.reason ? ` — ${s.reason}` : ""}`);
  }
  log("");
  log("composer init: done.");
  log("");
  log("Next steps:");
  log("  1. Fill .env.json with real ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL.");
  log("  2. Launch Claude Code: claude");
  log("  3. Verify the orchestrator skill loads: /composer-mastermind");
  log("  4. Smoke-test the autoresearch loop: /evolve --eval-mode synthetic");

  return { steps };
}

function ensureClaudeDir(cwd: string): InitStep {
  const path = join(cwd, ".claude");
  if (existsSync(path)) return { name: ".claude/ directory", status: "skipped", path, reason: "already exists" };
  mkdirSync(path, { recursive: true });
  return { name: ".claude/ directory", status: "created", path };
}

function writeComposerConfig(cwd: string): InitStep {
  const path = join(cwd, "composer.config.json");
  if (existsSync(path)) {
    return { name: "composer.config.json", status: "skipped", path, reason: "already exists; not overwritten" };
  }
  writeFileSync(path, JSON.stringify(DEFAULT_COMPOSER_CONFIG, null, 2) + "\n", "utf8");
  return { name: "composer.config.json", status: "created", path };
}

function writeEnvJsonStub(cwd: string, baseUrl: string, token: string): InitStep {
  const path = join(cwd, ".env.json");
  if (existsSync(path)) {
    return { name: ".env.json", status: "skipped", path, reason: "already exists; not overwritten" };
  }
  writeFileSync(path, JSON.stringify(DEFAULT_ENV_TEMPLATE(baseUrl, token), null, 2) + "\n", "utf8");
  return { name: ".env.json", status: "created", path, reason: "placeholder — fill before launching claude" };
}

function ensureEnvGitignored(cwd: string): InitStep {
  const path = join(cwd, ".gitignore");
  const entry = ".env.json";
  if (!existsSync(path)) {
    writeFileSync(path, `${entry}\n`, "utf8");
    return { name: ".gitignore", status: "created", path, reason: `added ${entry}` };
  }
  const current = readFileSync(path, "utf8");
  const hasEntry = current.split(/\r?\n/).some((line) => line.trim() === entry);
  if (hasEntry) return { name: ".gitignore", status: "skipped", path, reason: `${entry} already listed` };
  const next = current.endsWith("\n") ? current + entry + "\n" : current + "\n" + entry + "\n";
  writeFileSync(path, next, "utf8");
  return { name: ".gitignore", status: "updated", path, reason: `appended ${entry}` };
}

function wireMcpServer(cwd: string): InitStep {
  const path = join(cwd, ".claude", "settings.json");
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify(DEFAULT_MCP_SETTINGS, null, 2) + "\n", "utf8");
    return { name: ".claude/settings.json", status: "created", path, reason: "mcpServers.composer wired" };
  }
  const current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const mcpServers = (current["mcpServers"] as Record<string, unknown> | undefined) ?? {};
  if (mcpServers["composer"]) {
    return { name: ".claude/settings.json", status: "skipped", path, reason: "mcpServers.composer already wired" };
  }
  const merged = {
    ...current,
    mcpServers: { ...mcpServers, composer: DEFAULT_MCP_SETTINGS.mcpServers.composer },
  };
  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n", "utf8");
  return { name: ".claude/settings.json", status: "updated", path, reason: "mcpServers.composer wired" };
}
