/**
 * Stale File Cleanup
 *
 * Detects and removes files that were part of a previous installation but are
 * no longer present in the updated package source. Runs after flow execution
 * (so the new file mapping is known) but before the workspace index is updated
 * (so the previous mapping is still readable).
 *
 * Reuses `removeFileMapping` from the uninstaller for all file removal logic.
 */

import { join } from 'path';

import { removeFileMapping } from '../uninstall/flow-aware-uninstaller.js';
import { cleanupEmptyParents } from '../../utils/cleanup-empty-parents.js';
import { buildPreservedDirectoriesSet } from '../platform/directory-preservation.js';
import { getPlatformRootFileNames, isRootCopyPath } from '../platform/platform-root-files.js';
import { isDirKey } from '../../utils/package-index-yml.js';
import { getTargetPath } from '../../utils/workspace-index-helpers.js';
import { normalizePathForProcessing } from '../../utils/path-normalization.js';
import { walkFiles } from '../../utils/fs.js';
import {
  loadOtherPackageIndexes,
  buildExpandedIndexesContext,
} from './index-based-installer.js';
import {
  type OwnershipContext,
} from './conflicts/file-conflict-resolver.js';
import { logger } from '../../utils/logger.js';
import type { Platform } from '../platforms.js';
import type { WorkspaceIndexFileMapping } from '../../types/workspace-index.js';

// ============================================================================
// Types
// ============================================================================

export interface StaleCleanupResult {
  /** Workspace-relative paths fully removed from disk */
  deleted: string[];
  /** Merge files that had keys removed but were not deleted */
  updated: string[];
}

// ============================================================================
// Main
// ============================================================================

export async function removeStaleFiles(options: {
  cwd: string;
  packageName: string;
  previousFiles: Record<string, (string | WorkspaceIndexFileMapping)[]>;
  newFileMapping: Record<string, (string | WorkspaceIndexFileMapping)[]>;
  platforms: Platform[];
  dryRun: boolean;
  matchedPattern?: string;
  ownershipContext?: OwnershipContext;
}): Promise<StaleCleanupResult> {
  const {
    cwd,
    packageName,
    previousFiles,
    newFileMapping,
    platforms,
    dryRun,
    matchedPattern,
    ownershipContext,
  } = options;

  const deleted: string[] = [];
  const updated: string[] = [];

  if (dryRun) {
    return { deleted, updated };
  }

  // -------------------------------------------------------------------
  // 1. Filter for resource scope
  // -------------------------------------------------------------------
  let scopedPreviousFiles = previousFiles;

  if (matchedPattern) {
    // Extract the non-glob prefix from the matched pattern to determine scope
    const normalizedPattern = matchedPattern.replace(/\\/g, '/');
    const firstGlob = normalizedPattern.search(/[*?{[]/);
    const scopePrefix = firstGlob > 0
      ? normalizedPattern.slice(0, firstGlob)
      : firstGlob === -1
        ? normalizedPattern
        : '';

    if (scopePrefix) {
      scopedPreviousFiles = {};
      for (const [key, values] of Object.entries(previousFiles)) {
        const normalizedKey = key.replace(/\\/g, '/');
        if (normalizedKey.startsWith(scopePrefix) || scopePrefix.startsWith(normalizedKey)) {
          scopedPreviousFiles[key] = values;
        }
      }
    }
  }

  // -------------------------------------------------------------------
  // 2. Build previous target map
  // -------------------------------------------------------------------
  const rootFileNames = getPlatformRootFileNames(platforms, cwd);
  const previousTargetMap = new Map<string, string | WorkspaceIndexFileMapping>();

  for (const [sourceKey, mappings] of Object.entries(scopedPreviousFiles)) {
    // Skip root file keys (managed by root file system via delimiters)
    if (rootFileNames.has(sourceKey)) continue;

    // Skip root-copy keys (managed by root file phase)
    if (isRootCopyPath(sourceKey)) continue;

    if (isDirKey(sourceKey)) {
      // Directory key: expand to actual files on disk
      for (const mapping of mappings) {
        const dirRel = getTargetPath(mapping);
        const absDir = join(cwd, dirRel);
        try {
          for await (const absFile of walkFiles(absDir)) {
            const rel = normalizePathForProcessing(
              absFile.slice(cwd.length + 1)
            );
            // Map each expanded file to the dir-level mapping
            previousTargetMap.set(rel, mapping);
          }
        } catch {
          // Directory may not exist — fine, no stale files from it
        }
      }
    } else {
      // File key: normalize target path
      for (const mapping of mappings) {
        const target = normalizePathForProcessing(getTargetPath(mapping));
        previousTargetMap.set(target, mapping);
      }
    }
  }

  // -------------------------------------------------------------------
  // 3. Build new target set
  // -------------------------------------------------------------------
  const newTargetSet = new Set<string>();

  for (const [sourceKey, mappings] of Object.entries(newFileMapping)) {
    if (isDirKey(sourceKey)) {
      for (const mapping of mappings) {
        const dirRel = getTargetPath(mapping);
        const absDir = join(cwd, dirRel);
        try {
          for await (const absFile of walkFiles(absDir)) {
            const rel = normalizePathForProcessing(
              absFile.slice(cwd.length + 1)
            );
            newTargetSet.add(rel);
          }
        } catch {
          // Directory may not exist yet
        }
      }
    } else {
      for (const mapping of mappings) {
        newTargetSet.add(normalizePathForProcessing(getTargetPath(mapping)));
      }
    }
  }

  // -------------------------------------------------------------------
  // 4. Build or reuse ownership context
  // -------------------------------------------------------------------
  let installedPathOwners: Map<string, unknown>;

  if (ownershipContext) {
    installedPathOwners = ownershipContext.expandedIndexes.installedPathOwners;
  } else {
    try {
      const otherIndexes = await loadOtherPackageIndexes(cwd, packageName);
      const ctx = await buildExpandedIndexesContext(cwd, otherIndexes);
      installedPathOwners = ctx.installedPathOwners;
    } catch {
      installedPathOwners = new Map();
    }
  }

  // -------------------------------------------------------------------
  // 5. Compute and execute stale removals
  // -------------------------------------------------------------------
  const absoluteDeletedPaths: string[] = [];

  for (const [prevPath, prevMapping] of previousTargetMap) {
    if (newTargetSet.has(prevPath)) continue;

    // Skip if another package owns this path
    if (installedPathOwners.has(prevPath)) continue;

    try {
      const result = await removeFileMapping(cwd, prevMapping, packageName);

      if (result.removed.length > 0) {
        deleted.push(...result.removed);
        absoluteDeletedPaths.push(
          ...result.removed.map(rel => join(cwd, rel))
        );
      }

      if (result.updated.length > 0) {
        updated.push(...result.updated);
      }
    } catch (error) {
      logger.warn(
        `Failed to remove stale file ${prevPath} for ${packageName}: ${error}`
      );
    }
  }

  // -------------------------------------------------------------------
  // 6. Clean up empty directories
  // -------------------------------------------------------------------
  if (absoluteDeletedPaths.length > 0) {
    try {
      const preserved = buildPreservedDirectoriesSet(cwd);
      await cleanupEmptyParents(cwd, absoluteDeletedPaths, preserved);
    } catch (error) {
      logger.debug(`Empty directory cleanup failed: ${error}`);
    }
  }

  return { deleted, updated };
}
