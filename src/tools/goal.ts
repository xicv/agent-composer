import { z } from "zod";
import {
  COMPOSER_GOAL_CLEAR,
  COMPOSER_GOAL_START,
  COMPOSER_GOAL_STATUS,
  COMPOSER_GOAL_STEP,
  GOAL_CLEAR_DESCRIPTION,
  GOAL_START_DESCRIPTION,
  GOAL_STEP_DESCRIPTION,
  GOAL_STATUS_DESCRIPTION,
} from "../server/toolDescriptions.js";
import { clearGoal, isTerminal, readActiveGoal, readGoal, startGoal, stepGoal } from "../util/goal.js";
import type { ServerToolContext } from "./context.js";

export function registerGoalTools(ctx: ServerToolContext): void {
  const { server } = ctx;

  server.registerTool(
    COMPOSER_GOAL_START,
    {
      description: `${GOAL_START_DESCRIPTION} Use when storing objective/condition and check command strings as data only - the substrate never runs them.`,
      inputSchema: {
        objective: z.string().min(1),
        condition: z.string().min(1),
        checks: z.array(z.object({ name: z.string().min(1), command: z.string().min(1) })).optional(),
        maxTurns: z.number().int().positive().optional(),
        maxCost: z.number().nonnegative().optional(),
        workflow: z.string().optional(),
        mode: z.string().optional(),
        risk: z.string().optional(),
      },
      annotations: {
        title: "Composer Goal Start",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const record = startGoal(ctx.root, input);
      const summary = {
        goalId: record.goalId,
        state: record.state,
        turns: record.turns,
        nextAction: { tool: "composer_route_decide", reason: "begin" },
        checks: record.checks,
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
    },
  );

  server.registerTool(
    COMPOSER_GOAL_STATUS,
    {
      description: GOAL_STATUS_DESCRIPTION,
      inputSchema: {
        goalId: z.string().optional(),
      },
      annotations: {
        title: "Composer Goal Status",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ goalId }) => {
      const record = goalId ? readGoal(ctx.root, goalId) : readActiveGoal(ctx.root);
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

  server.registerTool(
    COMPOSER_GOAL_CLEAR,
    {
      description: GOAL_CLEAR_DESCRIPTION,
      inputSchema: {
        goalId: z.string().optional(),
      },
      annotations: {
        title: "Composer Goal Clear",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ goalId }) => {
      const prior = goalId ? readGoal(ctx.root, goalId) : readActiveGoal(ctx.root);
      const record = clearGoal(ctx.root, goalId);
      const summary = record
        ? {
            goalId: record.goalId,
            state: record.state,
            changed: prior !== null && !isTerminal(prior.state),
          }
        : { state: "none" };
      return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
    },
  );
}
