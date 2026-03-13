/**
 * Sync Push Executor
 *
 * Thin adapter that delegates push actions to the existing save pipeline.
 * Filters filesMapping to only include source keys classified as push,
 * then calls executeSavePipeline().
 */

import type { ExecutionContext } from '../../types/execution-context.js';
import type { WorkspaceIndexFileMapping } from '../../types/workspace-index.js';
import type { SyncFileAction, SyncFileResult, SyncOptions } from './sync-types.js';
import type { SaveToSourceOptions } from '../save/save-to-source-pipeline.js';
import { executeSavePipeline } from '../save/save-to-source-pipeline.js';
import { detectAllNewWorkspaceFiles } from '../save/save-new-file-detector.js';
import { initSharedTempDir, cleanupSharedTempDir, clearConversionCache } from '../save/save-conversion-helper.js';
import { logger } from '../../utils/logger.js';

/**
 * Execute push actions by delegating to the save pipeline.
 *
 * @param pushActions - File actions classified as push
 * @param packageName - Package being synced
 * @param packageRoot - Absolute path to mutable package source
 * @param cwd - Workspace root
 * @param fullFilesMapping - Complete file mappings from workspace index
 * @param options - Sync options
 * @param ctx - Execution context
 * @returns Array of SyncFileResult for pushed files
 */
export async function executePushActions(
  pushActions: SyncFileAction[],
  packageName: string,
  packageRoot: string,
  cwd: string,
  fullFilesMapping: Record<string, (string | WorkspaceIndexFileMapping)[]>,
  options: SyncOptions,
  ctx?: ExecutionContext,
): Promise<SyncFileResult[]> {
  if (pushActions.length === 0) return [];

  // Build the set of source keys that need pushing
  const pushSourceKeys = new Set(pushActions.map(a => a.sourceKey));

  // Filter filesMapping to only include push source keys
  const filteredMapping: Record<string, (string | WorkspaceIndexFileMapping)[]> = {};
  for (const [sourceKey, targets] of Object.entries(fullFilesMapping)) {
    if (pushSourceKeys.has(sourceKey)) {
      filteredMapping[sourceKey] = targets;
    }
  }

  // Detect new workspace files (for marker-based resources)
  const newEntries = await detectAllNewWorkspaceFiles(filteredMapping, cwd);
  const augmentedMapping = { ...filteredMapping, ...newEntries };

  if (Object.keys(augmentedMapping).length === 0) {
    return [];
  }

  // Map sync conflict strategy to save conflict strategy
  const saveOptions: SaveToSourceOptions = {
    dryRun: options.dryRun,
    conflicts: mapConflictStrategy(options.conflicts),
    prefer: options.prefer,
  };

  try {
    await initSharedTempDir();
    const result = await executeSavePipeline(
      packageName,
      packageRoot,
      cwd,
      augmentedMapping,
      saveOptions,
      ctx,
    );

    return convertSaveResult(result, pushActions);
  } finally {
    clearConversionCache();
    await cleanupSharedTempDir();
  }
}

/**
 * Map sync conflict strategy → save conflict strategy.
 */
function mapConflictStrategy(
  strategy?: string,
): 'newest' | 'skip' | 'auto' | undefined {
  switch (strategy) {
    case 'workspace': return 'newest';
    case 'skip': return 'skip';
    case 'auto': return 'auto';
    default: return undefined;
  }
}

/**
 * Convert save pipeline CommandResult into SyncFileResult[].
 */
function convertSaveResult(
  result: { success: boolean; data?: any; error?: string },
  pushActions: SyncFileAction[],
): SyncFileResult[] {
  const syncResults: SyncFileResult[] = [];

  if (!result.success) {
    // All push actions failed
    for (const action of pushActions) {
      syncResults.push({
        sourceKey: action.sourceKey,
        targetPath: action.targetPath,
        action: 'error',
        detail: result.error || 'Push failed',
      });
    }
    return syncResults;
  }

  const report = result.data?.report;
  if (!report) {
    // Success but no report — treat as pushed with no details
    for (const action of pushActions) {
      syncResults.push({
        sourceKey: action.sourceKey,
        targetPath: action.targetPath,
        action: 'pushed',
      });
    }
    return syncResults;
  }

  // Build a lookup of successfully written registry paths
  const writtenPaths = new Map<string, { operation: 'created' | 'updated' }>();
  for (const wr of report.writeResults ?? []) {
    if (wr.success && wr.operation.operation !== 'skipped') {
      writtenPaths.set(wr.operation.registryPath, {
        operation: wr.operation.operation,
      });
    }
  }

  // Map each push action to a result
  for (const action of pushActions) {
    const written = writtenPaths.get(action.sourceKey);
    if (written) {
      syncResults.push({
        sourceKey: action.sourceKey,
        targetPath: action.targetPath,
        action: 'pushed',
        operation: written.operation,
      });
    } else {
      // Source key wasn't in write results — may have been skipped by pipeline
      syncResults.push({
        sourceKey: action.sourceKey,
        targetPath: action.targetPath,
        action: 'skipped',
        detail: 'No changes detected by save pipeline',
      });
    }
  }

  return syncResults;
}
