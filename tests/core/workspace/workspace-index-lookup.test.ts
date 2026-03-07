import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { findPackageInIndex } from '../../../packages/core/src/utils/workspace-index-helpers.js';
import type { WorkspaceIndexPackage } from '../../../packages/core/src/types/workspace-index.js';

function makeEntry(files: Record<string, string[]> = {}): WorkspaceIndexPackage {
  const mapped: Record<string, string[]> = {};
  for (const [key, targets] of Object.entries(files)) {
    mapped[key] = targets;
  }
  return { path: '~/pkg', files: mapped };
}

describe('findPackageInIndex', () => {
  test('exact key match', () => {
    const packages = {
      'gh@anthropics/skills/skills/skill-creator': makeEntry(),
    };
    const result = findPackageInIndex('gh@anthropics/skills/skills/skill-creator', packages);
    assert.ok(result);
    assert.equal(result.key, 'gh@anthropics/skills/skills/skill-creator');
  });

  test('case-insensitive match', () => {
    const packages = {
      'gh@Anthropics/Skills': makeEntry(),
    };
    const result = findPackageInIndex('gh@anthropics/skills', packages);
    assert.ok(result);
    assert.equal(result.key, 'gh@Anthropics/Skills');
  });

  test('old @scope/repo → gh@scope/repo normalization', () => {
    const packages = {
      'gh@anthropics/skills': makeEntry(),
    };
    const result = findPackageInIndex('@anthropics/skills', packages);
    assert.ok(result);
    assert.equal(result.key, 'gh@anthropics/skills');
  });

  test('old @scope/repo/plugin → gh@scope/repo/plugin normalization', () => {
    const packages = {
      'gh@anthropics/skills/skills/skill-creator': makeEntry(),
    };
    const result = findPackageInIndex('@anthropics/skills/skills/skill-creator', packages);
    assert.ok(result);
    assert.equal(result.key, 'gh@anthropics/skills/skills/skill-creator');
  });

  test('resource name match — skills/skill-creator finds package with matching source keys', () => {
    const packages = {
      'gh@anthropics/skills/skills/skill-creator': makeEntry({
        'skills/skill-creator/index.md': ['.cursor/skills/skill-creator/index.md'],
        'skills/skill-creator/helpers.md': ['.cursor/skills/skill-creator/helpers.md'],
      }),
    };
    const result = findPackageInIndex('skills/skill-creator', packages);
    assert.ok(result);
    assert.equal(result.key, 'gh@anthropics/skills/skills/skill-creator');
  });

  test('resource name match — agents/ui-designer finds package with matching source keys', () => {
    const packages = {
      'gh@company/repo/agents/ui-designer': makeEntry({
        'agents/ui-designer/agent.md': ['.cursor/agents/ui-designer.md'],
      }),
    };
    const result = findPackageInIndex('agents/ui-designer', packages);
    assert.ok(result);
    assert.equal(result.key, 'gh@company/repo/agents/ui-designer');
  });

  test('resource name match — exact source key match (no trailing slash)', () => {
    const packages = {
      'gh@org/repo': makeEntry({
        'rules/my-rule': ['.cursor/rules/my-rule.md'],
      }),
    };
    const result = findPackageInIndex('rules/my-rule', packages);
    assert.ok(result);
    assert.equal(result.key, 'gh@org/repo');
  });

  test('no match returns null', () => {
    const packages = {
      'gh@anthropics/skills': makeEntry(),
    };
    const result = findPackageInIndex('nonexistent-package', packages);
    assert.equal(result, null);
  });

  test('empty packages map returns null', () => {
    const result = findPackageInIndex('anything', {});
    assert.equal(result, null);
  });

  test('package with no files property handled gracefully for resource match', () => {
    const entry: WorkspaceIndexPackage = { path: '~/pkg', files: {} };
    const packages = { 'gh@org/repo': entry };
    const result = findPackageInIndex('skills/foo', packages);
    assert.equal(result, null);
  });

  test('non-resource-type prefixes do not false-positive', () => {
    const packages = {
      'gh@org/repo': makeEntry({
        'src/components/button.tsx': ['.cursor/rules/button.md'],
      }),
    };
    // "src/components" is not a known resource type prefix, so classifyResourceSpec returns 'other'
    const result = findPackageInIndex('src/components', packages);
    assert.equal(result, null);
  });

  test('exact match takes priority over resource name match', () => {
    const packages = {
      'skills/skill-creator': makeEntry({ 'rules/foo.md': ['.cursor/rules/foo.md'] }),
      'gh@anthropics/skills/skills/skill-creator': makeEntry({
        'skills/skill-creator/index.md': ['.cursor/skills/skill-creator/index.md'],
      }),
    };
    const result = findPackageInIndex('skills/skill-creator', packages);
    assert.ok(result);
    assert.equal(result.key, 'skills/skill-creator');
  });
});
