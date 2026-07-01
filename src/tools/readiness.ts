import { runDoctor } from "../cli/doctor.js";
import { buildStatus, statusEnvelope } from "../cli/status.js";
import {
  buildDailyReadiness,
  type DailyReadiness,
} from "../util/dailyReadiness.js";
import {
  COMPOSER_DAILY_READINESS,
  DAILY_READINESS_DESCRIPTION,
} from "../server/toolDescriptions.js";
import type { ServerToolContext } from "./context.js";

export function registerReadinessTools(ctx: ServerToolContext): void {
  ctx.server.registerTool(
    COMPOSER_DAILY_READINESS,
    {
      description: DAILY_READINESS_DESCRIPTION,
      inputSchema: {},
      annotations: {
        title: "Composer Daily Readiness",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    async () => {
      const status = buildStatus(ctx.root);
      const nowMs = Date.now();
      status.active.foreground = ctx.activeRuns.list().map((r) => ({
        tool: r.tool,
        providerLabel: r.providerLabel,
        providerRole: r.providerRole,
        ageSeconds: Math.max(0, Math.floor((nowMs - Date.parse(r.startedAt)) / 1000)),
      }));
      const doctor = await runDoctor({
        cwd: ctx.root,
        verbose: false,
        configPath: status.config.exists ? status.config.path : undefined,
      });
      const session = ctx.getSession();
      const sv = Object.keys(session).length > 0 ? session : undefined;
      const envelopedStatus = statusEnvelope(status, sv);
      const readiness: DailyReadiness & { status: typeof envelopedStatus; session?: typeof sv } = {
        ...buildDailyReadiness({
          status,
          doctor,
          statusLine: envelopedStatus.line,
        }),
        status: envelopedStatus,
        session: sv,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(readiness, null, 2) }],
      };
    },
  );
}
