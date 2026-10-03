/**
 * @vv/ai — P2 AI helpers (deterministic rules first, LLM only with a key).
 *
 * Engine honesty: every entry point reports `engine: 'rules' | 'llm'`.
 * Without `AI_API_KEY`, everything runs locally and reports `'rules'`.
 */
export * from "./provider.js";
export * from "./nl-to-steps.js";
export * from "./explain-failure.js";
export * from "./cleanup-recording.js";
