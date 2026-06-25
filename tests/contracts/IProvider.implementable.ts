// Wave 0 smoke check B — type-level test only, never executed.
// Proves IProvider is implementable with a non-trivial mock shape.
// If this file fails `tsc --noEmit`, Wave 1 F1.3 (MockProvider) would fail too.

import type { IProvider } from "../../src/providers/IProvider.js";

const mock: IProvider = {
  id: "mock",
  modelLabel: "wave0-smoke-mock",
  healthCheck: async () => true,
  execute: async ({ prompt, context, maxTokens }) => ({
    text: `echo: ${prompt}${context ? ` | ctx: ${context}` : ""}${
      maxTokens !== undefined ? ` | cap: ${maxTokens}` : ""
    }`,
    tokensIn: prompt.length,
    tokensOut: prompt.length,
  }),
};

// Also confirm `id` is narrowed (compile fails if union widens accidentally):
const _idCheck: "anthropic" | "cli" | "mock" = mock.id;

export { mock, _idCheck };
