import { z } from "zod";
import { COMPOSER_SESSION_GET, COMPOSER_SESSION_SET, SESSION_GET_DESCRIPTION, SESSION_SET_DESCRIPTION } from "../server/toolDescriptions.js";
import type { ServerToolContext } from "./context.js";

export function registerSessionTools(ctx: ServerToolContext): void {
  const { server } = ctx;
  server.registerTool(
    COMPOSER_SESSION_SET,
    {
      description: SESSION_SET_DESCRIPTION,
      inputSchema: {
        clear: z.boolean().optional(),
        mode: z.enum(["fast", "balanced", "strict"]).optional(),
        oracle: z.object({
          enabled: z.boolean().optional(),
          defaultMode: z.enum(["auto","quick","standard","deep","plan","review","debug","research"]).optional(),
          requireExplicitTag: z.boolean().optional(),
        }).strict().optional(),
        profile: z.string().min(1).optional(),
      },
      annotations: { title: "Composer Session Set", readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ clear, mode, oracle, profile }) => {
      if (clear) ctx.resetSession();
      const patch: Record<string, unknown> = {};
      if (mode !== undefined) patch["mode"] = mode;
      if (oracle !== undefined) patch["oracle"] = oracle;
      if (profile !== undefined) patch["profile"] = profile;
      const next = Object.keys(patch).length > 0 ? ctx.setSession(patch as Parameters<typeof ctx.setSession>[0]) : ctx.getSession();
      return { content: [{ type: "text" as const, text: JSON.stringify(next, null, 2) }] };
    },
  );
  server.registerTool(
    COMPOSER_SESSION_GET,
    {
      description: SESSION_GET_DESCRIPTION,
      inputSchema: {},
      annotations: { title: "Composer Session Get", readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true },
    },
    async () => ({ content: [{ type: "text" as const, text: JSON.stringify(ctx.getSession(), null, 2) }] }),
  );
}
