/**
 * CLI handler for the `opkg schema` command.
 *
 * Displays resource format schemas, conventions, and examples.
 * Agents have formal JSON Schema files; other types use conventions.
 */

import { normalizeType } from '@opkg/core/core/resources/resource-registry.js';
import {
  SCHEMA_TYPES,
  getSchemaOverview,
  getAgentSchema,
  getResourceConventions,
  getExample,
} from '@opkg/core/core/schema/schema-query.js';
import {
  printSchemaOverview,
  printAgentSchema,
  printConventions,
  printExample,
  printRawJson,
} from '@opkg/core/core/schema/schema-printers.js';

interface SchemaOptions {
  platform?: string;
  example?: boolean;
  json?: boolean;
}

export async function setupSchemaCommand(args: any[]): Promise<void> {
  const [typeArg, options] = args as [string | undefined, SchemaOptions];

  if (!typeArg) {
    if (options.json) {
      console.log(JSON.stringify(getSchemaOverview(), null, 2));
    } else {
      printSchemaOverview(getSchemaOverview());
    }
    return;
  }

  const resourceType = normalizeType(typeArg);

  if (!SCHEMA_TYPES.includes(resourceType)) {
    throw new Error(
      `Unknown resource type: '${typeArg}'\n` +
      `Valid types: ${SCHEMA_TYPES.join(', ')}`
    );
  }

  if (resourceType === 'agent') {
    if (options.json) {
      printRawJson(getAgentSchema(options.platform).rawSchema);
      return;
    }
    if (options.example) {
      printExample(getExample('agent', options.platform));
      return;
    }
    printAgentSchema(getAgentSchema(options.platform));
    return;
  }

  if (options.json) {
    throw new Error(
      `No formal JSON Schema for '${resourceType}'. ` +
      `This resource type uses conventions (files are copied without transformation).\n` +
      `Use: opkg schema ${resourceType} --example`
    );
  }
  if (options.platform) {
    throw new Error(
      `'${resourceType}' has no platform-specific variants. ` +
      `Conventions are the same across all platforms.`
    );
  }
  if (options.example) {
    printExample(getExample(resourceType));
    return;
  }
  printConventions(getResourceConventions(resourceType));
}
