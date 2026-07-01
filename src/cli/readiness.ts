import { runDoctor } from "./doctor.js";
import { buildStatus } from "./status.js";
import {
  buildDailyReadiness,
  dailyReadinessExitCode,
  renderDailyReadinessHuman,
  type DailyReadiness,
} from "../util/dailyReadiness.js";

export async function runReadiness(
  cwd: string,
  opts: { json?: boolean } = {},
): Promise<DailyReadiness> {
  const status = buildStatus(cwd);
  const doctor = await runDoctor({
    cwd,
    verbose: false,
    configPath: status.config.exists ? status.config.path : undefined,
  });
  const readiness = buildDailyReadiness({ status, doctor });
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(readiness, null, 2)}\n`);
  } else {
    process.stdout.write(renderDailyReadinessHuman(readiness));
  }
  process.exitCode = dailyReadinessExitCode(readiness);
  return readiness;
}
