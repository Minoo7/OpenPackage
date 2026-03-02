/**
 * Tests for save-new-file-detector.ts
 *
 * Covers:
 * - isMarkerBasedResource: marker vs non-marker type detection
 * - computeCommonSourcePrefix: prefix extraction from source keys
 * - detectNewWorkspaceFiles: full detection for a single resource
 * - detectAllNewWorkspaceFiles: detection across multiple resources in a package
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { ensureDir, writeTextFile } from '../../../packages/core/src/utils/fs.js';
import { clearPlatformsCache } from '../../../packages/core/src/core/platforms.js';
import {
  detectNewWorkspaceFiles,
  detectAllNewWorkspaceFiles,
  _isMarkerBasedResource,
  _computeCommonSourcePrefix,
} from '../../../packages/core/src/core/save/save-new-file-detector.js';

describe('save-new-file-detector', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'opkg-newfile-test-'));
  });

  afterEach(() => {
    clearPlatformsCache();
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // -----------------------------------------------------------------------
  // _isMarkerBasedResource
  // -----------------------------------------------------------------------

  describe('isMarkerBasedResource', () => {
    it('should return true for skill keys', () => {
      assert.strictEqual(
        _isMarkerBasedResource(new Set(['skills/my-skill/SKILL.md'])),
        true
      );
    });

    it('should return true for skill keys with nested paths', () => {
      assert.strictEqual(
        _isMarkerBasedResource(new Set(['skills/org/my-skill/SKILL.md', 'skills/org/my-skill/lib.ts'])),
        true
      );
    });

    it('should return false for rule keys', () => {
      assert.strictEqual(
        _isMarkerBasedResource(new Set(['rules/my-rule.mdc'])),
        false
      );
    });

    it('should return false for agent keys', () => {
      assert.strictEqual(
        _isMarkerBasedResource(new Set(['agents/my-agent.md'])),
        false
      );
    });

    it('should return false for command keys', () => {
      assert.strictEqual(
        _isMarkerBasedResource(new Set(['commands/my-cmd.md'])),
        false
      );
    });

    it('should return false for hook keys', () => {
      assert.strictEqual(
        _isMarkerBasedResource(new Set(['hooks/my-hook.md'])),
        false
      );
    });

    it('should return false for empty set', () => {
      assert.strictEqual(
        _isMarkerBasedResource(new Set()),
        false
      );
    });
  });

  // -----------------------------------------------------------------------
  // _computeCommonSourcePrefix
  // -----------------------------------------------------------------------

  describe('computeCommonSourcePrefix', () => {
    it('should extract prefix from skill keys', () => {
      const result = _computeCommonSourcePrefix(
        new Set(['skills/skill-dev/SKILL.md', 'skills/skill-dev/lib.ts'])
      );
      assert.strictEqual(result, 'skills/skill-dev/');
    });

    it('should extract prefix from deeply nested skill keys', () => {
      const result = _computeCommonSourcePrefix(
        new Set(['skills/org/my-skill/SKILL.md', 'skills/org/my-skill/helper.ts'])
      );
      assert.strictEqual(result, 'skills/org/my-skill/');
    });

    it('should return empty for category-level keys (only 2 segments)', () => {
      const result = _computeCommonSourcePrefix(
        new Set(['rules/my-rule.mdc'])
      );
      assert.strictEqual(result, '');
    });

    it('should find common prefix across divergent paths', () => {
      const result = _computeCommonSourcePrefix(
        new Set([
          'skills/my-skill/sub1/file1.ts',
          'skills/my-skill/sub2/file2.ts',
        ])
      );
      assert.strictEqual(result, 'skills/my-skill/');
    });

    it('should return empty for an empty set', () => {
      const result = _computeCommonSourcePrefix(new Set());
      assert.strictEqual(result, '');
    });
  });

  // -----------------------------------------------------------------------
  // detectNewWorkspaceFiles
  // -----------------------------------------------------------------------

  describe('detectNewWorkspaceFiles', () => {
    it('should return empty for non-marker types', async () => {
      const sourceKeys = new Set(['rules/my-rule.mdc']);
      const filesMapping = {
        'rules/my-rule.mdc': ['.claude/rules/my-rule.mdc'],
      };

      const result = await detectNewWorkspaceFiles(sourceKeys, filesMapping, testDir);
      assert.deepStrictEqual(result, {});
    });

    it('should detect new files in a skill directory', async () => {
      // Set up workspace directory structure
      const skillDir = join(testDir, '.claude', 'skills', 'skill-dev');
      await ensureDir(skillDir);
      await writeTextFile(join(skillDir, 'SKILL.md'), '# Skill');
      await writeTextFile(join(skillDir, 'evals.json'), '{}');

      const sourceKeys = new Set(['skills/skill-dev/SKILL.md']);
      const filesMapping = {
        'skills/skill-dev/SKILL.md': ['.claude/skills/skill-dev/SKILL.md'],
      };

      const result = await detectNewWorkspaceFiles(sourceKeys, filesMapping, testDir);

      // Should detect evals.json as new
      assert.ok('skills/skill-dev/evals.json' in result, 'should detect evals.json');
      assert.ok(
        result['skills/skill-dev/evals.json'].some(t => t.includes('evals.json')),
        'target should reference evals.json'
      );
    });

    it('should exclude files already tracked', async () => {
      const skillDir = join(testDir, '.claude', 'skills', 'skill-dev');
      await ensureDir(skillDir);
      await writeTextFile(join(skillDir, 'SKILL.md'), '# Skill');
      await writeTextFile(join(skillDir, 'lib.ts'), 'export const x = 1;');

      const sourceKeys = new Set([
        'skills/skill-dev/SKILL.md',
        'skills/skill-dev/lib.ts',
      ]);
      const filesMapping = {
        'skills/skill-dev/SKILL.md': ['.claude/skills/skill-dev/SKILL.md'],
        'skills/skill-dev/lib.ts': ['.claude/skills/skill-dev/lib.ts'],
      };

      const result = await detectNewWorkspaceFiles(sourceKeys, filesMapping, testDir);

      // Both files are tracked; nothing new
      assert.deepStrictEqual(result, {});
    });

    it('should handle multiple platform directories', async () => {
      // Create the same skill in two platform dirs
      const claudeSkillDir = join(testDir, '.claude', 'skills', 'skill-dev');
      const cursorSkillDir = join(testDir, '.cursor', 'skills', 'skill-dev');
      await ensureDir(claudeSkillDir);
      await ensureDir(cursorSkillDir);
      await writeTextFile(join(claudeSkillDir, 'SKILL.md'), '# Skill');
      await writeTextFile(join(claudeSkillDir, 'evals.json'), '{}');
      await writeTextFile(join(cursorSkillDir, 'SKILL.md'), '# Skill');
      await writeTextFile(join(cursorSkillDir, 'evals.json'), '{}');

      const sourceKeys = new Set(['skills/skill-dev/SKILL.md']);
      const filesMapping = {
        'skills/skill-dev/SKILL.md': [
          '.claude/skills/skill-dev/SKILL.md',
          '.cursor/skills/skill-dev/SKILL.md',
        ],
      };

      const result = await detectNewWorkspaceFiles(sourceKeys, filesMapping, testDir);

      // Should detect evals.json with targets from both platform dirs
      assert.ok('skills/skill-dev/evals.json' in result, 'should detect evals.json');
      const targets = result['skills/skill-dev/evals.json'];
      assert.ok(targets.length >= 2, `should have targets from both platforms, got ${targets.length}`);
    });

    it('should skip non-existent directories gracefully', async () => {
      const sourceKeys = new Set(['skills/skill-dev/SKILL.md']);
      const filesMapping = {
        'skills/skill-dev/SKILL.md': [
          '.claude/skills/skill-dev/SKILL.md',
          '.nonexistent/skills/skill-dev/SKILL.md',
        ],
      };

      // Only create the .claude directory, not .nonexistent
      const skillDir = join(testDir, '.claude', 'skills', 'skill-dev');
      await ensureDir(skillDir);
      await writeTextFile(join(skillDir, 'SKILL.md'), '# Skill');
      await writeTextFile(join(skillDir, 'extra.ts'), 'export {}');

      // Should not throw
      const result = await detectNewWorkspaceFiles(sourceKeys, filesMapping, testDir);
      assert.ok('skills/skill-dev/extra.ts' in result, 'should detect extra.ts from existing dir');
    });

    it('should filter out files outside resource prefix', async () => {
      // Create two skill dirs
      const skillDevDir = join(testDir, '.claude', 'skills', 'skill-dev');
      const otherSkillDir = join(testDir, '.claude', 'skills', 'other-skill');
      await ensureDir(skillDevDir);
      await ensureDir(otherSkillDir);
      await writeTextFile(join(skillDevDir, 'SKILL.md'), '# Dev Skill');
      await writeTextFile(join(skillDevDir, 'new-file.ts'), 'export {}');
      await writeTextFile(join(otherSkillDir, 'SKILL.md'), '# Other Skill');
      await writeTextFile(join(otherSkillDir, 'other-file.ts'), 'export {}');

      // Only saving skill-dev
      const sourceKeys = new Set(['skills/skill-dev/SKILL.md']);
      const filesMapping = {
        'skills/skill-dev/SKILL.md': ['.claude/skills/skill-dev/SKILL.md'],
      };

      const result = await detectNewWorkspaceFiles(sourceKeys, filesMapping, testDir);

      // Should detect new-file.ts from skill-dev, not other-file.ts from other-skill
      assert.ok('skills/skill-dev/new-file.ts' in result, 'should detect new-file.ts');
      assert.ok(!('skills/other-skill/other-file.ts' in result), 'should not detect files from other skill');
      assert.ok(!('skills/other-skill/SKILL.md' in result), 'should not detect marker from other skill');
    });
  });

  // -----------------------------------------------------------------------
  // detectAllNewWorkspaceFiles
  // -----------------------------------------------------------------------

  describe('detectAllNewWorkspaceFiles', () => {
    it('should detect new files across multiple skill resources', async () => {
      // Create two skill dirs with new files
      const skill1Dir = join(testDir, '.claude', 'skills', 'skill-a');
      const skill2Dir = join(testDir, '.claude', 'skills', 'skill-b');
      await ensureDir(skill1Dir);
      await ensureDir(skill2Dir);
      await writeTextFile(join(skill1Dir, 'SKILL.md'), '# Skill A');
      await writeTextFile(join(skill1Dir, 'new-a.ts'), 'export {}');
      await writeTextFile(join(skill2Dir, 'SKILL.md'), '# Skill B');
      await writeTextFile(join(skill2Dir, 'new-b.ts'), 'export {}');

      const filesMapping = {
        'skills/skill-a/SKILL.md': ['.claude/skills/skill-a/SKILL.md'],
        'skills/skill-b/SKILL.md': ['.claude/skills/skill-b/SKILL.md'],
      };

      const result = await detectAllNewWorkspaceFiles(filesMapping, testDir);

      assert.ok('skills/skill-a/new-a.ts' in result, 'should detect new-a.ts');
      assert.ok('skills/skill-b/new-b.ts' in result, 'should detect new-b.ts');
    });

    it('should skip non-marker resources in mixed mapping', async () => {
      // Create a skill dir with new file
      const skillDir = join(testDir, '.claude', 'skills', 'my-skill');
      await ensureDir(skillDir);
      await writeTextFile(join(skillDir, 'SKILL.md'), '# Skill');
      await writeTextFile(join(skillDir, 'evals.json'), '{}');

      // Create a rule (non-marker type)
      const rulesDir = join(testDir, '.claude', 'rules');
      await ensureDir(rulesDir);
      await writeTextFile(join(rulesDir, 'my-rule.md'), '# Rule');

      const filesMapping = {
        'skills/my-skill/SKILL.md': ['.claude/skills/my-skill/SKILL.md'],
        'rules/my-rule.md': ['.claude/rules/my-rule.md'],
      };

      const result = await detectAllNewWorkspaceFiles(filesMapping, testDir);

      // Should detect skill new files but not try to scan rules
      assert.ok('skills/my-skill/evals.json' in result, 'should detect skill evals.json');
      // Rules should not generate any new file entries
      const ruleKeys = Object.keys(result).filter(k => k.startsWith('rules/'));
      assert.strictEqual(ruleKeys.length, 0, 'should not detect new files for rules');
    });
  });
});
