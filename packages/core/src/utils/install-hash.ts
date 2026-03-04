/**
 * Install Hash Utility
 *
 * Computes the hash of a source file as it would appear after install.
 * Extracted from content-status-checker.ts so it can be reused by the
 * save pipeline's `updateWorkspaceHashes` to store accurate pivot hashes.
 *
 * @module install-hash
 */

import path from 'path';

import { calculateFileHash } from './hash-utils.js';
import { readTextFile } from './fs.js';
import { DefaultFlowExecutor } from '../core/flows/flow-executor.js';
import { mapPlatformFileToUniversal } from '../core/platform/platform-mapper.js';
import { MARKDOWN_EXTENSIONS } from '../constants/index.js';
import type { FlowContext } from '../types/flows.js';

/**
 * Compute the hash of a source file as it would appear after install.
 *
 * For markdown files deployed to a platform directory, runs the source through
 * the flow executor's own loadSourceFile -> serializeTargetContent path -- the
 * same code the installer uses.  This accounts for platform frontmatter merge,
 * YAML re-serialization, and any future install-time transforms without
 * maintaining a separate replica of the pipeline.
 *
 * @param absSourcePath - Absolute path to the source file in the package
 * @param absWorkspacePath - Absolute path to the workspace target file
 * @param targetDir - Workspace root directory
 * @returns Hash string of the source file as it would appear post-install
 */
export async function computeSourceHash(
  absSourcePath: string,
  absWorkspacePath: string,
  targetDir: string
): Promise<string> {
  const ext = path.extname(absSourcePath).toLowerCase();

  if (MARKDOWN_EXTENSIONS.has(ext)) {
    try {
      const platformInfo = mapPlatformFileToUniversal(absWorkspacePath, targetDir);
      const executor = new DefaultFlowExecutor();
      const context: FlowContext = {
        workspaceRoot: targetDir,
        packageRoot: path.dirname(absSourcePath),
        platform: platformInfo?.platform ?? 'claude',
        packageName: '',
        direction: 'install',
        variables: {}
      };
      const loaded = await executor.loadSourceFile(absSourcePath, context);
      const serialized = executor.serializeTargetContent(loaded.data, loaded.format);
      return calculateFileHash(serialized);
    } catch {
      const sourceContent = await readTextFile(absSourcePath);
      return calculateFileHash(sourceContent);
    }
  }

  const sourceContent = await readTextFile(absSourcePath);
  return calculateFileHash(sourceContent);
}
