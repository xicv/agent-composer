import { existsSync, statSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../config/loader.js";

export interface StatusReport {
  configPath: string;
  configExists: boolean;
  codexReview: boolean;
  codexLifecycle: boolean;
  oracleConfigured: boolean;
  oracleDefaultMode?: string;
  oracleRequireExplicitTag?: boolean;
  gitHookInstalled: boolean;
}

export function buildStatus(cwd: string): StatusReport {
  const configRelPath = process.env["COMPOSER_CONFIG"] ?? "composer.config.json";
  const configPath = resolve(cwd, configRelPath);

  if (!existsSync(configPath)) {
    return {
      configPath,
      configExists: false,
      codexReview: false,
      codexLifecycle: false,
      oracleConfigured: false,
      gitHookInstalled: false,
    };
  }

  let config;
  try {
    config = loadConfig(configPath);
  } catch {
    return {
      configPath,
      configExists: false,
      codexReview: false,
      codexLifecycle: false,
      oracleConfigured: false,
      gitHookInstalled: false,
    };
  }

  const codexReview = Boolean(config.codexReview?.enabled);
  const codexLifecycle = Boolean(config.codexLifecycle?.enabled);
  const oracleConfigured = Boolean(config.roles?.oraclePlanner);
  const oracleDefaultMode = config.oracle?.defaultMode;
  const oracleRequireExplicitTag = config.oracle?.requireExplicitTag;

  const gitHookInstalled = resolveGitHookInstalled(cwd);

  const report: StatusReport = {
    configPath,
    configExists: true,
    codexReview,
    codexLifecycle,
    oracleConfigured,
    gitHookInstalled,
  };
  if (oracleDefaultMode !== undefined) report.oracleDefaultMode = oracleDefaultMode;
  if (oracleRequireExplicitTag !== undefined) report.oracleRequireExplicitTag = oracleRequireExplicitTag;
  return report;
}

function resolveGitHookInstalled(cwd: string): boolean {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--git-path", "hooks/pre-commit"], {
    encoding: "utf8",
    timeout: 10000,
  });
  let hookPath: string;
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    hookPath = resolve(cwd, ".git", "hooks", "pre-commit");
  } else {
    hookPath = resolve(cwd, result.stdout.trim());
  }

  if (!existsSync(hookPath)) return false;
  try {
    const stat = statSync(hookPath);
    if (!stat.isFile()) return false;
    const text = readFileSync(hookPath, "utf8");
    return text.includes("precommit_codex_review.sh");
  } catch {
    return false;
  }
}

export function runStatus(cwd: string): void {
  const report = buildStatus(cwd);
  process.stdout.write(`composer status\n`);
  process.stdout.write(`  config:           ${report.configPath} (${report.configExists ? "found" : "missing"})\n`);
  if (report.configExists) {
    process.stdout.write(`  codexReview:      ${report.codexReview ? "enabled" : "disabled"}\n`);
    process.stdout.write(`  codexLifecycle:   ${report.codexLifecycle ? "enabled" : "disabled"}\n`);
    process.stdout.write(`  oraclePlanner:    ${report.oracleConfigured ? "configured" : "not configured"}\n`);
    if (report.oracleDefaultMode !== undefined) {
      process.stdout.write(`  oracle.defaultMode: ${report.oracleDefaultMode}\n`);
    }
    if (report.oracleRequireExplicitTag !== undefined) {
      process.stdout.write(`  oracle.requireExplicitTag: ${String(report.oracleRequireExplicitTag)}\n`);
    }
  }
  process.stdout.write(`  git pre-commit:   ${report.gitHookInstalled ? "installed" : "not installed"}\n`);
}
