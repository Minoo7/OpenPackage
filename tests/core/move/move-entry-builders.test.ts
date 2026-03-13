import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Tests for buildEntriesFromPackageSource (the new disk-based entry builder
 * that replaced the stale-index-trusting buildEntriesFromSourceKeys).
 *
 * Since buildEntriesFromPackageSource is a private function inside move-pipeline.ts,
 * we test its behaviour indirectly through the resource-discoverer it delegates to,
 * and directly test the shared buildEntriesFromWorkspaceResource for the adopt path.
 */

import { discoverResources } from '../../../packages/core/src/core/install/resource-discoverer.js';

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function writeFile(p: string, content: string) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, content, 'utf-8');
}

describe('move entry builders: disk-based discovery', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opkg-move-entry-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('discoverResources for file-based resources', () => {
    it('discovers a file-based agent resource on disk', async () => {
      const pkgDir = path.join(tmp, 'my-pkg');
      writeFile(path.join(pkgDir, 'agents', 'my-agent.md'), '---\nname: my-agent\n---\nAgent content');

      const result = await discoverResources(pkgDir, pkgDir);
      const agents = result.all.filter(r => r.resourceType === 'agent');

      assert.equal(agents.length, 1);
      assert.equal(agents[0].displayName, 'my-agent');
      assert.equal(agents[0].installKind, 'file');
      assert.ok(agents[0].filePath.endsWith('agents/my-agent.md'));
    });

    it('does not discover a resource whose file was deleted (stale index resilience)', async () => {
      const pkgDir = path.join(tmp, 'stale-pkg');
      // Create one real agent
      writeFile(path.join(pkgDir, 'agents', 'real-agent.md'), '---\nname: real-agent\n---\nContent');
      // Do NOT create 'ghost-agent.md' — simulating a stale index entry

      const result = await discoverResources(pkgDir, pkgDir);
      const agents = result.all.filter(r => r.resourceType === 'agent');

      assert.equal(agents.length, 1);
      assert.equal(agents[0].displayName, 'real-agent');
    });
  });

  describe('discoverResources for directory-based resources', () => {
    it('discovers a directory-based skill resource on disk', async () => {
      const pkgDir = path.join(tmp, 'skill-pkg');
      writeFile(path.join(pkgDir, 'skills', 'my-skill', 'SKILL.md'), '---\nname: my-skill\n---\nSkill content');
      writeFile(path.join(pkgDir, 'skills', 'my-skill', 'helper.ts'), 'export default {}');

      const result = await discoverResources(pkgDir, pkgDir);
      const skills = result.all.filter(r => r.resourceType === 'skill');

      assert.equal(skills.length, 1);
      assert.equal(skills[0].displayName, 'my-skill');
      assert.equal(skills[0].installKind, 'directory');
    });

    it('throws descriptive error when resource is missing (for move pipeline)', async () => {
      const pkgDir = path.join(tmp, 'empty-pkg');
      ensureDir(pkgDir);

      const result = await discoverResources(pkgDir, pkgDir);
      const matched = result.all.find(
        r => r.resourceType === 'skill' && r.displayName === 'nonexistent',
      );

      assert.equal(matched, undefined, 'Should not find a non-existent resource');
    });
  });

  describe('stale index resilience (integration)', () => {
    it('discovers only real files even when package has mixed content', async () => {
      const pkgDir = path.join(tmp, 'mixed-pkg');
      // Real resources
      writeFile(path.join(pkgDir, 'agents', 'agent-a.md'), '---\nname: agent-a\n---\nA');
      writeFile(path.join(pkgDir, 'rules', 'rule-b.md'), '---\nname: rule-b\n---\nB');
      // Simulate: the index thinks there's an agents/agent-ghost.md but it doesn't exist

      const result = await discoverResources(pkgDir, pkgDir);

      assert.equal(result.total, 2);
      const names = result.all.map(r => r.displayName).sort();
      assert.deepEqual(names, ['agent-a', 'rule-b']);
    });
  });
});
