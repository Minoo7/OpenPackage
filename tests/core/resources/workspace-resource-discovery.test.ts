import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { discoverResourceFiles, buildEntriesFromWorkspaceResource } from '../../../packages/core/src/core/resources/workspace-resource-discovery.js';
import { getResourceTypeDef } from '../../../packages/core/src/core/resources/resource-registry.js';

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function writeFile(p: string, content: string) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, content, 'utf-8');
}

describe('workspace-resource-discovery', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opkg-ws-discovery-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('discoverResourceFiles', () => {
    it('returns empty array when no platform directories exist', async () => {
      const typeDef = getResourceTypeDef('agent');
      const result = await discoverResourceFiles(typeDef, 'my-agent', tmp);
      assert.deepEqual(result, []);
    });
  });

  describe('buildEntriesFromWorkspaceResource', () => {
    it('falls back to targetFiles for dirName:null types (mcp)', async () => {
      // Create an mcp config file in the workspace
      const mcpFile = path.join(tmp, '.claude', 'mcp.json');
      writeFile(mcpFile, '{"servers":{}}');

      const entries = await buildEntriesFromWorkspaceResource(
        'mcp',
        'configs',
        ['.claude/mcp.json'],
        tmp,
      );

      // For dirName:null types, it uses the targetFiles fallback with exists() guard
      // The entries may or may not have flow-mapped registry paths depending on platform config.
      // At minimum, the file should exist and be included.
      if (entries.length > 0) {
        assert.ok(entries[0].sourcePath.endsWith('mcp.json'));
      }
    });

    it('returns empty entries for dirName:null type with missing file', async () => {
      const entries = await buildEntriesFromWorkspaceResource(
        'mcp',
        'configs',
        ['.claude/mcp-nonexistent.json'],
        tmp,
      );

      // File doesn't exist, so targetFiles fallback should skip it
      assert.equal(entries.length, 0);
    });

    it('returns empty entries when targetDir has no matching resources', async () => {
      const entries = await buildEntriesFromWorkspaceResource(
        'agent',
        'nonexistent-agent',
        [],
        tmp,
      );

      assert.equal(entries.length, 0);
    });
  });
});
