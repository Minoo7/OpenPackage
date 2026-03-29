/**
 * Schema Printers
 *
 * Terminal rendering for `opkg schema` command output.
 */

import type {
  SchemaOverviewEntry,
  AgentSchemaResult,
  ConventionResult,
  ExampleContent,
} from './schema-query.js';

const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[39m`;

export function printSchemaOverview(entries: SchemaOverviewEntry[]): void {
  console.log('');
  console.log(bold('Resource Schemas'));
  console.log('');

  const maxName = Math.max(...entries.map(e => e.resourceType.length));

  for (const entry of entries) {
    const name = entry.resourceType.padEnd(maxName + 2);
    console.log(`  ${cyan(name)}${entry.description}`);
    if (entry.hasSchema && entry.platforms.length > 0) {
      console.log(`  ${''.padEnd(maxName + 2)}${dim(`Platforms: ${entry.platforms.join(', ')}`)}`);
    }
  }

  console.log('');
  console.log(dim('  Use: opkg schema <type> for details'));
  console.log(dim('       opkg schema <type> --platform <name> for platform-specific'));
  console.log(dim('       opkg schema <type> --example for example file'));
  console.log('');
}

export function printAgentSchema(result: AgentSchemaResult): void {
  console.log('');
  console.log(bold(`${result.title}`));
  console.log('');

  const fields = result.fields;
  if (fields.length === 0) {
    console.log('  No fields defined.');
    return;
  }

  const maxName = Math.max(...fields.map(f => f.name.length), 5);
  const maxType = Math.max(...fields.map(f => f.type.length), 4);

  // Header
  console.log(`  ${'Field'.padEnd(maxName + 2)}${'Type'.padEnd(maxType + 2)}Description`);
  console.log(dim(`  ${'─'.repeat(maxName + 2)}${'─'.repeat(maxType + 2)}${'─'.repeat(30)}`));

  for (const field of fields) {
    const name = field.name.padEnd(maxName + 2);
    const type = field.type.padEnd(maxType + 2);
    const req = field.required ? ' (required)' : '';
    const excl = field.exclusive ? dim('  [exclusive]') : '';
    console.log(`  ${name}${type}${field.description}${req}${excl}`);
  }

  console.log('');
  console.log(dim('  Use: opkg schema agent --example for example file'));
  console.log(dim('       opkg schema agent --json for raw JSON Schema'));
  console.log('');
}

export function printConventions(result: ConventionResult): void {
  console.log('');
  console.log(bold(`${result.resourceType.charAt(0).toUpperCase() + result.resourceType.slice(1)} Resources`));
  console.log('');

  if (result.dirName) {
    console.log(`  Directory: ${cyan(result.dirName + '/')}`);
  }
  if (result.marker) {
    console.log(`  Marker:    ${cyan(result.marker)}`);
  }
  console.log('');
  console.log(`  ${result.description}`);
  console.log('');

  if (result.conventions.length > 0) {
    for (const c of result.conventions) {
      console.log(`  ${dim('•')} ${c}`);
    }
    console.log('');
  }

  console.log(dim(`  Use: opkg schema ${result.resourceType} --example for example file`));
  console.log('');
}

export function printExample(example: ExampleContent): void {
  console.log('');
  console.log(dim(`  Example: ${example.filename}`));
  console.log('');
  for (const line of example.content.split('\n')) {
    console.log(`  ${line}`);
  }
}

export function printRawJson(schema: object): void {
  console.log(JSON.stringify(schema, null, 2));
}
