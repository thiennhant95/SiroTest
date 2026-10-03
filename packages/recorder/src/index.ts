export * from './types.js';
export * from './sessionManager.js';
export * from './capture.js';
export * from './normalize.js';
export * from './bridge.js';
export * from './browser.js';
export * from './emitter.js';
// Re-exported so server code can type locator payloads without depending on
// the locator engine directly (single workspace edge: server -> recorder).
export type { ElementMetadata, LocatorCandidate, ResolvedLocator } from '@playwright-vv/locator-engine';
