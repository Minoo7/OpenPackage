/**
 * Integration test for junk file filtering during add command
 *
 * Reproduces the reported issue where .DS_Store files were being added
 * to the package source when running `opkg add .claude`
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'path';
import { runAddToSourcePipeline } from '../../../packages/core/src/core/add/add-to-source-pipeline.js';
import { ensureDir, writeFile, fileExists, writeWorkspacePackageManifest } from './add-test-helpers.js';

describe('add junk file filtering', { concurrency: 1 }, () => {
  test('.DS_Store files are filtered when adding .claude directory', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opkg-add-junk-integration-'));
    const originalCwd = process.cwd();

    try {
      process.chdir(tmp);
      writeWorkspacePackageManifest(tmp);
      ensureDir(path.join(tmp, '.claude'));

      const commandFile = path.join(tmp, '.claude', 'commands', 'essentials', 'cleanup.md');
      writeFile(commandFile, '# Cleanup Command\n\nCleanup workspace.');

      const ruleFile = path.join(tmp, '.claude', 'rules', 'essentials', 'code.md');
      writeFile(ruleFile, '# Code Rules\n\nCode standards.');

      writeFile(path.join(tmp, '.claude', '.DS_Store'), 'JUNK_DATA_ROOT');
      writeFile(path.join(tmp, '.claude', 'commands', '.DS_Store'), 'JUNK_DATA_COMMANDS');
      writeFile(path.join(tmp, '.claude', 'rules', 'essentials', '.DS_Store'), 'JUNK_DATA_RULES');

      const claudeDir = path.join(tmp, '.claude');
      const result = await runAddToSourcePipeline(undefined, claudeDir, {});

      assert.ok(result.success, result.error);
      assert.equal(result.data?.filesAdded, 2,
        `Expected 2 files to be added, but got ${result.data?.filesAdded}`);

      const expectedCommand = path.join(tmp, '.openpackage', 'commands', 'essentials', 'cleanup.md');
      assert.ok(fileExists(expectedCommand),
        `Expected command file not found at: ${expectedCommand}`);

      const expectedRule = path.join(tmp, '.openpackage', 'rules', 'essentials', 'code.md');
      assert.ok(fileExists(expectedRule),
        `Expected rule file not found at: ${expectedRule}`);

      const checkPaths = [
        path.join(tmp, '.openpackage', '.DS_Store'),
        path.join(tmp, '.openpackage', 'root', '.claude', '.DS_Store'),
        path.join(tmp, '.openpackage', 'root', '.claude', 'commands', '.DS_Store'),
        path.join(tmp, '.openpackage', 'root', '.claude', 'rules', 'essentials', '.DS_Store'),
        path.join(tmp, '.openpackage', 'commands', '.DS_Store'),
        path.join(tmp, '.openpackage', 'rules', 'essentials', '.DS_Store'),
      ];

      for (const checkPath of checkPaths) {
        assert.ok(!fileExists(checkPath),
          `.DS_Store file should not exist at: ${checkPath}`);
      }
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('filters Thumbs.db, npm-debug.log, backup files, and Desktop.ini', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opkg-add-junk-integration-'));
    const originalCwd = process.cwd();

    try {
      process.chdir(tmp);
      writeWorkspacePackageManifest(tmp);
      ensureDir(path.join(tmp, '.cursor'));

      const commandFile = path.join(tmp, '.cursor', 'commands', 'test.md');
      writeFile(commandFile, '# Test Command');

      writeFile(path.join(tmp, '.cursor', 'commands', 'Thumbs.db'), 'JUNK_THUMBS');
      writeFile(path.join(tmp, '.cursor', 'commands', 'npm-debug.log'), 'JUNK_DEBUG');
      writeFile(path.join(tmp, '.cursor', 'commands', 'test~'), 'JUNK_BACKUP');
      writeFile(path.join(tmp, '.cursor', 'commands', 'Desktop.ini'), 'JUNK_INI');

      const cursorDir = path.join(tmp, '.cursor');
      const result = await runAddToSourcePipeline(undefined, cursorDir, {});

      assert.ok(result.success, result.error);
      assert.equal(result.data?.filesAdded, 1,
        `Expected 1 file to be added, but got ${result.data?.filesAdded}`);

      const expectedCommand = path.join(tmp, '.openpackage', 'commands', 'test.md');
      assert.ok(fileExists(expectedCommand),
        `Expected command file not found at: ${expectedCommand}`);

      const junkFiles = ['Thumbs.db', 'npm-debug.log', 'test~', 'Desktop.ini'];
      for (const junkFile of junkFiles) {
        const junkPath = path.join(tmp, '.openpackage', 'commands', junkFile);
        assert.ok(!fileExists(junkPath),
          `Junk file ${junkFile} should not exist at: ${junkPath}`);
      }
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('preserves legitimate dotfiles (.gitignore, .env, .editorconfig)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opkg-add-junk-integration-'));
    const originalCwd = process.cwd();

    try {
      process.chdir(tmp);
      writeWorkspacePackageManifest(tmp);

      writeFile(path.join(tmp, '.gitignore'), 'node_modules/');
      writeFile(path.join(tmp, '.env'), 'SECRET=value');
      writeFile(path.join(tmp, '.editorconfig'), 'root = true');
      writeFile(path.join(tmp, '.DS_Store'), 'JUNK');

      const result = await runAddToSourcePipeline(undefined, tmp, {});

      assert.ok(result.success, result.error);

      const expectedGitignore = path.join(tmp, '.openpackage', 'root', '.gitignore');
      assert.ok(fileExists(expectedGitignore),
        `.gitignore should be preserved at: ${expectedGitignore}`);

      const expectedEnv = path.join(tmp, '.openpackage', 'root', '.env');
      assert.ok(fileExists(expectedEnv),
        `.env should be preserved at: ${expectedEnv}`);

      const expectedEditorconfig = path.join(tmp, '.openpackage', 'root', '.editorconfig');
      assert.ok(fileExists(expectedEditorconfig),
        `.editorconfig should be preserved at: ${expectedEditorconfig}`);

      const dsStorePath = path.join(tmp, '.openpackage', 'root', '.DS_Store');
      assert.ok(!fileExists(dsStorePath),
        `.DS_Store should not exist at: ${dsStorePath}`);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
