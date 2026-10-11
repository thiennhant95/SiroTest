/**
 * @vv/ai — P2 AI helpers (deterministic rules first, LLM only with a key —
 * or keyless via `AI_PROVIDER=kilo`).
 *
 * Engine honesty: every entry point reports `engine: 'rules' | 'llm'`.
 * Without `AI_API_KEY` (and without `AI_PROVIDER=kilo`), everything runs
 * locally and reports `'rules'`.
 */
export * from "./provider.js";
export * from "./nl-to-steps.js";
export * from "./gherkin-vi.js";
export * from "./explain-failure.js";
export * from "./cleanup-recording.js";
