/**
 * Sync Push-Delete Executor
 *
 * Propagates workspace file deletions to the package source.
 * When a user deletes ALL workspace copies of a source file, this executor
 * prompts (or auto-resolves) and deletes the source file + updates the index.
 */

import path from 'path';

import type { ExecutionContext } from '../../types/execution-context.js';
import type { SyncFileResult, SyncOptions, WorkspaceDeletedEntry } from './sync-types.js';
import { remove, exists } from '../../utils/fs.js';
import { removeWorkspaceIndexFileKeys } from '../../utils/workspace-index-ownership.js';
import { cleanupEmptyParents } from '../../utils/cleanup-empty-parents.js';
import { readWorkspaceIndex, writeWorkspaceIndex } from '../../utils/workspace-index-yml.js';
import { resolvePrompt } from '../ports/resolve.js';
import { logger } from '../../utils/logger.js';

/**
 * Execute push-delete actions — delete source files for workspace-deleted entries.
 *
 * Two phases:
 * 1. Resolve: check source exists, prompt or auto-resolve per flags, delete source
 * 2. Cleanup: update index and remove empty parent directories
 *
 * Workspace copies are already gone (that's the detection premise), so only
 * source files and index entries need cleanup.
 */
export async function executePushDeleteActions(
  entries: WorkspaceDeletedEntry[],
  packageName: string,
  packageRoot: string,
  cwd: string,
  options: SyncOptions,
  ctx?: ExecutionContext,
): Promise<SyncFileResult[]> {
  if (entries.length === 0) return [];

  const results: SyncFileResult[] = [];
  const confirmedSourceKeys = new Set<string>();
  const deletedSourcePaths: string[] = [];

  for (const entry of entries) {
    const { sourceKey, allTargets } = entry;
    const absSource = path.join(packageRoot, sourceKey);

    // Skip if source is already gone (avoid prompting for nothing)
    if (!(await exists(absSource))) {
      continue;
    }

    if (options.dryRun) {
      pushResults(results, sourceKey, allTargets, 'removed', '(dry-run)');
      confirmedSourceKeys.add(sourceKey);
      continue;
    }

    const action = resolveAction(options, ctx);

    if (action === 'prompt') {
      const prompt = resolvePrompt(ctx);
      const choice = await prompt.select<'delete' | 'skip'>(
        `Workspace file deleted: ${sourceKey} — propagate deletion to source?`,
        [
          { title: 'Delete from source (push delete)', value: 'delete' },
          { title: 'Keep source (skip)', value: 'skip' },
        ],
      );
      if (choice === 'skip') {
        pushResults(results, sourceKey, allTargets, 'skipped', 'user kept source');
        continue;
      }
    } else if (action === 'skip') {
      pushResults(results, sourceKey, allTargets, 'skipped', 'auto-skipped (flag)');
      continue;
    }

    try {
      await remove(absSource);
      deletedSourcePaths.push(absSource);
      confirmedSourceKeys.add(sourceKey);
      pushResults(results, sourceKey, allTargets, 'removed');
    } catch (error) {
      logger.debug(`Push-delete failed for ${sourceKey}: ${error}`);
      pushResults(results, sourceKey, allTargets, 'error',
        error instanceof Error ? error.message : String(error));
    }
  }

  // Update index and clean up empty source directories
  if (!options.dryRun && confirmedSourceKeys.size > 0) {
    try {
      const record = await readWorkspaceIndex(cwd);
      removeWorkspaceIndexFileKeys(record.index, packageName, confirmedSourceKeys);
      await writeWorkspaceIndex(record);
      logger.debug(`Push-deleted ${confirmedSourceKeys.size} source key(s) from index for ${packageName}`);
    } catch (error) {
      logger.warn(`Failed to update workspace index after push-delete: ${error}`);
    }

    if (deletedSourcePaths.length > 0) {
      try {
        await cleanupEmptyParents(packageRoot, deletedSourcePaths, new Set());
      } catch (error) {
        logger.warn(`Failed to clean up empty source parents: ${error}`);
      }
    }
  }

  return results;
}

function pushResults(
  results: SyncFileResult[],
  sourceKey: string,
  allTargets: string[],
  action: SyncFileResult['action'],
  detail?: string,
): void {
  for (const tp of allTargets) {
    results.push({ sourceKey, targetPath: tp, action, detail });
  }
}

/**
 * Determine the action to take based on sync options and execution context.
 */
function resolveAction(
  options: SyncOptions,
  ctx?: ExecutionContext,
): 'delete' | 'skip' | 'prompt' {
  // Force flag or workspace-wins strategy → auto-delete
  if (options.force || options.conflicts === 'workspace') {
    return 'delete';
  }

  // Source-wins, skip, or auto strategy → auto-skip
  if (options.conflicts === 'source' || options.conflicts === 'skip' || options.conflicts === 'auto') {
    return 'skip';
  }

  // Non-interactive context (e.g. --json) → auto-skip
  if (!ctx?.prompt) {
    return 'skip';
  }

  // Interactive mode → prompt
  return 'prompt';
}
