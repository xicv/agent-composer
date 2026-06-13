export type ModeName = "fast" | "balanced" | "strict";
export const MODE_NAMES: readonly ModeName[] = ["fast", "balanced", "strict"];
export function isModeName(value: string): value is ModeName {
  return (MODE_NAMES as readonly string[]).includes(value);
}
export interface ModePatch {
  codexLifecycle: Record<string, unknown>;
  codexReview: Record<string, unknown>;
}
/** Built-in presets. Modes only adjust the lifecycle + review GATES; they do
 *  not touch provider roles or the Oracle lane. */
export function modePatch(mode: ModeName): ModePatch {
  switch (mode) {
    case "fast":
      return {
        codexLifecycle: { enabled: false },
        codexReview: { enabled: false, preCommitHook: { enabled: false } },
      };
    case "balanced":
      return {
        codexLifecycle: { enabled: true, mode: "ask" },
        codexReview: { enabled: true, preCommitHook: { enabled: true, failClosed: false } },
      };
    case "strict":
      return {
        codexLifecycle: { enabled: true, mode: "auto" },
        codexReview: { enabled: true, preCommitHook: { enabled: true, failClosed: true } },
      };
  }
}
