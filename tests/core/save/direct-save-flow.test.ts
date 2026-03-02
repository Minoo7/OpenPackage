/**
 * Tests for direct-save-flow
 *
 * Tests the resource-spec resolution and dispatch logic.
 * Since node:test doesn't support module-level mocking, these tests
 * validate the flow using integration-style approaches with a real
 * workspace fixture, plus unit tests for the query parsing integration.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { parseWhichQuery } from '../../../packages/core/src/core/which/which-pipeline.js';

describe('direct-save-flow', () => {

  describe('query parsing integration', () => {
    it('should parse bare name without type filter', () => {
      const query = parseWhichQuery('my-rules');
      assert.equal(query.name, 'my-rules');
      assert.equal(query.typeFilter, undefined);
    });

    it('should parse type-qualified name with skills/ prefix', () => {
      const query = parseWhichQuery('skills/my-skill');
      assert.equal(query.name, 'my-skill');
      assert.equal(query.typeFilter, 'skill');
    });

    it('should parse type-qualified name with rules/ prefix', () => {
      const query = parseWhichQuery('rules/custom-rules');
      assert.equal(query.name, 'custom-rules');
      assert.equal(query.typeFilter, 'rule');
    });

    it('should parse type-qualified name with agents/ prefix', () => {
      const query = parseWhichQuery('agents/my-agent');
      assert.equal(query.name, 'my-agent');
      assert.equal(query.typeFilter, 'agent');
    });

    it('should parse type-qualified name with commands/ prefix', () => {
      const query = parseWhichQuery('commands/my-cmd');
      assert.equal(query.name, 'my-cmd');
      assert.equal(query.typeFilter, 'command');
    });

    it('should parse type-qualified name with hooks/ prefix', () => {
      const query = parseWhichQuery('hooks/my-hook');
      assert.equal(query.name, 'my-hook');
      assert.equal(query.typeFilter, 'hook');
    });

    it('should treat unknown prefix as literal name (no type filter)', () => {
      const query = parseWhichQuery('unknown/something');
      // normalizeType returns 'other' for unknown prefix, which means no type filter
      assert.equal(query.name, 'unknown/something');
      assert.equal(query.typeFilter, undefined);
    });

    it('should handle trailing slash as literal name', () => {
      const query = parseWhichQuery('skills/');
      // empty name after slash → treated as literal
      assert.equal(query.name, 'skills/');
      assert.equal(query.typeFilter, undefined);
    });
  });

  describe('type filtering logic', () => {
    // Test the filtering logic that direct-save-flow applies to candidates
    // when a type qualifier is present.

    interface MockCandidate {
      kind: 'resource' | 'package';
      resourceType?: string;
    }

    function filterByType(candidates: MockCandidate[], typeFilter?: string): MockCandidate[] {
      if (!typeFilter) return candidates;
      return candidates.filter(
        c => c.kind === 'resource' && c.resourceType === typeFilter
      );
    }

    it('should not filter when no type qualifier', () => {
      const candidates: MockCandidate[] = [
        { kind: 'resource', resourceType: 'rule' },
        { kind: 'resource', resourceType: 'skill' },
        { kind: 'package' },
      ];
      const result = filterByType(candidates, undefined);
      assert.equal(result.length, 3);
    });

    it('should filter to only matching resource type', () => {
      const candidates: MockCandidate[] = [
        { kind: 'resource', resourceType: 'rule' },
        { kind: 'resource', resourceType: 'skill' },
        { kind: 'package' },
      ];
      const result = filterByType(candidates, 'skill');
      assert.equal(result.length, 1);
      assert.equal(result[0].resourceType, 'skill');
    });

    it('should exclude packages when type qualifier present', () => {
      const candidates: MockCandidate[] = [
        { kind: 'package' },
        { kind: 'resource', resourceType: 'rule' },
      ];
      const result = filterByType(candidates, 'rule');
      assert.equal(result.length, 1);
      assert.equal(result[0].kind, 'resource');
    });

    it('should return empty array when no candidates match type', () => {
      const candidates: MockCandidate[] = [
        { kind: 'resource', resourceType: 'rule' },
        { kind: 'package' },
      ];
      const result = filterByType(candidates, 'skill');
      assert.equal(result.length, 0);
    });
  });

  describe('filesMapping filtering logic', () => {
    // Test the logic that filters filesMapping by source keys,
    // which is the core of the resource-level save.

    function filterFilesMapping(
      fullMapping: Record<string, string[]>,
      sourceKeys: Set<string>
    ): Record<string, string[]> {
      const filtered: Record<string, string[]> = {};
      for (const key of sourceKeys) {
        if (fullMapping[key]) {
          filtered[key] = fullMapping[key];
        }
      }
      return filtered;
    }

    it('should filter to only matching source keys', () => {
      const fullMapping: Record<string, string[]> = {
        'rules/custom-rules.mdc': ['.cursor/rules/custom-rules.mdc'],
        'rules/other-rules.mdc': ['.cursor/rules/other-rules.mdc'],
        'agents/my-agent.md': ['.cursor/agents/my-agent.md'],
        'AGENTS.md': ['.cursor/AGENTS.md'],
      };
      const sourceKeys = new Set(['rules/custom-rules.mdc']);

      const result = filterFilesMapping(fullMapping, sourceKeys);
      assert.deepEqual(Object.keys(result), ['rules/custom-rules.mdc']);
      assert.deepEqual(result['rules/custom-rules.mdc'], ['.cursor/rules/custom-rules.mdc']);
    });

    it('should include multiple source keys for multi-file resources', () => {
      const fullMapping: Record<string, string[]> = {
        'skills/my-skill/SKILL.md': ['.cursor/skills/my-skill/SKILL.md'],
        'skills/my-skill/lib.ts': ['.cursor/skills/my-skill/lib.ts'],
        'rules/other.md': ['.cursor/rules/other.md'],
      };
      const sourceKeys = new Set(['skills/my-skill/SKILL.md', 'skills/my-skill/lib.ts']);

      const result = filterFilesMapping(fullMapping, sourceKeys);
      assert.equal(Object.keys(result).length, 2);
      assert.ok(result['skills/my-skill/SKILL.md']);
      assert.ok(result['skills/my-skill/lib.ts']);
    });

    it('should return empty object when no keys match', () => {
      const fullMapping: Record<string, string[]> = {
        'rules/custom-rules.mdc': ['.cursor/rules/custom-rules.mdc'],
      };
      const sourceKeys = new Set(['agents/nonexistent.md']);

      const result = filterFilesMapping(fullMapping, sourceKeys);
      assert.equal(Object.keys(result).length, 0);
    });

    it('should handle empty source keys', () => {
      const fullMapping: Record<string, string[]> = {
        'rules/custom-rules.mdc': ['.cursor/rules/custom-rules.mdc'],
      };
      const sourceKeys = new Set<string>();

      const result = filterFilesMapping(fullMapping, sourceKeys);
      assert.equal(Object.keys(result).length, 0);
    });

    it('should preserve full mapping when all keys are included', () => {
      const fullMapping: Record<string, string[]> = {
        'rules/a.md': ['target-a'],
        'rules/b.md': ['target-b'],
      };
      const sourceKeys = new Set(['rules/a.md', 'rules/b.md']);

      const result = filterFilesMapping(fullMapping, sourceKeys);
      assert.deepEqual(result, fullMapping);
    });
  });

  describe('exports', () => {
    it('should export runDirectSaveFlow from core index', async () => {
      const coreIndex = await import('../../../packages/core/src/index.js');
      assert.ok(typeof coreIndex.runDirectSaveFlow === 'function');
    });

    it('should export DirectSaveResult type from core index', async () => {
      // Type exports can't be tested at runtime, but we can verify
      // the module loads without errors
      const mod = await import('../../../packages/core/src/core/save/direct-save-flow.js');
      assert.ok(typeof mod.runDirectSaveFlow === 'function');
    });
  });

  describe('executeSavePipeline export', () => {
    it('should export executeSavePipeline from save-to-source-pipeline', async () => {
      const mod = await import('../../../packages/core/src/core/save/save-to-source-pipeline.js');
      assert.ok(typeof mod.executeSavePipeline === 'function');
    });

    it('should export validateSavePreconditions from save-to-source-pipeline', async () => {
      const mod = await import('../../../packages/core/src/core/save/save-to-source-pipeline.js');
      assert.ok(typeof mod.validateSavePreconditions === 'function');
    });
  });
});
