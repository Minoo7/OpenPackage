import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import { runCli } from '../../test-helpers.js';

async function setupWorkspace(): Promise<{ cwd: string; home: string }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'opkg-uninstall-home-'));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'opkg-uninstall-ws-'));

  const openpkgDir = path.join(workspace, '.openpackage');
  const pkgDir = path.join(openpkgDir, 'packages', 'my-pkg');
  await fs.mkdir(pkgDir, { recursive: true });
  await fs.mkdir(path.join(workspace, '.claude', 'rules'), { recursive: true });
  await fs.mkdir(path.join(workspace, 'docs'), { recursive: true });

  await fs.writeFile(
    path.join(openpkgDir, 'openpackage.yml'),
    ['name: workspace', 'packages:', '  - name: my-pkg', '    path: ./.openpackage/packages/my-pkg/', ''].join('\n'),
    'utf8'
  );

  await fs.writeFile(path.join(pkgDir, 'openpackage.yml'), ['name: my-pkg', 'version: 1.0.0', ''].join('\n'), 'utf8');

  await fs.writeFile(path.join(pkgDir, 'rules.md'), '# rules\n', 'utf8');

  await fs.writeFile(path.join(workspace, '.claude', 'rules', 'rules.md'), '# rules\n', 'utf8');
  await fs.writeFile(path.join(workspace, 'docs', 'guide.md'), '# guide\n', 'utf8');
  await fs.writeFile(
    path.join(workspace, 'AGENTS.md'),
    ['<!-- package: my-pkg -->', 'owned', '<!-- -->', ''].join('\n'),
    'utf8'
  );

  await fs.writeFile(
    path.join(openpkgDir, 'openpackage.index.yml'),
    [
      '# This file is managed by OpenPackage. Do not edit manually.',
      '',
      'packages:',
      '  my-pkg:',
      '    path: ./.openpackage/packages/my-pkg/',
      '    version: 1.0.0',
      '    files:',
      '      rules/:',
      '        - .claude/rules/',
      '      root/docs/guide.md:',
      '        - docs/guide.md',
      '      AGENTS.md:',
      '        - AGENTS.md',
      ''
    ].join('\n'),
    'utf8'
  );

  return { cwd: workspace, home };
}

async function cleanup(paths: string[]) {
  await Promise.all(paths.map(p => fs.rm(p, { recursive: true, force: true })));
}

describe('uninstall command', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await cleanup(tempDirs);
    tempDirs.length = 0;
  });

  test('removes platform files, root files, and index entries', async () => {
    const { cwd, home } = await setupWorkspace();
    tempDirs.push(cwd, home);

    const res = runCli(['uninstall', 'my-pkg'], cwd, { HOME: home });
    assert.equal(res.code, 0, `uninstall should succeed: ${res.stderr}`);

    const ruleExists = await fs.stat(path.join(cwd, '.claude', 'rules', 'rules.md')).then(() => true).catch(() => false);
    const docsExists = await fs.stat(path.join(cwd, 'docs', 'guide.md')).then(() => true).catch(() => false);
    assert.equal(ruleExists, false, 'platform file should be removed');
    assert.equal(docsExists, false, 'root copy file should be removed');

    // Root file may be updated in-place or deleted entirely if it becomes empty after removals.
    const agentsPath = path.join(cwd, 'AGENTS.md');
    const agentsContent = await fs.readFile(agentsPath, 'utf8').catch(() => null);
    if (agentsContent !== null) {
      assert.ok(!agentsContent.includes('owned'), 'root file section should be removed');
    }

    const indexContent = await fs.readFile(path.join(cwd, '.openpackage', 'openpackage.index.yml'), 'utf8');
    assert.ok(!indexContent.includes('my-pkg'), 'workspace index should remove package entry');

    const manifestContent = await fs.readFile(path.join(cwd, '.openpackage', 'openpackage.yml'), 'utf8');
    assert.ok(!manifestContent.includes('my-pkg'), 'workspace manifest should remove dependency entry');
  });

  test('workspace package appears in resource builder and dry-run succeeds', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'opkg-uninstall-list-home-'));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'opkg-uninstall-list-ws-'));
    tempDirs.push(workspace, home);

    const openpkgDir = path.join(workspace, '.openpackage');
    const pkgDir = path.join(openpkgDir, 'packages', 'my-pkg');
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.mkdir(path.join(workspace, '.opencode', 'command', 'essentials'), { recursive: true });
    await fs.writeFile(path.join(workspace, '.opencode', 'command', 'essentials', 'cleanup.md'), '# cleanup\n', 'utf8');

    // Create workspace manifest with name "test-workspace"
    await fs.writeFile(
      path.join(openpkgDir, 'openpackage.yml'),
      ['name: test-workspace', 'dependencies:', '  - name: my-pkg', ''].join('\n'),
      'utf8'
    );

    // Create index with my-pkg AND workspace package with installed resources
    await fs.writeFile(
      path.join(openpkgDir, 'openpackage.index.yml'),
      [
        '# This file is managed by OpenPackage. Do not edit manually.',
        '',
        'packages:',
        '  my-pkg:',
        '    path: ./.openpackage/packages/my-pkg/',
        '    version: 1.0.0',
        '    files: {}',
        '  test-workspace:',
        '    path: ./.openpackage/',
        '    version: 0.0.0',
        '    files:',
        '      commands/essentials/cleanup.md:',
        '        - .opencode/command/essentials/cleanup.md',
        ''
      ].join('\n'),
      'utf8'
    );

    const { buildWorkspaceResources } = await import('../../../packages/core/src/core/resources/resource-builder.js');
    const { resources, packages } = await buildWorkspaceResources(workspace, 'project');
    assert.ok(packages.some(p => p.packageName === 'test-workspace'), 'workspace package should appear in packages');
    assert.ok(resources.some(r => r.packageName === 'test-workspace'), 'workspace package resources should appear');

    // Direct uninstall of my-pkg still works
    const res = runCli(['uninstall', 'my-pkg', '--dry-run'], workspace, { HOME: home });
    assert.equal(res.code, 0, `uninstall should succeed: ${res.stderr}`);
  });
});
