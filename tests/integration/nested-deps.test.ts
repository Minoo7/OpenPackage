import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import dns from 'node:dns/promises';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const cliPath = path.resolve(repoRoot, 'bin/openpackage');
const fixturesDir = path.resolve(__dirname, '../fixtures/nested-deps');

// ── Network gate ──────────────────────────────────────────────────────
try {
  await dns.resolve('github.com');
} catch {
  console.log('⏭️  Skipping nested-deps e2e test (no network)');
  process.exit(0);
}

// ── Helpers ───────────────────────────────────────────────────────────
function runCli(
  args: string[],
  cwd: string,
  env?: Record<string, string | undefined>
): { code: number; stdout: string; stderr: string } {
  const result = spawnSync('node', [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    env: {
      ...process.env,
      ...(env ?? {}),
      TS_NODE_TRANSPILE_ONLY: '1'
    },
    timeout: 180_000
  });
  return {
    code: result.status ?? 1,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim()
  };
}

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function pathExists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}

async function listAllFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { recursive: true });
    return entries.map(String);
  } catch {
    return [];
  }
}

// ── Setup ─────────────────────────────────────────────────────────────
//
// Fixture graph (diamond + conflict + dev-dep):
//
//   test-nested-a (root)
//   ├── deps: test-nested-b, test-nested-c, gh@anthropics/skills/skills/claude-api
//   ├── dev-deps: test-nested-dev
//   ├── rules/formatting.md          ← conflict with package-b
//   └── agents/reviewer.md
//
//   test-nested-b (mid)
//   ├── deps: test-nested-d, gh@wshobson/agents/plugins/shell-scripting
//   ├── rules/formatting.md          ← conflict with package-a
//   └── agents/helper.md
//
//   test-nested-c (mid)
//   ├── deps: test-nested-d           ← diamond with B
//   └── commands/greet.md
//
//   test-nested-d (leaf)
//   └── commands/util.md
//
//   test-nested-dev (leaf, dev-dep)
//   └── rules/dev-only.md
//

const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opkg-nested-deps-'));

try {
  // Copy fixture packages into the workspace
  await copyDir(fixturesDir, path.join(workspaceDir, 'test-packages'));

  // Create platform roots so resource installation has targets
  await fs.mkdir(path.join(workspaceDir, '.cursor'), { recursive: true });
  await fs.mkdir(path.join(workspaceDir, '.claude'), { recursive: true });

  const manifestPath = path.join(workspaceDir, '.openpackage', 'openpackage.yml');
  const indexPath = path.join(workspaceDir, '.openpackage', 'openpackage.index.yml');

  // ================================================================
  // PHASE 1: Install — diamond graph, remote deps, dev-deps, conflicts
  // ================================================================
  console.log('  Phase 1: Install...');

  const installResult = runCli(
    ['install', './test-packages/package-a', '--force', '--conflicts', 'namespace'],
    workspaceDir,
    { CI: 'true' }
  );

  assert.strictEqual(
    installResult.code,
    0,
    `Install should succeed.\nstdout: ${installResult.stdout}\nstderr: ${installResult.stderr}`
  );

  // ── Workspace manifest assertions ─────────────────────────────
  assert.ok(await pathExists(manifestPath), 'Workspace manifest should be created');
  const manifest = await fs.readFile(manifestPath, 'utf8');

  // Root package in manifest
  assert.ok(
    manifest.includes('test-nested-a'),
    'Workspace manifest should list package-a as a dependency'
  );

  // Transitive deps should NOT be in the manifest
  assert.ok(
    !manifest.includes('test-nested-b'),
    'Transitive dep package-b should not appear in workspace manifest'
  );
  assert.ok(
    !manifest.includes('test-nested-c'),
    'Transitive dep package-c should not appear in workspace manifest'
  );
  assert.ok(
    !manifest.includes('test-nested-d'),
    'Transitive dep package-d should not appear in workspace manifest'
  );
  assert.ok(
    !manifest.includes('test-nested-dev'),
    'Dev-dep package-dev should not appear in workspace manifest'
  );

  // ── Workspace index assertions ────────────────────────────────
  assert.ok(await pathExists(indexPath), 'Workspace index should be created');
  const index = await fs.readFile(indexPath, 'utf8');

  // All local packages tracked in index
  assert.ok(index.includes('test-nested-a'), 'Index should track root package (test-nested-a)');
  assert.ok(index.includes('test-nested-b'), 'Index should track transitive dep (test-nested-b)');
  assert.ok(index.includes('test-nested-c'), 'Index should track transitive dep (test-nested-c)');
  assert.ok(index.includes('test-nested-d'), 'Index should track diamond dep (test-nested-d)');
  assert.ok(index.includes('test-nested-dev'), 'Index should track dev-dep (test-nested-dev)');

  // Remote deps tracked in index
  assert.ok(index.includes('anthropics/skills'), 'Index should track remote dep from anthropics/skills');
  assert.ok(index.includes('wshobson/agents'), 'Index should track remote dep from wshobson/agents');

  // Diamond dedup: test-nested-d key should appear exactly once
  const dKeyMatches = index.match(/test-nested-d:/g);
  assert.ok(
    dKeyMatches !== null && dKeyMatches.length === 1,
    `Diamond dep test-nested-d should have exactly one index entry (got ${dKeyMatches?.length ?? 0})`
  );

  // ── Resource file assertions ──────────────────────────────────
  const cursorFiles = await listAllFiles(path.join(workspaceDir, '.cursor'));
  const claudeFiles = await listAllFiles(path.join(workspaceDir, '.claude'));
  const allInstalled = [...cursorFiles, ...claudeFiles];

  // Package-a resources
  assert.ok(
    allInstalled.some(f => f.includes('reviewer')),
    'Resource from package-a (reviewer agent) should be installed'
  );

  // Package-b resources
  assert.ok(
    allInstalled.some(f => f.includes('helper')),
    'Resource from package-b (helper agent) should be installed'
  );

  // Package-c resources
  assert.ok(
    allInstalled.some(f => f.includes('greet')),
    'Resource from package-c (greet command) should be installed'
  );

  // Package-d resources (leaf of diamond)
  assert.ok(
    allInstalled.some(f => f.includes('util')),
    'Resource from package-d (util command) should be installed'
  );

  // Dev-dep resources
  assert.ok(
    allInstalled.some(f => f.includes('dev-only')),
    'Resource from dev-dep package (dev-only rule) should be installed'
  );

  // ── Conflict namespace assertions ─────────────────────────────
  // Both package-a and package-b have rules/formatting.md.
  // With --conflicts namespace, at least one should be prefixed.
  const formattingFiles = allInstalled.filter(f => f.includes('formatting'));
  assert.ok(
    formattingFiles.length >= 2,
    `Both formatting rules should be installed (got ${formattingFiles.length}: ${formattingFiles.join(', ')})`
  );
  assert.ok(
    formattingFiles.some(f => f.includes('test-nested-a') || f.includes('test-nested-b')),
    `At least one formatting file should be namespaced (got: ${formattingFiles.join(', ')})`
  );

  console.log('  Phase 1: Install ✓');

  // ================================================================
  // PHASE 2: Reinstall — idempotency check
  // ================================================================
  console.log('  Phase 2: Reinstall...');

  const reinstallResult = runCli(
    ['install', './test-packages/package-a', '--force', '--conflicts', 'overwrite'],
    workspaceDir,
    { CI: 'true' }
  );

  assert.strictEqual(
    reinstallResult.code,
    0,
    `Reinstall should succeed.\nstdout: ${reinstallResult.stdout}\nstderr: ${reinstallResult.stderr}`
  );

  // Manifest should still have exactly one reference to test-nested-a
  const manifestAfter = await fs.readFile(manifestPath, 'utf8');
  const manifestAMatches = manifestAfter.match(/test-nested-a/g);
  assert.ok(
    manifestAMatches !== null && manifestAMatches.length === 1,
    `Manifest should have exactly one entry for test-nested-a after reinstall (got ${manifestAMatches?.length ?? 0})`
  );

  // Index should still have all packages
  const indexAfter = await fs.readFile(indexPath, 'utf8');
  assert.ok(indexAfter.includes('test-nested-a'), 'Index should still track root after reinstall');
  assert.ok(indexAfter.includes('test-nested-b'), 'Index should still track package-b after reinstall');
  assert.ok(indexAfter.includes('test-nested-d'), 'Index should still track diamond dep after reinstall');

  // Resources should still exist
  const cursorAfter = await listAllFiles(path.join(workspaceDir, '.cursor'));
  const claudeAfter = await listAllFiles(path.join(workspaceDir, '.claude'));
  const allAfter = [...cursorAfter, ...claudeAfter];
  assert.ok(allAfter.some(f => f.includes('reviewer')), 'Reviewer agent should survive reinstall');
  assert.ok(allAfter.some(f => f.includes('greet')), 'Greet command should survive reinstall');
  assert.ok(allAfter.some(f => f.includes('util')), 'Util command should survive reinstall');

  console.log('  Phase 2: Reinstall ✓');

  // ================================================================
  // PHASE 3: Uninstall — root removal, transitive deps preserved
  // ================================================================
  console.log('  Phase 3: Uninstall...');

  const uninstallResult = runCli(
    ['uninstall', 'test-nested-a'],
    workspaceDir,
    { CI: 'true' }
  );

  assert.strictEqual(
    uninstallResult.code,
    0,
    `Uninstall should succeed.\nstdout: ${uninstallResult.stdout}\nstderr: ${uninstallResult.stderr}`
  );

  // Root package should be removed from manifest
  const manifestFinal = await fs.readFile(manifestPath, 'utf8');
  assert.ok(
    !manifestFinal.includes('test-nested-a'),
    'Workspace manifest should no longer reference test-nested-a after uninstall'
  );

  // Root package should be removed from index
  const indexFinal = await fs.readFile(indexPath, 'utf8');
  assert.ok(
    !indexFinal.includes('test-nested-a:'),
    'Index should no longer have test-nested-a entry after uninstall'
  );

  // Transitive deps should still be in the index (uninstall doesn't cascade)
  assert.ok(
    indexFinal.includes('test-nested-b'),
    'Transitive dep package-b should remain in index after root uninstall'
  );
  assert.ok(
    indexFinal.includes('test-nested-d'),
    'Diamond dep package-d should remain in index after root uninstall'
  );

  // Root package's own resource files should be removed
  const cursorFinal = await listAllFiles(path.join(workspaceDir, '.cursor'));
  const claudeFinal = await listAllFiles(path.join(workspaceDir, '.claude'));
  const allFinal = [...cursorFinal, ...claudeFinal];

  // package-a's reviewer agent should be gone
  const reviewerFiles = allFinal.filter(f => f.includes('reviewer'));
  assert.strictEqual(
    reviewerFiles.length,
    0,
    `Reviewer agent (package-a) should be removed after uninstall (found: ${reviewerFiles.join(', ')})`
  );

  // Transitive deps' resources should still exist
  assert.ok(
    allFinal.some(f => f.includes('helper')),
    'Helper agent (package-b) should survive root uninstall'
  );
  assert.ok(
    allFinal.some(f => f.includes('greet')),
    'Greet command (package-c) should survive root uninstall'
  );
  assert.ok(
    allFinal.some(f => f.includes('util')),
    'Util command (package-d) should survive root uninstall'
  );

  console.log('  Phase 3: Uninstall ✓');

  console.log('✅ All nested dependency lifecycle tests passed');
} finally {
  await fs.rm(workspaceDir, { recursive: true, force: true });
}
