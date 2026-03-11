/**
 * File Format Detection Tests
 * 
 * Tests for schema-based per-file format detection.
 * Covers schema loading, detection scoring, and format classification.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { 
  detectFileFormat, 
  scoreAgainstSchema,
  groupFilesByFormat
} from '../../../packages/core/src/core/install/file-format-detector.js';
import { schemaRegistry } from '../../../packages/core/src/core/install/schema-registry.js';
import { splitFrontmatter } from '../../../packages/core/src/core/markdown-frontmatter.js';
import type { PackageFile, DetectionSchema } from '../../../packages/core/src/core/install/detection-types.js';
import type { Flow } from '../../../packages/core/src/types/flows.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = join(__dirname, '../../fixtures/format-detection');

// Helper: Load fixture file
function loadFixture(name: string): PackageFile {
  const path = join(fixturesDir, name);
  const content = readFileSync(path, 'utf-8');
  const { frontmatter } = splitFrontmatter(content);
  
  return {
    path: `agents/${name}`,
    content,
    frontmatter: frontmatter || {}
  };
}

describe('Schema Registry', () => {
  beforeEach(() => {
    schemaRegistry.clearCache();
  });

  test('loads schema from path', () => {
    const schema = schemaRegistry.loadSchema('./schemas/formats/claude-agent.schema.json');
    
    assert.ok(schema, 'Schema should be loaded');
    assert.equal(schema?.$id, 'https://openpackage.dev/schemas/formats/claude-agent.schema.json');
    assert.ok(schema?.properties, 'Schema should have properties');
    assert.ok(schema?.properties?.tools, 'Schema should define tools field');
  });

  test('caches loaded schemas', () => {
    const schema1 = schemaRegistry.loadSchema('./schemas/formats/claude-agent.schema.json');
    const schema2 = schemaRegistry.loadSchema('./schemas/formats/claude-agent.schema.json');
    
    assert.equal(schema1, schema2, 'Should return same instance from cache');
    assert.equal(schemaRegistry.getCacheSize(), 1);
  });

  test('handles missing schema gracefully', () => {
    const schema = schemaRegistry.loadSchema('./schemas/formats/nonexistent.schema.json');
    
    assert.equal(schema, null, 'Should return null for missing schema');
  });

  test('extracts schema from flow with object pattern', () => {
    const flow: Flow = {
      from: {
        pattern: 'agents/**/*.md',
        schema: './schemas/formats/claude-agent.schema.json'
      } as any,
      to: 'agents/**/*.md'
    };
    
    const schema = schemaRegistry.getSchemaForFlow(flow, 'from');
    assert.ok(schema, 'Should extract schema from object pattern');
    assert.ok(schema?.properties?.permissionMode, 'Should be Claude schema');
  });

  test('returns null for string pattern without schema', () => {
    const flow: Flow = {
      from: 'agents/**/*.md',
      to: 'agents/**/*.md'
    };
    
    const schema = schemaRegistry.getSchemaForFlow(flow, 'from');
    assert.equal(schema, null, 'String patterns have no schema');
  });

  test('skips switch expressions', () => {
    const flow: Flow = {
      from: {
        $switch: {
          field: '$$platform',
          cases: [
            { pattern: 'claude', value: '.claude/agents/**/*.md' }
          ]
        }
      },
      to: 'agents/**/*.md'
    };
    
    const schema = schemaRegistry.getSchemaForFlow(flow, 'from');
    assert.equal(schema, null, 'Switch expressions should be skipped');
  });
});

describe('Format Detection - Claude Format', () => {
  test('detects Claude format from tools string', () => {
    const file = loadFixture('claude-format.md');
    const format = detectFileFormat(file);
    
    assert.equal(format.platform, 'claude', 'Should detect Claude format');
    assert.ok(format.confidence > 0.7, `Confidence should be high (got ${format.confidence})`);
    assert.ok(format.matchedFields.includes('tools'), 'Should match tools field');
  });

  test('detects Claude format from permissionMode', () => {
    const file = loadFixture('claude-format.md');
    const format = detectFileFormat(file);
    
    assert.ok(format.matchedFields.includes('permissionMode'), 'Should match exclusive permissionMode field');
    assert.ok(format.confidence > 0.8, 'Exclusive field should boost confidence');
  });

  test('detects Claude format from hooks', () => {
    const file: PackageFile = {
      path: 'agents/test.md',
      frontmatter: {
        description: 'Test agent',
        hooks: {
          PreToolUse: []
        }
      }
    };
    
    const format = detectFileFormat(file);
    assert.equal(format.platform, 'claude', 'Hooks should indicate Claude format');
  });

  test('detects Claude format from skills array', () => {
    const file: PackageFile = {
      path: 'agents/test.md',
      frontmatter: {
        description: 'Test agent',
        skills: ['code-quality']
      }
    };
    
    const format = detectFileFormat(file);
    assert.equal(format.platform, 'claude', 'Skills should indicate Claude format');
  });
});

describe('Format Detection - Edge Cases', () => {
  test('returns universal for empty frontmatter', () => {
    const file: PackageFile = {
      path: 'agents/empty.md',
      frontmatter: {}
    };
    
    const format = detectFileFormat(file);
    // Files at universal paths (agents/) now default to 'universal' rather than 'unknown'
    assert.equal(format.platform, 'universal');
  });

  test('returns universal for no frontmatter', () => {
    const file: PackageFile = {
      path: 'agents/no-frontmatter.md',
      content: '# Just body content\n\nNo frontmatter here.'
    };
    
    const format = detectFileFormat(file);
    // Files at universal paths default to 'universal'
    assert.equal(format.platform, 'universal');
  });

  test('handles ambiguous format by selecting highest score', () => {
    const file = loadFixture('ambiguous.md');
    const format = detectFileFormat(file);
    
    // Detection scoring was retuned - claude now wins for ambiguous cases
    assert.equal(format.platform, 'claude', 'Should resolve ambiguity to highest score');
    assert.ok(format.confidence > 0, 'Should have some confidence');
  });

  test('applies path boost when file matches flow pattern', () => {
    const file: PackageFile = {
      path: '.claude/agents/test.md',  // Matches Claude import pattern
      frontmatter: {
        description: 'Test',
        tools: 'Read'
      }
    };
    
    const format = detectFileFormat(file);
    // Path boost should increase confidence for Claude
    assert.equal(format.platform, 'claude');
  });
});

describe('Schema Scoring', () => {
  test('calculates score based on matched fields', () => {
    const schema: DetectionSchema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: 'test',
      title: 'Test',
      type: 'object',
      properties: {
        field1: { type: 'string', 'x-detection-weight': 0.3 },
        field2: { type: 'number', 'x-detection-weight': 0.4 }
      }
    };
    
    const frontmatter = {
      field1: 'value',
      field2: 42
    };
    
    const flow: Flow = { from: 'test/**/*.md', to: 'test/**/*.md' };
    const result = scoreAgainstSchema(frontmatter, schema, flow, 'test.md', 'test');
    
    assert.equal(result.score, 0.7, 'Score should sum matched weights');
    assert.equal(result.maxScore, 0.7);
    assert.equal(result.matchedFields.length, 2);
  });

  test('adds bonus for exclusive fields', () => {
    const schema: DetectionSchema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: 'test',
      title: 'Test',
      type: 'object',
      properties: {
        exclusive: { 
          type: 'string', 
          'x-detection-weight': 0.3,
          'x-exclusive': true 
        }
      }
    };
    
    const frontmatter = { exclusive: 'value' };
    const flow: Flow = { from: 'test/**/*.md', to: 'test/**/*.md' };
    const result = scoreAgainstSchema(frontmatter, schema, flow, 'test.md', 'test');
    
    assert.equal(result.score, 0.4, 'Score should include 0.1 exclusive bonus');
  });

  test('validates enum constraints', () => {
    const schema: DetectionSchema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: 'test',
      title: 'Test',
      type: 'object',
      properties: {
        mode: { 
          enum: ['a', 'b', 'c'], 
          'x-detection-weight': 0.5
        }
      }
    };
    
    const validFrontmatter = { mode: 'a' };
    const invalidFrontmatter = { mode: 'invalid' };
    
    const flow: Flow = { from: 'test/**/*.md', to: 'test/**/*.md' };
    
    const validResult = scoreAgainstSchema(validFrontmatter, schema, flow, 'test.md', 'test');
    const invalidResult = scoreAgainstSchema(invalidFrontmatter, schema, flow, 'test.md', 'test');
    
    assert.equal(validResult.score, 0.5, 'Valid enum should score');
    assert.equal(invalidResult.score, 0, 'Invalid enum should not score');
  });

  test('validates type constraints', () => {
    const schema: DetectionSchema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: 'test',
      title: 'Test',
      type: 'object',
      properties: {
        count: { type: 'number', 'x-detection-weight': 0.5 }
      }
    };
    
    const validFrontmatter = { count: 42 };
    const invalidFrontmatter = { count: 'not a number' };
    
    const flow: Flow = { from: 'test/**/*.md', to: 'test/**/*.md' };
    
    const validResult = scoreAgainstSchema(validFrontmatter, schema, flow, 'test.md', 'test');
    const invalidResult = scoreAgainstSchema(invalidFrontmatter, schema, flow, 'test.md', 'test');
    
    assert.equal(validResult.score, 0.5, 'Correct type should score');
    assert.equal(invalidResult.score, 0, 'Wrong type should not score');
  });
});

describe('Performance', () => {
  test('detects format in under 5ms', () => {
    const file = loadFixture('claude-format.md');
    
    const start = performance.now();
    detectFileFormat(file);
    const duration = performance.now() - start;
    
    assert.ok(duration < 5, `Detection took ${duration.toFixed(2)}ms (should be <5ms)`);
  });

  test('detects 100 files in under 500ms', () => {
    const files = Array(100).fill(null).map((_, i) => ({
      path: `agents/test-${i}.md`,
      frontmatter: {
        description: 'Test agent',
        tools: i % 2 === 0 ? 'Read, Write' : { read: true, write: true },
        model: 'claude-sonnet'
      }
    }));
    
    const start = performance.now();
    files.forEach(f => detectFileFormat(f));
    const duration = performance.now() - start;
    
    assert.ok(duration < 500, `100 detections took ${duration.toFixed(2)}ms (should be <500ms)`);
  });
});
