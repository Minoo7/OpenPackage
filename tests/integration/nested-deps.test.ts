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

// ── Test ──────────────────────────────────────────────────────────────
const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opkg-nested-deps-'));

try {
  // Copy fixture packages into the workspace
  await copyDir(fixturesDir, path.join(workspaceDir, 'test-packages'));

  // Create platform roots so resource installation has targets
  await fs.mkdir(path.join(workspaceDir, '.cursor'), { recursive: true });
  await fs.mkdir(path.join(workspaceDir, '.claude'), { recursive: true });

  // ── Install package-a (triggers nested dependency resolution) ─────
  const result = runCli(
    ['install', './test-packages/package-a', '--force', '--conflicts', 'overwrite'],
    workspaceDir,
    { CI: 'true' }
  );

  assert.strictEqual(
    result.code,
    0,
    `Install should succeed.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );

  // ── Workspace manifest should exist and reference root package ────
  const manifestPath = path.join(workspaceDir, '.openpackage', 'openpackage.yml');
  assert.ok(await pathExists(manifestPath), 'Workspace manifest should be created');

  const manifest = await fs.readFile(manifestPath, 'utf8');
  assert.ok(
    manifest.includes('test-nested-a'),
    'Workspace manifest should list package-a as a dependency'
  );

  // Transitive deps should NOT be in the manifest (only in the index)
  assert.ok(
    !manifest.includes('test-nested-b'),
    'Transitive dep package-b should not appear in workspace manifest'
  );
  assert.ok(
    !manifest.includes('test-nested-c'),
    'Transitive dep package-c should not appear in workspace manifest'
  );

  // ── Workspace index should track all installed packages ───────────
  const indexPath = path.join(workspaceDir, '.openpackage', 'openpackage.index.yml');
  assert.ok(await pathExists(indexPath), 'Workspace index should be created');

  const index = await fs.readFile(indexPath, 'utf8');

  // Root package tracked
  assert.ok(
    index.includes('test-nested-a'),
    'Index should track root package (test-nested-a)'
  );

  // Local transitive deps tracked
  assert.ok(
    index.includes('test-nested-b'),
    'Index should track transitive dep (test-nested-b)'
  );
  assert.ok(
    index.includes('test-nested-c'),
    'Index should track transitive dep (test-nested-c)'
  );

  // Remote git deps tracked
  assert.ok(
    index.includes('anthropics/skills'),
    'Index should track remote dep from anthropics/skills'
  );
  assert.ok(
    index.includes('wshobson/agents'),
    'Index should track remote dep from wshobson/agents'
  );

  // ── Resource files should exist on disk ───────────────────────────
  // Check that at least one platform directory received files from the packages.
  // The exact paths depend on platform flow conversion, so we do a broad check.
  const cursorDir = path.join(workspaceDir, '.cursor');
  const claudeDir = path.join(workspaceDir, '.claude');

  const cursorContents = await fs.readdir(cursorDir, { recursive: true });
  const claudeContents = await fs.readdir(claudeDir, { recursive: true });
  const allInstalled = [...cursorContents, ...claudeContents].map(String);

  // Resources from package-a (rules/formatting.md)
  assert.ok(
    allInstalled.some(f => f.includes('formatting')),
    'Resource from package-a (formatting rule) should be installed'
  );

  // Resources from package-b (agents/helper.md)
  assert.ok(
    allInstalled.some(f => f.includes('helper')),
    'Resource from package-b (helper agent) should be installed'
  );

  // Resources from package-c (commands/greet.md)
  assert.ok(
    allInstalled.some(f => f.includes('greet')),
    'Resource from package-c (greet command) should be installed'
  );

  console.log('✅ All nested dependency installation tests passed');
} finally {
  await fs.rm(workspaceDir, { recursive: true, force: true });
}
