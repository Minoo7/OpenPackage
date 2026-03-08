/**
 * Unit tests for buildLocalPackageResult with single-resource directories
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { buildLocalPackageResult } from '../../../packages/core/src/core/view/view-pipeline.js';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// Skill dir with SKILL.md + agents/ + scripts/ → single resource group
{
  const dir = makeTempDir('skill-view-');
  writeFileSync(join(dir, 'SKILL.md'), '# My Skill');
  mkdirSync(join(dir, 'agents'), { recursive: true });
  writeFileSync(join(dir, 'agents', 'analyzer.md'), '# Analyzer');
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'run_eval.py'), 'print("ok")');

  const result = await buildLocalPackageResult('test-skill', dir);
  const groups = result.report.resourceGroups!;

  assert.ok(groups, 'Should have resource groups');
  assert.equal(groups.length, 1, 'Should have exactly 1 group');
  assert.equal(groups[0].resourceType, 'skills');
  assert.equal(groups[0].resources.length, 1, 'Should have exactly 1 resource');
  assert.equal(groups[0].resources[0].name, `skills/${basename(dir)}`);
  assert.equal(groups[0].resources[0].files.length, 3, 'Should include all 3 files');

  rmSync(dir, { recursive: true, force: true });
  console.log('✓ Skill dir → single skills/<name> resource group with all files');
}

// Plugin dir with .claude-plugin/plugin.json → single resource group
{
  const dir = makeTempDir('plugin-view-');
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), '{"name":"my-plugin"}');
  writeFileSync(join(dir, 'readme.md'), '# Plugin');

  const result = await buildLocalPackageResult('test-plugin', dir);
  const groups = result.report.resourceGroups!;

  assert.ok(groups, 'Should have resource groups');
  // May have 1 plugin group from the resource + 1 from marketplace append
  // At minimum, should have the plugins group with a single resource
  const pluginGroups = groups.filter(g => g.resourceType === 'plugins');
  assert.ok(pluginGroups.length >= 1, 'Should have at least 1 plugins group');
  const mainGroup = pluginGroups[0];
  assert.equal(mainGroup.resources[0].name, `plugins/${basename(dir)}`);

  rmSync(dir, { recursive: true, force: true });
  console.log('✓ Plugin dir → single plugins/<name> resource group');
}

// Package dir with openpackage.yml + agents/ + rules/ → multiple resource groups (unchanged)
{
  const dir = makeTempDir('package-view-');
  writeFileSync(join(dir, 'openpackage.yml'), 'name: test-package\nversion: 1.0.0');
  mkdirSync(join(dir, 'agents'), { recursive: true });
  writeFileSync(join(dir, 'agents', 'helper.md'), '# Helper agent');
  mkdirSync(join(dir, 'rules'), { recursive: true });
  writeFileSync(join(dir, 'rules', 'coding.md'), '# Coding rule');

  const result = await buildLocalPackageResult('test-package', dir);
  const groups = result.report.resourceGroups!;

  assert.ok(groups, 'Should have resource groups');
  // Should have separate groups for agents and rules
  const agentGroup = groups.find(g => g.resourceType === 'agents');
  const ruleGroup = groups.find(g => g.resourceType === 'rules');
  assert.ok(agentGroup, 'Should have agents group');
  assert.ok(ruleGroup, 'Should have rules group');

  rmSync(dir, { recursive: true, force: true });
  console.log('✓ Package dir → multiple resource groups (unchanged behavior)');
}

console.log('\n✓ All view-single-resource tests passed');
