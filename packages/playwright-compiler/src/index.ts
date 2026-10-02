/**
 * Public entry point of `@vietvang/playwright-compiler` (P0).
 */
export { COMPILER_VERSION, SUPPORTED_STEP_TYPES } from './compiler';
export type { TestDefinition, TestStep } from './compiler';
export {
  compileTest,
  compileStepBody,
  defaultStepName,
  InvalidDefinitionError,
  UnsupportedStepError,
} from './compiler';
export type { LocatorCandidate, LocatorSpec } from './locatorToExpression';
export {
  locatorToExpression,
  describeLocator,
  UnsupportedLocatorError,
} from './locatorToExpression';
export {
  VARIABLE_PATTERN,
  parseTemplate,
  extractVariableNames,
  hasVariable,
  escapeString,
  stringLiteral,
  compileValueExpression,
  redactSecrets,
} from './variables';
export type { TemplatePart } from './variables';
