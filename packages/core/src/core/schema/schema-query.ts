/**
 * Schema Query Module
 *
 * Core logic for the `opkg schema` command. Returns data structures
 * for display — no terminal output. Reuses SchemaRegistry for loading
 * agent format schemas; hardcodes conventions for pass-through types.
 */

import { readdirSync } from 'fs';
import { join } from 'path';
import { schemaRegistry, projectRoot } from '../install/schema-registry.js';
import { getResourceTypeDef, type ResourceTypeId } from '../resources/resource-registry.js';
import type { DetectionSchema, SchemaProperty } from '../install/detection-types.js';

export interface SchemaFieldInfo {
  name: string;
  type: string;
  description: string;
  required: boolean;
  exclusive: boolean;
}

export interface AgentSchemaResult {
  title: string;
  platform: string;
  fields: SchemaFieldInfo[];
  rawSchema: DetectionSchema;
}

export interface ConventionResult {
  resourceType: string;
  dirName: string | null;
  marker: string | null;
  description: string;
  conventions: string[];
}

export interface SchemaOverviewEntry {
  resourceType: string;
  hasSchema: boolean;
  platforms: string[];
  description: string;
}

export interface ExampleContent {
  filename: string;
  content: string;
}

/** Resource types exposed by the schema command. */
export const SCHEMA_TYPES: ResourceTypeId[] = ['agent', 'skill', 'command', 'rule'];

const FORMATS_DIR = join(projectRoot, 'schemas', 'formats');
const MASTER_SCHEMA_PATH = './schemas/agent-frontmatter-v1.json';

const CONVENTIONS: Record<string, { description: string; conventions: string[] }> = {
  skill: {
    description: 'Each skill is a directory under skills/ containing a SKILL.md marker file. The SKILL.md frontmatter description is the recall trigger — Claude loads the skill when the description matches the current context.',
    conventions: [
      'Location: skills/<name>/SKILL.md',
      'Frontmatter: description (REQUIRED, under 1024 chars)',
      'Content: actionable knowledge, 50-300 lines',
      'Supporting files (references/, scripts/) live alongside SKILL.md',
    ],
  },
  command: {
    description: 'Single markdown file under commands/. The body is the prompt template executed when the command is invoked. Use $ARGUMENTS for user input.',
    conventions: [
      'Location: commands/<name>.md',
      'Frontmatter: description (shown in command list)',
      'Content: prompt template with $ARGUMENTS placeholder',
    ],
  },
  rule: {
    description: 'Single markdown file under rules/. Rules are always loaded into context — use for universal, non-negotiable constraints. Keep to 1-3 lines.',
    conventions: [
      'Location: rules/<name>.md',
      'Frontmatter: optional (description, globs for file-scoped rules)',
      'Content: 1-3 lines of constraint text',
      'If it needs more explanation, make it a skill instead',
    ],
  },
  agent: {
    description: 'Use --platform flag for agent schema (agents have platform-specific formats).',
    conventions: ['Run: opkg schema agent [--platform claude]'],
  },
};

const AGENT_EXAMPLE_BODY = `
You are a code review specialist. Analyze code for correctness,
performance, and maintainability.
`;

const AGENT_EXAMPLE_FRONTMATTER: Record<string, string> = {
  claude: `model: sonnet
tools: Read, Write, Edit, Bash, Glob, Grep
skills: [openpackage]`,
  opencode: `model: anthropic/claude-sonnet-4.20250514
tools:
  read: true
  write: true
  edit: true
  bash: true
temperature: 0.1
mode: subagent`,
};

const AGENT_EXAMPLE_FRONTMATTER_DEFAULT = `model: anthropic/claude-sonnet-4.20250514
tools: [read, write, edit, bash, glob, grep]
permissions:
  edit: ask
  bash: ask`;

export function getSchemaOverview(): SchemaOverviewEntry[] {
  const platforms = getAvailablePlatforms();

  return SCHEMA_TYPES.map(id => {
    const def = getResourceTypeDef(id);
    if (id === 'agent') {
      return {
        resourceType: id,
        hasSchema: true,
        platforms,
        description: 'Markdown with YAML frontmatter. Platform-specific transformations.',
      };
    }
    const markerNote = def.marker ? ` Directory with ${def.marker} marker.` : ' Single markdown file.';
    return {
      resourceType: id,
      hasSchema: false,
      platforms: [],
      description: `Convention-based.${markerNote}`,
    };
  });
}

export function getAgentSchema(platform?: string): AgentSchemaResult {
  const schemaPath = platform && platform !== 'universal'
    ? `./schemas/formats/${platform}-agent.schema.json`
    : MASTER_SCHEMA_PATH;

  const schema = schemaRegistry.loadSchema(schemaPath);
  if (!schema) {
    throw new Error(
      `No agent schema found for platform '${platform ?? 'universal'}'.\n` +
      `Available: ${getAvailablePlatforms().join(', ')}`
    );
  }

  const required = new Set<string>(schema.required ?? []);

  const fields: SchemaFieldInfo[] = [];
  if (schema.properties) {
    for (const [name, prop] of Object.entries(schema.properties)) {
      fields.push({
        name,
        type: formatSchemaType(prop),
        description: prop.description ?? '',
        required: required.has(name),
        exclusive: prop['x-exclusive'] === true,
      });
    }
  }

  return {
    title: schema.title ?? 'Agent Frontmatter',
    platform: schema['x-detection']?.platform ?? platform ?? 'universal',
    fields,
    rawSchema: schema,
  };
}

export function getResourceConventions(resourceType: ResourceTypeId): ConventionResult {
  const def = getResourceTypeDef(resourceType);
  const entry = CONVENTIONS[resourceType] ?? {
    description: `${def.labelPlural} resource type.`,
    conventions: def.dirName ? [`Location: ${def.dirName}/`] : [],
  };

  return {
    resourceType,
    dirName: def.dirName,
    marker: def.marker,
    ...entry,
  };
}

export function getExample(resourceType: ResourceTypeId, platform?: string): ExampleContent {
  switch (resourceType) {
    case 'agent': {
      const extra = AGENT_EXAMPLE_FRONTMATTER[platform ?? ''] ?? AGENT_EXAMPLE_FRONTMATTER_DEFAULT;
      return {
        filename: 'agents/my-agent.md',
        content: `---
name: my-agent
description: |
  Specialized agent for code review. Activates when reviewing PRs,
  analyzing code quality, or suggesting improvements.
${extra}
---
${AGENT_EXAMPLE_BODY}`,
      };
    }
    case 'skill':
      return {
        filename: 'skills/my-skill/SKILL.md',
        content: `---
name: my-skill
description: |
  TypeScript authentication patterns including guards, JWT validation,
  and session handling. Activates on auth controllers, middleware,
  or permission logic.
---

# TypeScript Auth Patterns

## Guards
Prefer \`canActivate\` interface for route-level guards.

## JWT Validation
Always verify token expiry and issuer claims.
`,
      };
    case 'command':
      return {
        filename: 'commands/review-security.md',
        content: `---
description: Review code for security vulnerabilities
---

Review the following code for security vulnerabilities: $ARGUMENTS

Focus on OWASP Top 10, injection risks, and authentication issues.
Present findings as a prioritized list with severity ratings.
`,
      };
    case 'rule':
      return {
        filename: 'rules/no-any.md',
        content: `Never use \`any\` in TypeScript. Use \`unknown\` with type guards.
`,
      };
    default:
      return { filename: `${resourceType}.md`, content: `# ${resourceType}\n` };
  }
}

export function getAvailablePlatforms(): string[] {
  const platforms = ['universal'];
  try {
    const files = readdirSync(FORMATS_DIR);
    for (const f of files) {
      const match = f.match(/^(.+)-agent\.schema\.json$/);
      if (match && match[1] !== 'universal') {
        platforms.push(match[1]);
      }
    }
  } catch { /* schemas dir may not exist in test env */ }
  return platforms;
}

export function formatSchemaType(prop: SchemaProperty): string {
  if (prop.enum) {
    return `enum(${prop.enum.join(' | ')})`;
  }
  const t = Array.isArray(prop.type) ? prop.type[0] : prop.type;
  if (t === 'array' && prop.items) {
    const itemType = Array.isArray(prop.items.type) ? prop.items.type[0] : prop.items.type;
    return `${itemType ?? 'any'}[]`;
  }
  return t ?? 'any';
}
