/**
 * Explicit versioned migrations for TestDefinition JSON.
 * P0 only knows schemaVersion "1.0" — anything else throws and must gain an
 * explicit, deterministic, tested migration before support.
 */
import type { TestDefinition } from "./types";
import { CURRENT_SCHEMA_VERSION } from "./types";
import { testDefinitionSchema } from "./schemas";

export { CURRENT_SCHEMA_VERSION };

export class UnsupportedSchemaVersionError extends Error {
  readonly version: unknown;
  constructor(version: unknown) {
    super(
      `Unsupported TestDefinition schemaVersion: ${JSON.stringify(version)}. ` +
        `P0 supports only "${CURRENT_SCHEMA_VERSION}". Add an explicit migration.`,
    );
    this.name = "UnsupportedSchemaVersionError";
    this.version = version;
  }
}

/**
 * Migrate an unknown payload to the current TestDefinition.
 * - If `schemaVersion === "1.0"`: validate strictly, return parsed copy.
 * - Otherwise: throw UnsupportedSchemaVersionError (never mutate silently).
 * - Never mutates the input object.
 */
export function migrateTestDefinition(input: unknown): TestDefinition {
  const version =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)["schemaVersion"]
      : undefined;
  if (version !== CURRENT_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(version);
  }
  // zod parse returns a new object; input untouched.
  return testDefinitionSchema.parse(input);
}
