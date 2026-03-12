import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runAddToSourcePipeline } from '../../../packages/core/src/core/add/add-to-source-pipeline.js';
import { getWorkspaceIndexPath } from '../../../packages/core/src/utils/workspace-index-yml.js';
import { ensureDir, writeFile } from './add-test-helpers.js';

const UTF8 = 'utf-8';

function writePackageManifest(pkgDir: string, pkgName: string, version = '1.0.0') {
  const manifest = [`name: ${pkgName}`, `version: ${version}`, ''].join('\n');
  writeFile(path.join(pkgDir, 'openpackage.yml'), manifest);
}

describe('add without installation', { concurrency: 1 }, () => {
  test('works on workspace packages without index entry', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opkg-add-no-index-'));
    const originalCwd = process.cwd();
    try {
      process.chdir(tmp);

      const pkgName = 'workspace-pkg';
      const pkgDir = path.join(tmp, '.openpackage', 'packages', pkgName);

      writePackageManifest(pkgDir, pkgName);

      const fileToAdd = path.join(tmp, 'data', 'config.yml');
      writeFile(fileToAdd, 'config: value');

      const result = await runAddToSourcePipeline(pkgName, 'data/config.yml', {});
      assert.ok(result.success, result.error);
      assert.equal(result.data?.filesAdded, 1);
      assert.equal(result.data?.sourceType, 'workspace');

      const addedFile = path.join(pkgDir, 'root', 'data', 'config.yml');
      assert.ok(fs.existsSync(addedFile), 'File should exist in package source');
      assert.equal(fs.readFileSync(addedFile, UTF8), 'config: value');

      const indexPath = getWorkspaceIndexPath(tmp);
      assert.ok(!fs.existsSync(indexPath), 'Workspace index should not be created by add');
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('works on global packages from any directory', async () => {
    const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'opkg-workspace-'));
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opkg-home-'));
    const originalCwd = process.cwd();
    const originalHome = process.env.HOME;

    try {
      process.env.HOME = tmpHome;
      process.chdir(tmpWorkspace);

      const pkgName = 'global-pkg';
      const pkgDir = path.join(tmpHome, '.openpackage', 'packages', pkgName);

      writePackageManifest(pkgDir, pkgName);

      const fileToAdd = path.join(tmpWorkspace, 'shared', 'utility.sh');
      writeFile(fileToAdd, '#!/bin/bash\necho "utility"');

      const result = await runAddToSourcePipeline(pkgName, 'shared/utility.sh', {});
      assert.ok(result.success, result.error);
      assert.equal(result.data?.filesAdded, 1);
      assert.equal(result.data?.sourceType, 'global');

      const addedFile = path.join(pkgDir, 'root', 'shared', 'utility.sh');
      assert.ok(fs.existsSync(addedFile), 'File should exist in global package source');
      assert.equal(fs.readFileSync(addedFile, UTF8), '#!/bin/bash\necho "utility"');

      const indexPath = getWorkspaceIndexPath(tmpWorkspace);
      assert.ok(!fs.existsSync(indexPath), 'Workspace index should not be created');
    } finally {
      process.chdir(originalCwd);
      if (originalHome !== undefined) {
        process.env.HOME = originalHome;
      } else {
        delete process.env.HOME;
      }
      fs.rmSync(tmpWorkspace, { recursive: true, force: true });
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('rejects registry packages as immutable', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opkg-home-registry-'));
    const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'opkg-workspace-'));
    const originalCwd = process.cwd();
    const originalHome = process.env.HOME;

    try {
      process.env.HOME = tmpHome;
      process.chdir(tmpWorkspace);

      const pkgName = 'registry-pkg';
      const pkgDir = path.join(tmpHome, '.openpackage', 'registry', pkgName, '1.0.0');

      writePackageManifest(pkgDir, pkgName, '1.0.0');

      const fileToAdd = path.join(tmpWorkspace, 'test.md');
      writeFile(fileToAdd, '# Test');

      const result = await runAddToSourcePipeline(pkgName, 'test.md', {});
      assert.ok(!result.success, 'Should fail for registry packages');
      assert.ok(result.error?.includes('not found in workspace or global packages'),
        'Should indicate registry packages are not mutable');
    } finally {
      process.chdir(originalCwd);
      if (originalHome !== undefined) {
        process.env.HOME = originalHome;
      } else {
        delete process.env.HOME;
      }
      fs.rmSync(tmpWorkspace, { recursive: true, force: true });
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
