import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { performMoveCleanup } from '../../../packages/core/src/core/add/move-cleanup.js';
import type { ResolvedResource } from '../../../packages/core/src/core/resources/resource-builder.js';
import type { ExecutionContext } from '../../../packages/core/src/types/execution-context.js';

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function writeFile(p: string, content: string) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, content, 'utf-8');
}

function makeExecContext(targetDir: string): ExecutionContext {
  return {
    targetDir,
    sourceCwd: targetDir,
    scope: 'project',
    interactionPolicy: {
      canPrompt: () => false,
      force: false,
    },
  } as unknown as ExecutionContext;
}

describe('move-cleanup: performMoveCleanup', () => {
  describe('tracked resource cleanup (source-only)', () => {
    it('removes source files from origin package without touching workspace', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opkg-move-cleanup-'));
      try {
        // Set up package source with a resource
        const pkgSourceDir = path.join(tmp, '.openpackage', 'packages', 'origin-pkg');
        writeFile(path.join(pkgSourceDir, 'agents', 'my-agent.md'), 'agent content');

        // Set up workspace target file (should NOT be removed)
        const workspaceFile = path.join(tmp, '.claude', 'agents', 'my-agent.md');
        writeFile(workspaceFile, 'agent content in workspace');

        const resource: ResolvedResource = {
          kind: 'tracked',
          resourceName: 'my-agent',
          resourceType: 'agent',
          packageName: 'origin-pkg',
          sourceKeys: new Set(['agents/my-agent.md']),
          targetFiles: ['.claude/agents/my-agent.md'],
          scope: 'project',
        };

        const result = await performMoveCleanup({
          resource,
          packageSourcePath: pkgSourceDir,
          execContext: makeExecContext(tmp),
        });

        // Source file should be removed
        assert.ok(!fs.existsSync(path.join(pkgSourceDir, 'agents', 'my-agent.md')));
        assert.equal(result.sourceFilesRemoved.length, 1);
        assert.equal(result.sourceFilesRemoved[0], 'agents/my-agent.md');

        // Workspace file should NOT be removed (deferred to sync)
        assert.ok(fs.existsSync(workspaceFile), 'workspace file should remain intact');
        assert.equal(result.workspaceFilesRemoved.length, 0);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('untracked resource cleanup (workspace deletion)', () => {
    it('removes workspace files directly for untracked resources', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opkg-move-cleanup-'));
      try {
        // Set up workspace files (untracked, no package source)
        writeFile(path.join(tmp, '.claude', 'skills', 'my-skill', 'SKILL.md'), 'skill content');

        const resource: ResolvedResource = {
          kind: 'untracked',
          resourceName: 'my-skill',
          resourceType: 'skill',
          packageName: undefined,
          sourceKeys: new Set(),
          targetFiles: ['.claude/skills/my-skill/SKILL.md'],
          scope: 'project',
        };

        const result = await performMoveCleanup({
          resource,
          packageSourcePath: undefined,
          execContext: makeExecContext(tmp),
        });

        // Workspace file should be removed (untracked path)
        assert.ok(!fs.existsSync(path.join(tmp, '.claude', 'skills', 'my-skill', 'SKILL.md')));
        assert.equal(result.workspaceFilesRemoved.length, 1);
        assert.equal(result.workspaceFilesRemoved[0], '.claude/skills/my-skill/SKILL.md');
        assert.equal(result.sourceFilesRemoved.length, 0);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});
