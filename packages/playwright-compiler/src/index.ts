/**
 * Public entry point of `@vietvang/playwright-compiler` (P0).
 */
export { COMPILER_VERSION, MAX_DATASET_ROWS, SUPPORTED_STEP_TYPES, P1_WAVE2_STEP_TYPES, P2_STEP_TYPES, PLUGIN_TYPE_PATTERN, FILE_PATHS_ENV, FILE_PATHS_ENV_ALIAS, BASELINES_ENV, UPDATE_BASELINES_ENV, VISUAL_DEFAULT_THRESHOLD } from './compiler';
export type {
  ActionParameter,
  ActionsContext,
  CompileOptions,
  DataSet,
  PluginCompileInfo,
  ReusableAction,
  TestDefinition,
  TestStep,
} from './compiler';
export {
  compileTest,
  compileStepBody,
  defaultStepName,
  resolveDataset,
  sanitizeVisualFileName,
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
