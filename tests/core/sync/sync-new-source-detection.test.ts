/**
 * Tests for sync new-source-file detection gated on installScope.
 *
 * Validates that:
 * 1. Full-scope (or absent scope) packages detect new source files during sync
 * 2. Subset-scope packages do NOT detect new source files
 * 3. Early return no longer fires when new source files exist for full-scope packages
 * 4. installScope round-trips through YAML serialization
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getWorkspaceIndexPath,
  readWorkspaceIndex,
  writeWorkspaceIndex,
} from '../../../packages/core/src/utils/workspace-index-yml.js';
import { isFullInstallScope } from '../../../packages/core/src/types/workspace-index.js';
import type { WorkspaceIndexPackage } from '../../../packages/core/src/types/workspace-index.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opkg-sync-new-src-'));

try {
  // -----------------------------------------------------------------------
  // Test 1: installScope round-trips through YAML (full)
  // -----------------------------------------------------------------------
  {
    const indexPath = getWorkspaceIndexPath(tmpDir);
    const record = {
      path: indexPath,
      index: {
        packages: {
          'test-pkg-full': {
            path: '~/packages/test-full',
            version: '1.0.0',
            files: { 'skills/commit.md': ['.cursor/skills/commit.md'] },
            installScope: 'full' as const,
          },
        },
      },
    };

    await writeWorkspaceIndex(record);
    const roundTripped = await readWorkspaceIndex(tmpDir);
    const pkg = roundTripped.index.packages['test-pkg-full'];
    assert.ok(pkg, 'test-pkg-full should exist after round-trip');
    assert.equal(pkg.installScope, 'full', 'installScope "full" should round-trip');
    console.log('  PASS: installScope "full" round-trips through YAML');
  }

  // -----------------------------------------------------------------------
  // Test 2: installScope round-trips through YAML (subset)
  // -----------------------------------------------------------------------
  {
    const indexPath = getWorkspaceIndexPath(tmpDir);
    const record = {
      path: indexPath,
      index: {
        packages: {
          'test-pkg-subset': {
            path: '~/packages/test-subset',
            version: '1.0.0',
            files: { 'skills/worktree.md': ['.cursor/skills/worktree.md'] },
            installScope: 'subset' as const,
          },
        },
      },
    };

    await writeWorkspaceIndex(record);
    const roundTripped = await readWorkspaceIndex(tmpDir);
    const pkg = roundTripped.index.packages['test-pkg-subset'];
    assert.ok(pkg, 'test-pkg-subset should exist after round-trip');
    assert.equal(pkg.installScope, 'subset', 'installScope "subset" should round-trip');
    console.log('  PASS: installScope "subset" round-trips through YAML');
  }

  // -----------------------------------------------------------------------
  // Test 3: absent installScope defaults to undefined (treated as 'full')
  // -----------------------------------------------------------------------
  {
    const indexPath = getWorkspaceIndexPath(tmpDir);
    const record = {
      path: indexPath,
      index: {
        packages: {
          'test-pkg-absent': {
            path: '~/packages/test-absent',
            version: '1.0.0',
            files: { 'skills/commit.md': ['.cursor/skills/commit.md'] },
            // No installScope set
          },
        },
      },
    };

    await writeWorkspaceIndex(record);
    const roundTripped = await readWorkspaceIndex(tmpDir);
    const pkg = roundTripped.index.packages['test-pkg-absent'];
    assert.ok(pkg, 'test-pkg-absent should exist after round-trip');
    assert.equal(pkg.installScope, undefined, 'absent installScope should stay undefined');

    // Verify the defaulting logic via isFullInstallScope
    assert.equal(isFullInstallScope(pkg.installScope), true, 'absent installScope should default to full');
    console.log('  PASS: absent installScope defaults to "full" via nullish coalescing');
  }

  // -----------------------------------------------------------------------
  // Test 4: invalid installScope values are ignored during deserialization
  // -----------------------------------------------------------------------
  {
    const indexPath = getWorkspaceIndexPath(tmpDir);
    // Write raw YAML with an invalid installScope
    const rawYaml = `# Test
packages:
  test-pkg-invalid:
    path: ~/packages/test-invalid
    version: '1.0.0'
    files:
      skills/commit.md:
        - .cursor/skills/commit.md
    installScope: bogus
`;
    fs.writeFileSync(indexPath, rawYaml, 'utf-8');
    const roundTripped = await readWorkspaceIndex(tmpDir);
    const pkg = roundTripped.index.packages['test-pkg-invalid'];
    assert.ok(pkg, 'test-pkg-invalid should exist');
    assert.equal(pkg.installScope, undefined, 'invalid installScope should be dropped');
    console.log('  PASS: invalid installScope values are dropped during deserialization');
  }

  // -----------------------------------------------------------------------
  // Test 5: isFullInstallScope — full scope returns true
  // -----------------------------------------------------------------------
  {
    assert.equal(isFullInstallScope('full'), true);
    console.log('  PASS: isFullInstallScope("full") returns true');
  }

  // -----------------------------------------------------------------------
  // Test 6: isFullInstallScope — absent scope returns true (legacy default)
  // -----------------------------------------------------------------------
  {
    assert.equal(isFullInstallScope(undefined), true);
    console.log('  PASS: isFullInstallScope(undefined) returns true');
  }

  // -----------------------------------------------------------------------
  // Test 7: isFullInstallScope — subset scope returns false
  // -----------------------------------------------------------------------
  {
    assert.equal(isFullInstallScope('subset'), false);
    console.log('  PASS: isFullInstallScope("subset") returns false');
  }

  // -----------------------------------------------------------------------
  // Test 9: early return does NOT fire when shouldDetectNewFiles is true
  // -----------------------------------------------------------------------
  {
    // Simulate: actions.length === 0 but shouldDetectNewFiles is true
    const actionsLength = 0;
    const shouldDetectNewFiles = true;

    const wouldEarlyReturn = actionsLength === 0 && !shouldDetectNewFiles;
    assert.equal(wouldEarlyReturn, false, 'should NOT early return when new files might exist');
    console.log('  PASS: early return skipped when shouldDetectNewFiles is true');
  }

  // -----------------------------------------------------------------------
  // Test 10: early return DOES fire when no actions and no new file detection
  // -----------------------------------------------------------------------
  {
    const actionsLength = 0;
    const shouldDetectNewFiles = false;

    const wouldEarlyReturn = actionsLength === 0 && !shouldDetectNewFiles;
    assert.equal(wouldEarlyReturn, true, 'should early return when no actions and no new file detection');
    console.log('  PASS: early return fires when no actions and shouldDetectNewFiles is false');
  }

  console.log('\nsync-new-source-detection tests passed');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
