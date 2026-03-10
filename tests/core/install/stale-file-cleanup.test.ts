/**
 * Tests for stale file cleanup during package re-installation
 * Verifies that orphaned files from previous installs are properly removed
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { removeStaleFiles } from '../../../packages/core/src/core/install/stale-file-cleanup.js';
import type { WorkspaceIndexFileMapping } from '../../../packages/core/src/types/workspace-index.js';
import type { OwnershipContext } from '../../../packages/core/src/core/install/conflicts/file-conflict-resolver.js';

// Helper to create a minimal ownership context with no other packages
function emptyOwnershipContext(): OwnershipContext {
  return {
    expandedIndexes: {
      dirKeyOwners: new Map(),
      installedPathOwners: new Map(),
    },
    previousOwnedPaths: new Set(),
    indexByPackage: new Map(),
  };
}

describe('Stale File Cleanup', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `opkg-stale-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  test('removes stale files that are no longer in the new mapping', async () => {
    // Create files on disk
    await fs.writeFile(join(testDir, 'fileA.md'), 'content A');
    await fs.writeFile(join(testDir, 'fileB.md'), 'content B');
    await fs.writeFile(join(testDir, 'fileC.md'), 'content C');

    const previousFiles: Record<string, (string | WorkspaceIndexFileMapping)[]> = {
      'src/a.md': ['fileA.md'],
      'src/b.md': ['fileB.md'],
      'src/c.md': ['fileC.md'],
    };

    const newFileMapping: Record<string, (string | WorkspaceIndexFileMapping)[]> = {
      'src/a.md': ['fileA.md'],
      'src/b.md': ['fileB.md'],
      // fileC.md is gone — it should be cleaned up
    };

    const result = await removeStaleFiles({
      cwd: testDir,
      packageName: 'test-pkg',
      previousFiles,
      newFileMapping,
      platforms: [],
      dryRun: false,
      ownershipContext: emptyOwnershipContext(),
    });

    assert.strictEqual(result.deleted.length, 1);
    assert.ok(result.deleted.includes('fileC.md'));

    // Verify file was deleted from disk
    const exists = await fs.access(join(testDir, 'fileC.md')).then(() => true, () => false);
    assert.strictEqual(exists, false);

    // Verify other files remain
    const existsA = await fs.access(join(testDir, 'fileA.md')).then(() => true, () => false);
    const existsB = await fs.access(join(testDir, 'fileB.md')).then(() => true, () => false);
    assert.strictEqual(existsA, true);
    assert.strictEqual(existsB, true);
  });

  test('returns empty result when mappings are identical', async () => {
    await fs.writeFile(join(testDir, 'fileA.md'), 'content A');

    const files: Record<string, (string | WorkspaceIndexFileMapping)[]> = {
      'src/a.md': ['fileA.md'],
    };

    const result = await removeStaleFiles({
      cwd: testDir,
      packageName: 'test-pkg',
      previousFiles: files,
      newFileMapping: files,
      platforms: [],
      dryRun: false,
      ownershipContext: emptyOwnershipContext(),
    });

    assert.strictEqual(result.deleted.length, 0);
    assert.strictEqual(result.updated.length, 0);
  });

  test('skips cleanup on dry run', async () => {
    await fs.writeFile(join(testDir, 'fileA.md'), 'content');

    const result = await removeStaleFiles({
      cwd: testDir,
      packageName: 'test-pkg',
      previousFiles: { 'src/a.md': ['fileA.md'] },
      newFileMapping: {},
      platforms: [],
      dryRun: true,
      ownershipContext: emptyOwnershipContext(),
    });

    assert.strictEqual(result.deleted.length, 0);
    assert.strictEqual(result.updated.length, 0);

    // File should still exist
    const exists = await fs.access(join(testDir, 'fileA.md')).then(() => true, () => false);
    assert.strictEqual(exists, true);
  });

  test('cleans up root-prefixed keys like any other key', async () => {
    await fs.writeFile(join(testDir, 'some-root-file.md'), 'content');

    const previousFiles: Record<string, (string | WorkspaceIndexFileMapping)[]> = {
      'root/some-root-file.md': ['some-root-file.md'],
    };

    const result = await removeStaleFiles({
      cwd: testDir,
      packageName: 'test-pkg',
      previousFiles,
      newFileMapping: {},
      platforms: [],
      dryRun: false,
      ownershipContext: emptyOwnershipContext(),
    });

    // root/ keys are now handled by the flow system, so stale cleanup processes them
    assert.strictEqual(result.deleted.length, 1);

    // File should be removed since the key is no longer in new mapping
    const exists = await fs.access(join(testDir, 'some-root-file.md')).then(() => true, () => false);
    assert.strictEqual(exists, false);
  });

  test('handles complex mappings with merge and key tracking', async () => {
    // Create a merged JSON file with keys from this package
    const mergedDir = join(testDir, '.config');
    await fs.mkdir(mergedDir, { recursive: true });
    await fs.writeFile(
      join(mergedDir, 'settings.json'),
      JSON.stringify({
        'pkg-key': { url: 'http://localhost' },
        'other-key': { url: 'http://example.com' },
      }, null, 2)
    );

    const previousFiles: Record<string, (string | WorkspaceIndexFileMapping)[]> = {
      'config.json': [
        {
          target: '.config/settings.json',
          merge: 'deep',
          keys: ['pkg-key'],
        },
      ],
    };

    // New mapping no longer has config.json — stale
    const newFileMapping: Record<string, (string | WorkspaceIndexFileMapping)[]> = {};

    const result = await removeStaleFiles({
      cwd: testDir,
      packageName: 'test-pkg',
      previousFiles,
      newFileMapping,
      platforms: [],
      dryRun: false,
      ownershipContext: emptyOwnershipContext(),
    });

    // Should have updated the merge file (removed keys, not deleted since other content remains)
    assert.strictEqual(result.updated.length, 1);
    assert.ok(result.updated.includes('.config/settings.json'));

    // File should still exist with the other key
    const content = JSON.parse(await fs.readFile(join(mergedDir, 'settings.json'), 'utf-8'));
    assert.strictEqual(content['other-key']?.url, 'http://example.com');
    assert.strictEqual(content['pkg-key'], undefined);
  });

  test('skips files owned by another package', async () => {
    await fs.writeFile(join(testDir, 'shared-file.md'), 'content');

    const ctx = emptyOwnershipContext();
    // Simulate another package owning this file
    ctx.expandedIndexes.installedPathOwners.set('shared-file.md', {
      packageName: 'other-pkg',
      key: 'src/shared.md',
      type: 'file',
    });

    const previousFiles: Record<string, (string | WorkspaceIndexFileMapping)[]> = {
      'src/shared.md': ['shared-file.md'],
    };

    const result = await removeStaleFiles({
      cwd: testDir,
      packageName: 'test-pkg',
      previousFiles,
      newFileMapping: {},
      platforms: [],
      dryRun: false,
      ownershipContext: ctx,
    });

    assert.strictEqual(result.deleted.length, 0);

    // File should still exist
    const exists = await fs.access(join(testDir, 'shared-file.md')).then(() => true, () => false);
    assert.strictEqual(exists, true);
  });

  test('filters previous files by resource scope when matchedPattern is set', async () => {
    await fs.writeFile(join(testDir, 'fileA.md'), 'content A');
    await fs.writeFile(join(testDir, 'fileB.md'), 'content B');

    const previousFiles: Record<string, (string | WorkspaceIndexFileMapping)[]> = {
      'agents/agent1.md': ['fileA.md'],  // In scope
      'skills/skill1.md': ['fileB.md'],  // Out of scope
    };

    const result = await removeStaleFiles({
      cwd: testDir,
      packageName: 'test-pkg',
      previousFiles,
      newFileMapping: {},
      platforms: [],
      dryRun: false,
      matchedPattern: 'agents/**',
      ownershipContext: emptyOwnershipContext(),
    });

    // Only fileA.md should be removed (in scope); fileB.md should remain
    assert.strictEqual(result.deleted.length, 1);
    assert.ok(result.deleted.includes('fileA.md'));

    const existsB = await fs.access(join(testDir, 'fileB.md')).then(() => true, () => false);
    assert.strictEqual(existsB, true);
  });

  test('handles directory key expansion', async () => {
    // Create directory structure
    const dirPath = join(testDir, 'rules');
    await fs.mkdir(dirPath, { recursive: true });
    await fs.writeFile(join(dirPath, 'old-rule.md'), 'old rule');

    const previousFiles: Record<string, (string | WorkspaceIndexFileMapping)[]> = {
      'rules/': ['rules/'],  // dir key (trailing slash)
    };

    // New mapping has no rules/ directory
    const newFileMapping: Record<string, (string | WorkspaceIndexFileMapping)[]> = {};

    const result = await removeStaleFiles({
      cwd: testDir,
      packageName: 'test-pkg',
      previousFiles,
      newFileMapping,
      platforms: [],
      dryRun: false,
      ownershipContext: emptyOwnershipContext(),
    });

    // The dir-level mapping should be passed to removeFileMapping as a simple string 'rules/'
    // which targets the directory content. The individual files under the dir get expanded.
    // Since the mapping is a string 'rules/', removeFileMapping will try to delete it.
    // The expanded file rules/old-rule.md maps to the dir mapping 'rules/' which is a string.
    assert.ok(result.deleted.length >= 1);
  });

  test('cleans up empty parent directories after removal', async () => {
    // Create nested structure
    const nestedDir = join(testDir, 'deep', 'nested', 'dir');
    await fs.mkdir(nestedDir, { recursive: true });
    await fs.writeFile(join(nestedDir, 'file.md'), 'content');

    const previousFiles: Record<string, (string | WorkspaceIndexFileMapping)[]> = {
      'src/file.md': ['deep/nested/dir/file.md'],
    };

    const result = await removeStaleFiles({
      cwd: testDir,
      packageName: 'test-pkg',
      previousFiles,
      newFileMapping: {},
      platforms: [],
      dryRun: false,
      ownershipContext: emptyOwnershipContext(),
    });

    assert.strictEqual(result.deleted.length, 1);

    // Empty parent directories should have been cleaned up
    const deepExists = await fs.access(join(testDir, 'deep')).then(() => true, () => false);
    assert.strictEqual(deepExists, false, 'Empty deep/ directory should be removed');
  });

  test('removes all files when package source is emptied', async () => {
    await fs.writeFile(join(testDir, 'fileA.md'), 'content A');
    await fs.writeFile(join(testDir, 'fileB.md'), 'content B');
    await fs.writeFile(join(testDir, 'fileC.md'), 'content C');

    const previousFiles: Record<string, (string | WorkspaceIndexFileMapping)[]> = {
      'src/a.md': ['fileA.md'],
      'src/b.md': ['fileB.md'],
      'src/c.md': ['fileC.md'],
    };

    const result = await removeStaleFiles({
      cwd: testDir,
      packageName: 'test-pkg',
      previousFiles,
      newFileMapping: {},
      platforms: [],
      dryRun: false,
      ownershipContext: emptyOwnershipContext(),
    });

    assert.strictEqual(result.deleted.length, 3);
  });
});
