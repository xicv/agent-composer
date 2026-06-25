import { z } from "zod";
import {
  COMPOSER_GOAL,
  COMPOSER_GOAL_STEP,
  GOAL_DESCRIPTION,
  GOAL_STEP_DESCRIPTION,
} from "../server/toolDescriptions.js";
import { buildGoalReport, renderGoalReportMarkdown } from "../util/goalReport.js";
import { clearGoal, isTerminal, readActiveGoal, readGoal, startGoal, stepGoal } from "../util/goal.js";
import type { ServerToolContext } from "./context.js";

export function registerGoalTools(ctx: ServerToolContext): void {
  const { server } = ctx;

  server.registerTool(
    COMPOSER_GOAL,
    {
      description: GOAL_DESCRIPTION,
      inputSchema: z.discriminatedUnion("action", [
        z.object({
          action: z.literal("start"),
          objective: z.string().min(1),
          condition: z.string().min(1),
          checks: z.array(z.object({ name: z.string().min(1), command: z.string().min(1) })).optional(),
          maxTurns: z.number().int().positive().optional(),
          maxCost: z.number().nonnegative().optional(),
          workflow: z.string().optional(),
          mode: z.string().optional(),
          risk: z.string().optional(),
        }),
        z.object({
          action: z.literal("status"),
          goalId: z.string().optional(),
        }),
        z.object({
          action: z.literal("clear"),
          goalId: z.string().optional(),
        }),
        z.object({
          action: z.literal("report"),
          goalId: z.string().optional(),
          format: z.enum(["json", "markdown"]).default("json").optional(),
          includeAudit: z.boolean().default(false).optional(),
          auditLimit: z.number().int().nonnegative().default(100).optional(),
          includeCommands: z.boolean().default(false).optional(),
          includeAuditEvents: z.boolean().default(false).optional(),
        }),
      ]),
      annotations: {
        title: "Composer Goal",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      switch (input.action) {
        case "start": {
          const { action: _action, ...startInput } = input;
          const record = startGoal(ctx.root, startInput);
          const summary = {
            goalId: record.goalId,
            state: record.state,
            turns: record.turns,
            nextAction: { tool: "composer_route_decide", reason: "begin" },
            checks: record.checks,
          };
          return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
        }
        case "status": {
          const record = input.goalId ? readGoal(ctx.root, input.goalId) : readActiveGoal(ctx.root);
          const summary = record
            ? {
                goalId: record.goalId,
                state: record.state,
                turns: record.turns,
                maxTurns: record.maxTurns,
                checks: record.checks,
                lastAction: record.lastAction,
                lastVerdict: record.lastVerdict,
                lastReason: record.lastReason,
              }
            : { state: "none" };
          return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
        }
        case "clear": {
          const prior = input.goalId ? readGoal(ctx.root, input.goalId) : readActiveGoal(ctx.root);
          const record = clearGoal(ctx.root, input.goalId);
          const summary = record
            ? {
                goalId: record.goalId,
                state: record.state,
                changed: prior !== null && !isTerminal(prior.state),
              }
            : { state: "none" };
          return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
        }
        case "report": {
          const {
            goalId,
            format = "json",
            includeAudit = false,
            auditLimit = 100,
            includeCommands = false,
            includeAuditEvents = false,
          } = input;
          const report = buildGoalReport(ctx.root, {
            goalId,
            includeAudit,
            auditLimit,
            includeCommands,
            includeAuditEvents,
          });
          const text = format === "markdown"
            ? renderGoalReportMarkdown(report, { includeCommands, includeAuditEvents })
            : JSON.stringify(report, null, 2);
          return { content: [{ type: "text" as const, text }] };
        }
      }
    },
  );

  server.registerTool(
    COMPOSER_GOAL_STEP,
    {
      description: GOAL_STEP_DESCRIPTION,
      inputSchema: {
        goalId: z.string().optional(),
        signals: z.object({
          checkResults: z.array(z.object({
            name: z.string().min(1),
            passed: z.boolean(),
          })).optional(),
          conditionMet: z.boolean().optional(),
          spentUsd: z.number().nonnegative().optional(),
          failedAttempts: z.number().int().nonnegative().optional(),
          stuck: z.boolean().optional(),
          budgetExtension: z.object({
            maxTurns: z.number().int().positive().optional(),
            maxCost: z.number().nonnegative().optional(),
          }).optional(),
          testsPassed: z.boolean().optional(),
          reviewVerdict: z.string().optional(),
        }).optional(),
      },
      annotations: {
        title: "Composer Goal Step",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const { record, nextAction } = stepGoal(ctx.root, input);
      const summary = {
        state: record.state,
        turns: record.turns,
        nextAction,
        checks: record.checks,
        lastReason: record.lastReason,
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
    },
  );

}
