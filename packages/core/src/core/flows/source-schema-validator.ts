/**
 * Source Schema Validator
 *
 * Validates parsed frontmatter against a schema's property type declarations.
 * Used at the export pipeline entry to warn when source data doesn't match
 * the declared universal schema (e.g., tools is a string instead of an array).
 */

import type { DetectionSchema, SchemaProperty } from '../install/detection-types.js';

/**
 * Validate parsed frontmatter against a schema's property type declarations.
 * Returns an array of human-readable warning strings.
 *
 * Only checks type mismatches for properties that exist in both the data and the schema.
 * Does NOT enforce required fields or complex constraints.
 *
 * @param data - Parsed frontmatter object
 * @param schema - Detection schema with property type declarations
 * @param filePath - Source file path for warning messages
 * @returns Array of warning strings (empty if valid)
 */
export function validateFrontmatterAgainstSchema(
  data: Record<string, any>,
  schema: DetectionSchema,
  filePath: string,
): string[] {
  const warnings: string[] = [];
  if (!schema.properties) return warnings;

  for (const [key, schemaProp] of Object.entries(schema.properties)) {
    if (!(key in data)) continue;
    const warning = checkTypeMatch(data[key], schemaProp, key, filePath);
    if (warning) {
      warnings.push(warning);
    }
  }
  return warnings;
}

/**
 * Check if a value's runtime type matches the schema's declared type.
 */
function checkTypeMatch(
  value: any,
  schemaProp: SchemaProperty,
  fieldName: string,
  filePath: string,
): string | null {
  if (!schemaProp.type) return null;

  const expectedTypes = Array.isArray(schemaProp.type)
    ? schemaProp.type
    : [schemaProp.type];

  const actualType = getJsonSchemaType(value);

  if (!expectedTypes.includes(actualType)) {
    return `${filePath}: "${fieldName}" is ${actualType}, expected ${expectedTypes.join(' | ')}`;
  }
  return null;
}

/**
 * Map a JavaScript value to its JSON Schema type name.
 */
function getJsonSchemaType(value: any): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value; // 'string', 'number', 'boolean', 'object'
}
