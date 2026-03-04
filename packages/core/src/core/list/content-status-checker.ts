/**
 * Content Status Checker
 *
 * Lightweight read-only content comparison for the `list --status` feature.
 * Compares workspace file content against package source to detect modifications.
 *
 * For normal files: hash workspace file vs source file.
 * For merged files: extract package contribution via merge keys, then hash-compare.
 */

import path from 'path';

import { calculateFileHash } from '../../utils/hash-utils.js';
import { readTextFile, exists } from '../../utils/fs.js';
import { getTargetPath, isComplexMapping, isMergedMapping } from '../../utils/workspace-index-helpers.js';
import { extractContentByKeys } from '../save/save-merge-extractor.js';
import type { WorkspaceIndexFileMapping } from '../../types/workspace-index.js';
import { logger } from '../../utils/logger.js';

export type ContentStatus = 'modified' | 'clean' | 'merged';

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

      // Fast path: use stored install-time hash when available (skip merged files —
      // their hash reflects the full file at one package's install time, not just that
      // package's contribution, so key-based comparison is needed instead)
      if (isComplexMapping(mapping) && mapping.hash && !isMerged) {
        try {
          const workspaceContent = await readTextFile(absTarget);
          const workspaceHash = await calculateFileHash(workspaceContent);
          results.set(key, workspaceHash === mapping.hash ? 'clean' : 'modified');
          continue;
        } catch (error) {
          logger.debug(`Hash comparison failed for ${absTarget}, falling back: ${error}`);
        }
      }

      if (isMerged) {
        const status = await checkMergedFileStatus(
          absTarget,
          path.join(packageSourceRoot, sourceKey),
          (mapping as WorkspaceIndexFileMapping).keys!
        );
        results.set(key, status);
      } else {
        const status = await checkSimpleFileStatus(
          absTarget,
          path.join(packageSourceRoot, sourceKey)
        );
        results.set(key, status);
      }
    }
  }

  return results;
}

/**
 * Compare a simple (non-merged) file: hash workspace vs source.
 */
async function checkSimpleFileStatus(
  absWorkspacePath: string,
  absSourcePath: string
): Promise<ContentStatus> {
  try {
    if (!(await exists(absSourcePath))) {
      // Source missing — can't compare, treat as clean (no info)
      return 'clean';
    }

    const [workspaceContent, sourceContent] = await Promise.all([
      readTextFile(absWorkspacePath),
      readTextFile(absSourcePath)
    ]);

    const [workspaceHash, sourceHash] = await Promise.all([
      calculateFileHash(workspaceContent),
      calculateFileHash(sourceContent)
    ]);

    return workspaceHash === sourceHash ? 'clean' : 'modified';
  } catch (error) {
    logger.debug(`Content check failed for ${absWorkspacePath}: ${error}`);
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
