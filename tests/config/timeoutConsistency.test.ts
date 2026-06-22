import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseConfig } from "../../src/config/loader.js";
import {
  ORACLE_BROWSER_TIMEOUT_MS,
  ORACLE_PLANNER_ROLE,
} from "../../src/config/oracleRole.js";

describe("timeout consistency", () => {
  it("keeps the default Oracle CLI role aligned with the browser timeout ceiling", () => {
    expect(ORACLE_PLANNER_ROLE.timeoutMs).toBe(ORACLE_BROWSER_TIMEOUT_MS);
  });

  it("keeps the checked-in Oracle config at the shared browser/CLI boundary", () => {
    const cfg = parseConfig(JSON.parse(readFileSync("composer.config.json", "utf8")));
    expect(cfg.roles.oraclePlanner?.timeoutMs).toBe(ORACLE_BROWSER_TIMEOUT_MS);
  });

  it("keeps the checked-in sample executor profile valid and inert", () => {
    const cfg = parseConfig(JSON.parse(readFileSync("composer.config.json", "utf8")));

    expect(cfg.activeProfile).toBeUndefined();
    expect(cfg.profiles?.["glm-coder"]?.roles?.coder?.provider).toBe("anthropic");
    expect(cfg.profiles?.["glm-coder"]?.fallbacks?.coderCli).toEqual(["coder"]);
  });
});
