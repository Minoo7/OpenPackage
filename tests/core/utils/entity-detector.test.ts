/**
 * Unit tests for detectSingleResourceType and detectEntityType
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectSingleResourceType, detectEntityType } from '../../../packages/core/src/utils/entity-detector.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'entity-detect-'));
}

// ---------------------------------------------------------------------------
// detectSingleResourceType
// ---------------------------------------------------------------------------

// Skill directory (has SKILL.md)
{
  const dir = makeTempDir();
  writeFileSync(join(dir, 'SKILL.md'), '# Skill');
  mkdirSync(join(dir, 'agents'), { recursive: true });
  writeFileSync(join(dir, 'agents', 'analyzer.md'), '');
  const result = await detectSingleResourceType(dir);
  assert.equal(result, 'skill');
  rmSync(dir, { recursive: true, force: true });
  console.log('✓ detectSingleResourceType: dir with SKILL.md → skill');
}

// Plugin directory (has .claude-plugin/plugin.json)
{
  const dir = makeTempDir();
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), '{}');
  const result = await detectSingleResourceType(dir);
  assert.equal(result, 'plugin');
  rmSync(dir, { recursive: true, force: true });
  console.log('✓ detectSingleResourceType: dir with .claude-plugin/plugin.json → plugin');
}

// Package directory (has openpackage.yml) → null
{
  const dir = makeTempDir();
  writeFileSync(join(dir, 'openpackage.yml'), 'name: test');
  const result = await detectSingleResourceType(dir);
  assert.equal(result, null);
  rmSync(dir, { recursive: true, force: true });
  console.log('✓ detectSingleResourceType: dir with openpackage.yml → null');
}

// Workspace directory (has .openpackage/openpackage.yml) → null
{
  const dir = makeTempDir();
  mkdirSync(join(dir, '.openpackage'), { recursive: true });
  writeFileSync(join(dir, '.openpackage', 'openpackage.yml'), 'name: ws');
  const result = await detectSingleResourceType(dir);
  assert.equal(result, null);
  rmSync(dir, { recursive: true, force: true });
  console.log('✓ detectSingleResourceType: workspace dir → null');
}

// Package with SKILL.md (openpackage.yml wins) → null
{
  const dir = makeTempDir();
  writeFileSync(join(dir, 'openpackage.yml'), 'name: pkg');
  writeFileSync(join(dir, 'SKILL.md'), '# Skill');
  const result = await detectSingleResourceType(dir);
  assert.equal(result, null);
  rmSync(dir, { recursive: true, force: true });
  console.log('✓ detectSingleResourceType: openpackage.yml + SKILL.md → null (package wins)');
}

// Empty directory → null
{
  const dir = makeTempDir();
  const result = await detectSingleResourceType(dir);
  assert.equal(result, null);
  rmSync(dir, { recursive: true, force: true });
  console.log('✓ detectSingleResourceType: empty dir → null');
}

// ---------------------------------------------------------------------------
// detectEntityType behavioral changes
// ---------------------------------------------------------------------------

// Skill dir with agents/ subdir → 'resource' (was 'package')
{
  const dir = makeTempDir();
  writeFileSync(join(dir, 'SKILL.md'), '# Skill');
  mkdirSync(join(dir, 'agents'), { recursive: true });
  writeFileSync(join(dir, 'agents', 'helper.md'), '');
  const result = await detectEntityType(dir);
  assert.equal(result, 'resource');
  rmSync(dir, { recursive: true, force: true });
  console.log('✓ detectEntityType: skill dir with agents/ → resource (not package)');
}

// Package dir with openpackage.yml → 'package' (unchanged)
{
  const dir = makeTempDir();
  writeFileSync(join(dir, 'openpackage.yml'), 'name: pkg');
  mkdirSync(join(dir, 'agents'), { recursive: true });
  const result = await detectEntityType(dir);
  assert.equal(result, 'package');
  rmSync(dir, { recursive: true, force: true });
  console.log('✓ detectEntityType: package dir with openpackage.yml → package (unchanged)');
}

// Workspace dir → 'workspace' (unchanged)
{
  const dir = makeTempDir();
  mkdirSync(join(dir, '.openpackage'), { recursive: true });
  writeFileSync(join(dir, '.openpackage', 'openpackage.yml'), 'name: ws');
  const result = await detectEntityType(dir);
  assert.equal(result, 'workspace');
  rmSync(dir, { recursive: true, force: true });
  console.log('✓ detectEntityType: workspace dir → workspace (unchanged)');
}

console.log('\n✓ All entity-detector tests passed');
