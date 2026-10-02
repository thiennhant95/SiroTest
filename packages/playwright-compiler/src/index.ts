/**
 * Public entry point of `@vietvang/playwright-compiler` (P0).
 */
export { COMPILER_VERSION, MAX_DATASET_ROWS, SUPPORTED_STEP_TYPES } from './compiler';
export type {
  ActionParameter,
  ActionsContext,
  CompileOptions,
  DataSet,
  ReusableAction,
  TestDefinition,
  TestStep,
} from './compiler';
export {
  compileTest,
  compileStepBody,
  defaultStepName,
  resolveDataset,
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
  ROW_PATTERN,
  DATASET_SECRET_NOTE,
  parseTemplate,
  extractVariableNames,
  extractRowNames,
  hasVariable,
  hasRowReference,
  escapeString,
  stringLiteral,
  compileValueExpression,
  redactSecrets,
} from './variables';
export type { TemplatePart } from './variables';
