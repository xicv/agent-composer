import { formatHandoffForPrompt, readHandoffPacket } from "../util/handoff.js";

export function contextWithHandoff(
  root: string,
  context?: string,
  handoffPath?: string,
): string | undefined {
  const blocks: string[] = [];
  if (handoffPath) {
    const handoff = readHandoffPacket(handoffPath, root);
    blocks.push(formatHandoffForPrompt(handoff));
  }
  if (context) blocks.push(context);
  return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}
