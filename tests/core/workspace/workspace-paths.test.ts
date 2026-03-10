import assert from 'node:assert/strict';
import { join } from 'path';

import { isAllowedRegistryPath } from '../../../packages/core/src/core/platform/registry-entry-filter.js';
import { resolveTargetDirectory, resolveTargetFilePath } from '../../../packages/core/src/core/platform/platform-mapper.js';

// Flow-based validation: paths must match universal patterns from platforms.jsonc
// Universal subdirectory paths are allowed
assert.equal(isAllowedRegistryPath('commands/foo.md'), true, 'commands/*.md should be allowed');
assert.equal(isAllowedRegistryPath('rules/bar.md'), true, 'rules/*.md should be allowed');
assert.equal(isAllowedRegistryPath('agents/assistant.md'), true, 'agents/*.md should be allowed');
assert.equal(isAllowedRegistryPath('skills/code-review/analyze.md'), true, 'skills/**/* should be allowed');

// Root-level files defined in flows should be allowed (e.g., mcp.jsonc in cursor/opencode platforms)
assert.equal(isAllowedRegistryPath('mcp.jsonc'), true, 'mcp.jsonc should be allowed (defined in cursor/opencode flows)');

// With catch-all flows (**/* and root/**/*), all paths are now allowed through the flow system
assert.equal(isAllowedRegistryPath('docs/getting-started.md'), true, 'docs/* matched by catch-all **/*');
assert.equal(isAllowedRegistryPath('src/features/foo/bar.md'), true, 'src/* matched by catch-all **/*');
assert.equal(isAllowedRegistryPath('README.md'), true, 'README.md matched by catch-all **/*');
assert.equal(isAllowedRegistryPath('root/tools/helper.sh'), true, 'root/* matched by catch-all root/**/*');
assert.equal(isAllowedRegistryPath('random-file.txt'), true, 'random files matched by catch-all **/*');

// Root registry files are now allowed in flow-based system (handled via global export flows)
assert.equal(isAllowedRegistryPath('AGENTS.md'), true, 'AGENTS.md is allowed via global flows');
assert.equal(isAllowedRegistryPath('CLAUDE.md'), true, 'CLAUDE.md is allowed via platform flows');

// YAML override paths under universal subdirs are blocked
assert.equal(isAllowedRegistryPath('rules/agent.cursor.yml'), false, 'platform-specific yml files blocked');
assert.equal(isAllowedRegistryPath('commands/task.claude.yml'), false, 'platform-specific yml files blocked');

// Resolve target directory/file for generic workspace paths should preserve structure
const packageDir = '/tmp/package-example';
const genericDir = resolveTargetDirectory(packageDir, 'guides/intro.md');
assert.equal(genericDir, join(packageDir, 'guides'));
const genericPath = resolveTargetFilePath(genericDir, 'guides/intro.md');
assert.equal(genericPath, join(packageDir, 'guides', 'intro.md'));

// Universal subdir paths (v2, no .openpackage prefix) preserve the structure
const universalDir = resolveTargetDirectory(packageDir, 'rules/example.md');
assert.equal(universalDir, join(packageDir, 'rules'));
const universalPath = resolveTargetFilePath(universalDir, 'rules/example.md');
assert.equal(universalPath, join(universalDir, 'example.md'));

console.log('workspace path handling tests passed');


