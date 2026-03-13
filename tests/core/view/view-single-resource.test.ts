/**
 * Unit tests for buildLocalPackageResult with single-resource directories
 */

import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { buildLocalPackageResult } from '../../../packages/core/src/core/view/view-pipeline.js';

let tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe('buildLocalPackageResult', () => {
  it('groups all files into a single skills resource for a skill directory', async () => {
    const dir = makeTempDir('skill-view-');
    writeFileSync(join(dir, 'SKILL.md'), '# My Skill');
    mkdirSync(join(dir, 'agents'), { recursive: true });
    writeFileSync(join(dir, 'agents', 'analyzer.md'), '# Analyzer');
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'run_eval.py'), 'print("ok")');

    const result = await buildLocalPackageResult('test-skill', dir);
    const groups = result.report.resourceGroups;

    assert.ok(Array.isArray(groups), 'resourceGroups should be an array');
    assert.equal(groups.length, 1, 'Should have exactly 1 group');
    assert.equal(groups[0].resourceType, 'skills');
    assert.equal(groups[0].resources.length, 1, 'Should have exactly 1 resource');
    assert.equal(groups[0].resources[0].name, `skills/${basename(dir)}`);
    assert.equal(groups[0].resources[0].files.length, 3, 'Should include all 3 files');
  });

  it('groups all files into a single plugins resource for a plugin directory', async () => {
    const dir = makeTempDir('plugin-view-');
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), '{"name":"my-plugin"}');
    writeFileSync(join(dir, 'readme.md'), '# Plugin');

    const result = await buildLocalPackageResult('test-plugin', dir);
    const groups = result.report.resourceGroups;

    assert.ok(Array.isArray(groups), 'resourceGroups should be an array');
    const pluginGroups = groups.filter(g => g.resourceType === 'plugins');
    assert.ok(pluginGroups.length >= 1 && pluginGroups.length <= 2,
      `Expected 1-2 plugin groups (1 from resource + possibly 1 from marketplace append), got ${pluginGroups.length}`);
    assert.equal(pluginGroups[0].resources.length, 1, 'Primary plugin group should have exactly 1 resource');
    assert.equal(pluginGroups[0].resources[0].name, `plugins/${basename(dir)}`);
    assert.ok(pluginGroups[0].resources[0].files.length >= 1, 'Plugin resource should have at least 1 file');
  });

  it('splits files into separate resource groups for a full package directory', async () => {
    const dir = makeTempDir('package-view-');
    writeFileSync(join(dir, 'openpackage.yml'), 'name: test-package\nversion: 1.0.0');
    mkdirSync(join(dir, 'agents'), { recursive: true });
    writeFileSync(join(dir, 'agents', 'helper.md'), '# Helper agent');
    mkdirSync(join(dir, 'rules'), { recursive: true });
    writeFileSync(join(dir, 'rules', 'coding.md'), '# Coding rule');

    const result = await buildLocalPackageResult('test-package', dir);
    const groups = result.report.resourceGroups;

    assert.ok(Array.isArray(groups), 'resourceGroups should be an array');
    assert.ok(groups.length >= 2, `Should have at least 2 resource groups, got ${groups.length}`);

    const agentGroup = groups.find(g => g.resourceType === 'agents');
    const ruleGroup = groups.find(g => g.resourceType === 'rules');

    assert.ok(agentGroup, 'Should have an agents group');
    assert.equal(agentGroup!.resources.length, 1, 'Should have 1 agent resource');
    assert.equal(agentGroup!.resources[0].files.length, 1, 'Agent resource should have 1 file');

    assert.ok(ruleGroup, 'Should have a rules group');
    assert.equal(ruleGroup!.resources.length, 1, 'Should have 1 rule resource');
    assert.equal(ruleGroup!.resources[0].files.length, 1, 'Rule resource should have 1 file');
  });
});
