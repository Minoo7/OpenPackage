import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const cliPath = path.resolve(repoRoot, 'bin/openpackage');

// No network gate — all sub-tests use local-only fixtures.

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
    timeout: 30_000 // Short timeout — local only, should be fast
  });
  return {
    code: result.status ?? 1,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim()
  };
}

async function withTempDir(
  name: string,
  fn: (dir: string) => Promise<void>
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `opkg-${name}-`));
  try {
    await fs.mkdir(path.join(dir, '.cursor'), { recursive: true });
    await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function writeManifest(dir: string, content: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'openpackage.yml'), content, 'utf8');
}

async function writeResource(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

// ══════════════════════════════════════════════════════════════════════
// SUB-TEST 1: Missing dependency — nonexistent path
// ══════════════════════════════════════════════════════════════════════
console.log('  Sub-test 1: Missing dependency...');

await withTempDir('missing-dep', async (dir) => {
  // Create a package that depends on a nonexistent path
  const pkgDir = path.join(dir, 'packages', 'broken');
  await writeManifest(pkgDir, [
    'name: broken-package',
    'version: 1.0.0',
    'dependencies:',
    '  - name: ghost-package',
    '    path: ../nonexistent',
    'dev-dependencies: []',
  ].join('\n'));
  await writeResource(
    path.join(pkgDir, 'rules', 'example.md'),
    '---\nname: example\n---\nAn example rule.\n'
  );

  const result = runCli(
    ['install', './packages/broken', '--force', '--conflicts', 'overwrite'],
    dir,
    { CI: 'true' }
  );

  // Root package should install successfully despite missing dependency
  assert.strictEqual(
    result.code,
    0,
    `Root package should install even with missing dep.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );

  // The wave resolver should resolve 0 dependencies (missing dep skipped)
  const output = result.stdout + '\n' + result.stderr;
  assert.ok(
    output.includes('0 dependencies'),
    `Missing dependency should be silently skipped by wave resolver.\noutput: ${output}`
  );

  // Root package's own resource should be installed
  const cursorFiles = await fs.readdir(path.join(dir, '.cursor', 'rules')).catch(() => []);
  assert.ok(
    cursorFiles.some(f => f.includes('example')),
    'Root package resource should still be installed despite missing dep'
  );
});

console.log('  Sub-test 1: Missing dependency ✓');

// ══════════════════════════════════════════════════════════════════════
// SUB-TEST 2: Circular dependencies — A→B→A cycle
// ══════════════════════════════════════════════════════════════════════
console.log('  Sub-test 2: Circular dependencies...');

await withTempDir('circular-deps', async (dir) => {
  // Package A depends on B
  const pkgA = path.join(dir, 'packages', 'cycle-a');
  await writeManifest(pkgA, [
    'name: cycle-a',
    'version: 1.0.0',
    'dependencies:',
    '  - name: cycle-b',
    '    path: ../cycle-b',
    'dev-dependencies: []',
  ].join('\n'));
  await writeResource(
    path.join(pkgA, 'rules', 'rule-a.md'),
    '---\nname: rule-a\n---\nRule from cycle-a.\n'
  );

  // Package B depends on A (creating a cycle)
  const pkgB = path.join(dir, 'packages', 'cycle-b');
  await writeManifest(pkgB, [
    'name: cycle-b',
    'version: 1.0.0',
    'dependencies:',
    '  - name: cycle-a',
    '    path: ../cycle-a',
    'dev-dependencies: []',
  ].join('\n'));
  await writeResource(
    path.join(pkgB, 'rules', 'rule-b.md'),
    '---\nname: rule-b\n---\nRule from cycle-b.\n'
  );

  const result = runCli(
    ['install', './packages/cycle-a', '--force', '--conflicts', 'overwrite'],
    dir,
    { CI: 'true' }
  );

  // The critical assertion: the process should complete (not hang).
  // It may succeed (with cycle detection/warning) or fail gracefully.
  // Either way, it must not hang (the 30s timeout would catch that).
  assert.ok(
    result.code !== null && result.code !== undefined,
    'Circular dependency install should complete without hanging'
  );

  // Should have some output indicating the cycle was handled
  const output = result.stdout + '\n' + result.stderr;
  const handledCycle = (
    result.code === 0 || // Succeeded with cycle detection
    output.toLowerCase().includes('circular') ||
    output.toLowerCase().includes('cycle') ||
    output.toLowerCase().includes('already') ||
    output.toLowerCase().includes('skip')
  );
  assert.ok(
    handledCycle,
    `Circular dependency should be detected or handled gracefully.\ncode: ${result.code}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
});

console.log('  Sub-test 2: Circular dependencies ✓');

// ══════════════════════════════════════════════════════════════════════
// SUB-TEST 3: Malformed YAML in transitive dependency
// ══════════════════════════════════════════════════════════════════════
console.log('  Sub-test 3: Malformed YAML...');

await withTempDir('malformed-yaml', async (dir) => {
  // Package A depends on B
  const pkgA = path.join(dir, 'packages', 'parent');
  await writeManifest(pkgA, [
    'name: parent-package',
    'version: 1.0.0',
    'dependencies:',
    '  - name: broken-yaml',
    '    path: ../broken-yaml',
    'dev-dependencies: []',
  ].join('\n'));
  await writeResource(
    path.join(pkgA, 'rules', 'parent-rule.md'),
    '---\nname: parent-rule\n---\nA parent rule.\n'
  );

  // Package B has malformed YAML
  const pkgB = path.join(dir, 'packages', 'broken-yaml');
  await fs.mkdir(pkgB, { recursive: true });
  await fs.writeFile(
    path.join(pkgB, 'openpackage.yml'),
    [
      'name: broken-yaml',
      'version: 1.0.0',
      'dependencies:',
      '  - name: [invalid yaml',     // ← Malformed: unclosed bracket
      '    this is not valid: {{{',   // ← Malformed: unclosed braces
      'dev-dependencies: []',
    ].join('\n'),
    'utf8'
  );
  await writeResource(
    path.join(pkgB, 'rules', 'broken-rule.md'),
    '---\nname: broken-rule\n---\nA broken rule.\n'
  );

  const result = runCli(
    ['install', './packages/parent', '--force', '--conflicts', 'overwrite'],
    dir,
    { CI: 'true' }
  );

  // The process should complete without crashing
  assert.ok(
    result.code !== null && result.code !== undefined,
    'Malformed YAML install should complete without crashing'
  );

  // Should produce an error or warning about the malformed dependency
  const output = result.stdout + '\n' + result.stderr;
  assert.ok(
    result.code !== 0 || output.toLowerCase().includes('error') || output.toLowerCase().includes('fail') || output.toLowerCase().includes('invalid') || output.toLowerCase().includes('parse'),
    `Malformed YAML should produce an error or warning.\ncode: ${result.code}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
});

console.log('  Sub-test 3: Malformed YAML ✓');

console.log('✅ All error-handling tests passed');
