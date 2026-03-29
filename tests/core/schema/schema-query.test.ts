import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  getSchemaOverview,
  getAgentSchema,
  getResourceConventions,
  getExample,
  getAvailablePlatforms,
  formatSchemaType,
} from '../../../packages/core/src/core/schema/schema-query.js';

describe('getSchemaOverview', () => {
  it('should return entries for agent, skill, command, rule', () => {
    const entries = getSchemaOverview();
    const types = entries.map(e => e.resourceType);
    assert.ok(types.includes('agent'));
    assert.ok(types.includes('skill'));
    assert.ok(types.includes('command'));
    assert.ok(types.includes('rule'));
  });

  it('should mark agent as schema-backed with platforms', () => {
    const entries = getSchemaOverview();
    const agent = entries.find(e => e.resourceType === 'agent')!;
    assert.strictEqual(agent.hasSchema, true);
    assert.ok(agent.platforms.length > 0);
    assert.ok(agent.platforms.includes('universal'));
  });

  it('should mark non-agent types as convention-backed', () => {
    const entries = getSchemaOverview();
    for (const type of ['skill', 'command', 'rule']) {
      const entry = entries.find(e => e.resourceType === type)!;
      assert.strictEqual(entry.hasSchema, false);
      assert.strictEqual(entry.platforms.length, 0);
    }
  });
});

describe('getAgentSchema', () => {
  it('should load master schema when no platform specified', () => {
    const result = getAgentSchema();
    assert.ok(result.fields.length > 0);
    assert.ok(result.title.length > 0);
    // Master schema has description as required
    const descField = result.fields.find(f => f.name === 'description');
    assert.ok(descField);
    assert.strictEqual(descField!.required, true);
  });

  it('should load claude schema with exclusive fields', () => {
    const result = getAgentSchema('claude');
    assert.ok(result.fields.length > 0);
    const permMode = result.fields.find(f => f.name === 'permissionMode');
    assert.ok(permMode, 'claude schema should have permissionMode');
    assert.strictEqual(permMode!.exclusive, true);
  });

  it('should load universal schema', () => {
    const result = getAgentSchema('universal');
    assert.ok(result.fields.length > 0);
    const tools = result.fields.find(f => f.name === 'tools');
    assert.ok(tools);
    // Universal tools is array, not string
    assert.ok(tools!.type.includes('string[]') || tools!.type === 'string[]');
  });

  it('should throw for nonexistent platform', () => {
    assert.throws(() => getAgentSchema('nonexistent'), /No agent schema found/);
  });
});

describe('getResourceConventions', () => {
  it('should return skill conventions with marker', () => {
    const result = getResourceConventions('skill');
    assert.strictEqual(result.dirName, 'skills');
    assert.strictEqual(result.marker, 'SKILL.md');
    assert.ok(result.description.length > 0);
    assert.ok(result.conventions.length > 0);
  });

  it('should return command conventions', () => {
    const result = getResourceConventions('command');
    assert.strictEqual(result.dirName, 'commands');
    assert.strictEqual(result.marker, null);
    assert.ok(result.conventions.some(c => c.includes('$ARGUMENTS')));
  });

  it('should return rule conventions', () => {
    const result = getResourceConventions('rule');
    assert.strictEqual(result.dirName, 'rules');
    assert.ok(result.conventions.some(c => c.includes('1-3 lines')));
  });
});

describe('getExample', () => {
  it('should return agent example with frontmatter', () => {
    const example = getExample('agent');
    assert.ok(example.content.includes('---'));
    assert.ok(example.content.includes('description'));
    assert.ok(example.content.includes('model'));
  });

  it('should return claude agent example with permissionMode or skills', () => {
    const example = getExample('agent', 'claude');
    assert.ok(example.content.includes('skills'));
  });

  it('should return skill example with SKILL.md', () => {
    const example = getExample('skill');
    assert.ok(example.filename.includes('SKILL.md'));
    assert.ok(example.content.includes('description'));
  });

  it('should return command example with $ARGUMENTS', () => {
    const example = getExample('command');
    assert.ok(example.content.includes('$ARGUMENTS'));
  });

  it('should return rule example', () => {
    const example = getExample('rule');
    assert.ok(example.content.length > 0);
  });
});

describe('getAvailablePlatforms', () => {
  it('should include universal', () => {
    const platforms = getAvailablePlatforms();
    assert.ok(platforms.includes('universal'));
  });

  it('should include claude', () => {
    const platforms = getAvailablePlatforms();
    assert.ok(platforms.includes('claude'));
  });
});

describe('formatSchemaType', () => {
  it('should format string type', () => {
    assert.strictEqual(formatSchemaType({ type: 'string' }), 'string');
  });

  it('should format array type with items', () => {
    assert.strictEqual(
      formatSchemaType({ type: 'array', items: { type: 'string' } }),
      'string[]'
    );
  });

  it('should format enum type', () => {
    const result = formatSchemaType({ enum: ['a', 'b', 'c'] });
    assert.ok(result.includes('a'));
    assert.ok(result.includes('b'));
    assert.ok(result.includes('c'));
  });

  it('should format object type', () => {
    assert.strictEqual(formatSchemaType({ type: 'object' }), 'object');
  });

  it('should format boolean type', () => {
    assert.strictEqual(formatSchemaType({ type: 'boolean' }), 'boolean');
  });
});
