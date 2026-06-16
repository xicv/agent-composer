/** Default opt-in Oracle planning role written by `init --oracle` and by
 *  composer_config_set({ oracle: { enabled: true } }). Single source of truth. */
export const ORACLE_BROWSER_TIMEOUT_MS = 20 * 60_000;

export const ORACLE_PLANNER_ROLE = {
  provider: "cli",
  cli: ["bash", "scripts/oracle-plan-mcp.sh", "--mode", "auto", "--"],
  timeoutMs: ORACLE_BROWSER_TIMEOUT_MS,
  retries: 0,
  maxResultChars: 14000,
} as const;
