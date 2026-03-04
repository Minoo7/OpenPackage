/**
 * Content Status Checker
 *
 * Lightweight read-only content comparison for the `list --status` feature.
 * Compares workspace file content against package source to detect modifications.
 *
 * Uses dual hashes stored at install time:
 * - `hash`: xxhash3 of the workspace file written at install (workspace-side pivot)
 * - `sourceHash`: xxhash3 of the raw source file at install (source-side pivot)
 *
 * For merged files: extract package contribution via merge keys, then hash-compare.
 */

import path from 'path';

import { calculateFileHash } from '../../utils/hash-utils.js';
import { readTextFile, exists } from '../../utils/fs.js';
import { getTargetPath, isComplexMapping, isMergedMapping } from '../../utils/workspace-index-helpers.js';
import { extractContentByKeys } from '../save/save-merge-extractor.js';
import type { WorkspaceIndexFileMapping } from '../../types/workspace-index.js';
import { logger } from '../../utils/logger.js';

export type ContentStatus = 'modified' | 'clean' | 'outdated' | 'diverged' | 'merged';

/**
 * Check content status for all tracked files in a package.
 *
 * @param targetDir - Workspace root directory
 * @param packageSourceRoot - Absolute path to package source directory
 * @param filesMapping - Workspace index file mappings for this package
 * @returns Map keyed by "sourceKey::targetPath" → ContentStatus
 */
export async function checkContentStatus(
  targetDir: string,
  packageSourceRoot: string,
  filesMapping: Record<string, (string | WorkspaceIndexFileMapping)[]>
): Promise<Map<string, ContentStatus>> {
  const results = new Map<string, ContentStatus>();

  for (const [sourceKey, targets] of Object.entries(filesMapping)) {
    if (!Array.isArray(targets) || targets.length === 0) continue;

    for (const mapping of targets) {
      const targetPath = getTargetPath(mapping);
      const key = `${sourceKey}::${targetPath}`;
      const absTarget = path.join(targetDir, targetPath);

      // Skip if workspace file doesn't exist (it's missing, not modified/clean)
      if (!(await exists(absTarget))) continue;

      const isMerged: boolean = isMergedMapping(mapping);

      if (isMerged) {
        const status = await checkMergedFileStatus(
          absTarget,
          path.join(packageSourceRoot, sourceKey),
          (mapping as WorkspaceIndexFileMapping).keys!
        );
        results.set(key, status);
      } else {
        const installHash = isComplexMapping(mapping) ? mapping.hash : undefined;
        const installSourceHash = isComplexMapping(mapping) ? mapping.sourceHash : undefined;
        const absSource = path.join(packageSourceRoot, sourceKey);

        if (installHash) {
          const status = await checkThreeWayStatus(absTarget, absSource, installHash, installSourceHash);
          results.set(key, status);
        } else {
          results.set(key, 'clean');
        }
      }
    }
  }

  return results;
}

/**
 * Three-way status check using dual install-time hashes.
 *
 * Compares workspace content against `installHash` (workspace-side pivot)
 * and source content against `installSourceHash` (source-side pivot).
 * When `installSourceHash` is absent (pre-migration data), treats source as unchanged.
 */
async function checkThreeWayStatus(
  absWorkspacePath: string,
  absSourcePath: string,
  installHash: string,
  installSourceHash?: string
): Promise<ContentStatus> {
  try {
    const workspaceContent = await readTextFile(absWorkspacePath);
    const workspaceHash = await calculateFileHash(workspaceContent);
    const workspaceChanged = workspaceHash !== installHash;

    // If source is missing, only workspace side matters
    if (!(await exists(absSourcePath))) {
      return workspaceChanged ? 'modified' : 'clean';
    }

    // Without installSourceHash (pre-migration), we can't detect source changes
    if (!installSourceHash) {
      return workspaceChanged ? 'modified' : 'clean';
    }

    const sourceContent = await readTextFile(absSourcePath);
    const sourceHash = await calculateFileHash(sourceContent);
    const sourceChanged = sourceHash !== installSourceHash;

    if (!workspaceChanged && !sourceChanged) return 'clean';
    if (workspaceChanged && !sourceChanged) return 'modified';
    if (!workspaceChanged && sourceChanged) return 'outdated';
    return 'diverged';
  } catch (error) {
    logger.debug(`Three-way check failed for ${absWorkspacePath}: ${error}`);
    return 'clean';
  }
}

/**
 * Compare a merged file: extract package contribution from both workspace
 * and source using merge keys, then hash-compare.
 * Falls back to 'merged' if extraction fails.
 */
async function checkMergedFileStatus(
  absWorkspacePath: string,
  absSourcePath: string,
  mergeKeys: string[]
): Promise<ContentStatus> {
  try {
    if (!(await exists(absSourcePath))) {
      return 'merged';
    }

    const [workspaceContent, sourceContent] = await Promise.all([
      readTextFile(absWorkspacePath),
      readTextFile(absSourcePath)
    ]);

    const [workspaceExtract, sourceExtract] = await Promise.all([
      extractContentByKeys(workspaceContent, mergeKeys),
      extractContentByKeys(sourceContent, mergeKeys)
    ]);

    if (!workspaceExtract.success || !sourceExtract.success) {
      return 'merged';
    }

    return workspaceExtract.extractedHash === sourceExtract.extractedHash ? 'clean' : 'modified';
  } catch (error) {
    logger.debug(`Merged content check failed for ${absWorkspacePath}: ${error}`);
    return 'merged';
  }
}
