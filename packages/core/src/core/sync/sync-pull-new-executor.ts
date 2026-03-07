/**
 * Sync Pull-New Executor
 *
 * Handles installing newly detected source files into the workspace
 * and updating the workspace index with proper dual hashes.
 */

import path from 'path';

import type { WorkspaceIndexFileMapping } from '../../types/workspace-index.js';
import type { SyncFileResult, SyncOptions } from './sync-types.js';
import type { NewSourceFileEntry } from './sync-source-scanner.js';
import { readTextFile, exists, writeTextFile, ensureDir } from '../../utils/fs.js';
import { calculateFileHash } from '../../utils/hash-utils.js';
import { readWorkspaceIndex, writeWorkspaceIndex } from '../../utils/workspace-index-yml.js';
import { logger } from '../../utils/logger.js';

/**
 * Pull new source files into the workspace and update the index.
 *
 * @param newFiles - New source file entries detected by sync-source-scanner
 * @param packageName - Package being synced
 * @param packageRoot - Absolute path to package source
 * @param cwd - Workspace root
 * @param options - Sync options (dryRun, etc.)
 * @returns Array of SyncFileResult for newly pulled files
 */
export async function executePullNewActions(
  newFiles: NewSourceFileEntry[],
  packageName: string,
  packageRoot: string,
  cwd: string,
  options: SyncOptions,
): Promise<SyncFileResult[]> {
  if (newFiles.length === 0) return [];

  const results: SyncFileResult[] = [];
  const indexUpdates: Array<{
    registryPath: string;
    targetPath: string;
    hash: string;
    sourceHash: string;
  }> = [];

  for (const entry of newFiles) {
    for (const targetPath of entry.targetPaths) {
      try {
        const result = await pullNewFile(
          entry.registryPath,
          entry.absSourcePath,
          targetPath,
          cwd,
          options.dryRun,
        );
        results.push(result.fileResult);

        if (result.hashes && !options.dryRun) {
          indexUpdates.push({
            registryPath: entry.registryPath,
            targetPath,
            hash: result.hashes.hash,
            sourceHash: result.hashes.sourceHash,
          });
        }
      } catch (error) {
        logger.debug(`Pull-new failed for ${entry.registryPath} → ${targetPath}: ${error}`);
        results.push({
          sourceKey: entry.registryPath,
          targetPath,
          action: 'error',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // Update workspace index with new entries
  if (!options.dryRun && indexUpdates.length > 0) {
    try {
      const record = await readWorkspaceIndex(cwd);
      const pkg = record.index.packages?.[packageName];
      if (pkg) {
        if (!pkg.files) pkg.files = {};

        for (const update of indexUpdates) {
          const mapping: WorkspaceIndexFileMapping = {
            target: update.targetPath,
            hash: update.hash,
            sourceHash: update.sourceHash,
          };

          if (!pkg.files[update.registryPath]) {
            pkg.files[update.registryPath] = [mapping];
          } else {
            pkg.files[update.registryPath].push(mapping);
          }
        }

        await writeWorkspaceIndex(record);
        logger.debug(`Added ${indexUpdates.length} new file(s) to workspace index for ${packageName}`);
      }
    } catch (error) {
      logger.debug(`Failed to update workspace index with new files: ${error}`);
    }
  }

  return results;
}

async function pullNewFile(
  registryPath: string,
  absSourcePath: string,
  targetPath: string,
  cwd: string,
  dryRun: boolean,
): Promise<{
  fileResult: SyncFileResult;
  hashes?: { hash: string; sourceHash: string };
}> {
  const absTarget = path.join(cwd, targetPath);
  const targetExists = await exists(absTarget);

  if (dryRun) {
    return {
      fileResult: {
        sourceKey: registryPath,
        targetPath,
        action: 'pulled',
        operation: targetExists ? 'updated' : 'created',
        detail: '(dry-run)',
      },
    };
  }

  const sourceContent = await readTextFile(absSourcePath);

  // Ensure target directory exists
  await ensureDir(path.dirname(absTarget));

  // Write source content to workspace
  await writeTextFile(absTarget, sourceContent);

  // Compute dual hashes
  const hash = await calculateFileHash(sourceContent);
  const sourceHash = await calculateFileHash(await readTextFile(absSourcePath));

  return {
    fileResult: {
      sourceKey: registryPath,
      targetPath,
      action: 'pulled',
      operation: targetExists ? 'updated' : 'created',
    },
    hashes: { hash, sourceHash },
  };
}
