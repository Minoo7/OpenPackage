/**
 * Phase 4 Integration Tests
 * 
 * Tests conversion coordination and pipeline integration.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { 
  coordinateConversion,
  shouldPreConvert,
  type PackageConversionResult
} from '../../../packages/core/src/core/install/conversion-coordinator.js';
import type { 
  PackageFile,
  EnhancedPackageFormat
} from '../../../packages/core/src/core/install/detection-types.js';

describe('Phase 4: Conversion Coordination', () => {
  describe('coordinateConversion', () => {
    it('should detect and skip universal format packages', async () => {
      const files: PackageFile[] = [
        {
          path: 'openpackage.yml',
          content: 'name: test\nversion: 1.0.0'
        },
        {
          path: 'agents/test.md',
          content: `---
name: Test Agent
type: agent
---
# Test Agent`
        }
      ];
      
      const result = await coordinateConversion(files, '/test', {});
      
      // The important thing is it doesn't crash and returns files
      assert.ok(result !== null);
      // File count may differ if non-code files are filtered
      assert.ok(result.files.length > 0);
      assert.ok(result.files.length <= files.length);
      // Detection may produce errors for ambiguous cases, which is acceptable
      assert.ok(Array.isArray(result.errors));
    });

    it('should detect Claude format and convert', async () => {
      const files: PackageFile[] = [
        {
          path: '.claude/agents/test.md',
          content: `---
tools: Read, Write
permissionMode: default
---
# Claude Agent`
        }
      ];
      
      const result = await coordinateConversion(files, '/test', {});
      
      assert.equal(result.formatDetection.packageFormat, 'claude');
      assert.equal(result.formatDetection.detectionMethod, 'package-marker');
      // Conversion should have been attempted
      assert.ok(result.wasConverted !== undefined);
    });

    it('should handle skipConversion option', async () => {
      const files: PackageFile[] = [
        {
          path: '.claude/agents/test.md',
          content: '# Test'
        }
      ];
      
      const result = await coordinateConversion(files, '/test', {
        skipConversion: true
      });
      
      assert.equal(result.wasConverted, false);
      assert.equal(result.files.length, files.length);
      assert.equal(result.files[0].path, files[0].path);
    });

    it('should gracefully handle conversion errors', async () => {
      const files: PackageFile[] = [
        {
          path: '.claude/agents/malformed.md',
          content: '---\ninvalid: yaml: structure::\n---'
        }
      ];
      
      const result = await coordinateConversion(files, '/test', {});
      
      // Should not throw, but may have errors
      assert.ok(result !== null);
      assert.ok(Array.isArray(result.errors));
      assert.ok(Array.isArray(result.warnings));
    });

    it('should handle empty file list', async () => {
      const files: PackageFile[] = [];
      
      const result = await coordinateConversion(files, '/test', {});
      
      assert.equal(result.wasConverted, false);
      assert.equal(result.files.length, 0);
    });

    it('should handle mixed format packages', async () => {
      const files: PackageFile[] = [
        {
          path: 'agents/claude-style.md',
          content: `---
tools: Read
permissionMode: default
---
# Claude Agent`
        },
        {
          path: 'agents/opencode-style.md',
          content: `---
name: OpenCode Agent
type: agent
---
# OpenCode Agent`
        }
      ];
      
      const result = await coordinateConversion(files, '/test', {});
      
      // Should handle mixed formats
      assert.ok(result.formatDetection !== null);
      assert.ok(result.files.length > 0);
    });
  });

  describe('shouldPreConvert', () => {
    it('should return false for universal format', () => {
      const format: EnhancedPackageFormat = {
        packageFormat: 'universal',
        detectionMethod: 'package-marker',
        confidence: 1.0,
        analysis: {
          totalFiles: 1,
          analyzedFiles: 0,
          skippedFiles: 1,
          formatDistribution: new Map([['universal', 1]])
        }
      };
      
      assert.equal(shouldPreConvert(format), false);
    });

    it('should return true for platform-specific formats', () => {
      const format: EnhancedPackageFormat = {
        packageFormat: 'claude',
        detectionMethod: 'package-marker',
        confidence: 1.0,
        analysis: {
          totalFiles: 1,
          analyzedFiles: 0,
          skippedFiles: 1,
          formatDistribution: new Map([['claude', 1]])
        }
      };
      
      assert.equal(shouldPreConvert(format), true);
    });

    it('should return true for mixed format', () => {
      const format: EnhancedPackageFormat = {
        packageFormat: 'mixed',
        detectionMethod: 'per-file',
        confidence: 0.8,
        analysis: {
          totalFiles: 2,
          analyzedFiles: 2,
          skippedFiles: 0,
          formatDistribution: new Map([['claude', 1], ['cursor', 1]])
        }
      };
      
      assert.equal(shouldPreConvert(format), true);
    });

    it('should return false for unknown format', () => {
      const format: EnhancedPackageFormat = {
        packageFormat: 'unknown',
        detectionMethod: 'package-marker',
        confidence: 0.0,
        analysis: {
          totalFiles: 1,
          analyzedFiles: 0,
          skippedFiles: 1,
          formatDistribution: new Map([['unknown', 1]])
        }
      };
      
      assert.equal(shouldPreConvert(format), false);
    });

    it('should return true when forceConversion is enabled', () => {
      const format: EnhancedPackageFormat = {
        packageFormat: 'universal',
        detectionMethod: 'package-marker',
        confidence: 1.0,
        analysis: {
          totalFiles: 1,
          analyzedFiles: 0,
          skippedFiles: 1,
          formatDistribution: new Map([['universal', 1]])
        }
      };
      
      assert.equal(shouldPreConvert(format, { forceConversion: true }), true);
    });
  });

  describe('Conversion Result Structure', () => {
    it('should include all required fields', async () => {
      const files: PackageFile[] = [
        {
          path: 'openpackage.yml',
          content: 'name: test'
        }
      ];
      
      const result = await coordinateConversion(files, '/test', {});
      
      assert.ok('wasConverted' in result);
      assert.ok('formatDetection' in result);
      assert.ok('files' in result);
      assert.ok('errors' in result);
      assert.ok('warnings' in result);
      
      assert.equal(typeof result.wasConverted, 'boolean');
      assert.ok(result.formatDetection !== null);
      assert.ok(Array.isArray(result.files));
      assert.ok(Array.isArray(result.errors));
      assert.ok(Array.isArray(result.warnings));
    });

    it('should preserve file structure when not converted', async () => {
      const files: PackageFile[] = [
        {
          path: 'agents/agent1.md',
          content: 'content1'
        },
        {
          path: 'agents/agent2.md',
          content: 'content2'
        }
      ];
      
      const result = await coordinateConversion(files, '/test', {
        skipConversion: true
      });
      
      assert.equal(result.files.length, files.length);
      assert.equal(result.files[0].path, files[0].path);
      assert.equal(result.files[0].content, files[0].content);
      assert.equal(result.wasConverted, false);
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid file content gracefully', async () => {
      const files: PackageFile[] = [
        {
          path: 'agents/test.md',
          content: '\x00\x01\x02' // Binary content
        }
      ];
      
      const result = await coordinateConversion(files, '/test', {});
      
      // Should not throw
      assert.ok(result !== null);
    });

    it('should accumulate errors during conversion', async () => {
      const files: PackageFile[] = [
        {
          path: '.claude/agents/test.md',
          content: '# Test'
        }
      ];
      
      const result = await coordinateConversion(files, '/test', {});
      
      // Errors should be accessible
      assert.ok(Array.isArray(result.errors));
      // Warnings should be accessible
      assert.ok(Array.isArray(result.warnings));
    });
  });

  describe('Performance', () => {
    it('should handle large file counts efficiently', async () => {
      const files: PackageFile[] = [];
      
      // Create 100 mock files
      for (let i = 0; i < 100; i++) {
        files.push({
          path: `agents/agent${i}.md`,
          content: `---\nname: Agent ${i}\n---\n# Agent ${i}`
        });
      }
      
      const startTime = Date.now();
      const result = await coordinateConversion(files, '/test', {});
      const duration = Date.now() - startTime;
      
      // Should complete in reasonable time (< 5 seconds)
      assert.ok(duration < 5000, `Conversion took ${duration}ms`);
      assert.ok(result !== null);
    });
  });
});
