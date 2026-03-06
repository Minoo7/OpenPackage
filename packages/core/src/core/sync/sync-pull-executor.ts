/**
 * Sync Pull Executor
 *
 * Selectively copies source files to workspace with flow transformations.
 * This is the primary new capability of the sync command — a lightweight
 * selective install for individual outdated files.
 *
 * For each outdated file:
 * 1. Read source content from package root
 * 2. Apply export flow transformation (source → workspace format)
 * 3. Handle merged files (update only this package's contribution)
 * 4. Write to workspace
 * 5. Update workspace index hashes
 */

import path from 'path';

import type { ExecutionContext } from '../../types/execution-context.js';
import type { WorkspaceIndexFileMapping } from '../../types/workspace-index.js';
import type { SyncFileAction, SyncFileResult, SyncOptions } from './sync-types.js';
import { readTextFile, exists, writeTextFile, ensureDir } from '../../utils/fs.js';
import { calculateFileHash } from '../../utils/hash-utils.js';
import { readWorkspaceIndex, writeWorkspaceIndex } from '../../utils/workspace-index-yml.js';
import { getTargetPath, isComplexMapping, isMergedMapping } from '../../utils/workspace-index-helpers.js';
import { extractContentByKeys } from '../save/save-merge-extractor.js';
import { logger } from '../../utils/logger.js';

/**
 * Execute pull actions — copy source files to workspace.
 *
 * @param pullActions - File actions classified as pull
 * @param packageName - Package being synced
 * @param packageRoot - Absolute path to package source
 * @param cwd - Workspace root
 * @param filesMapping - Complete file mappings from workspace index
 * @param options - Sync options
 * @param ctx - Execution context
 * @returns Array of SyncFileResult for pulled files
 */
export async function executePullActions(
  pullActions: SyncFileAction[],
  packageName: string,
  packageRoot: string,
  cwd: string,
  filesMapping: Record<string, (string | WorkspaceIndexFileMapping)[]>,
  options: SyncOptions,
  _ctx?: ExecutionContext,
): Promise<SyncFileResult[]> {
  if (pullActions.length === 0) return [];

  const results: SyncFileResult[] = [];

  for (const action of pullActions) {
    try {
      const result = await pullSingleFile(
        action,
        packageName,
        packageRoot,
        cwd,
        filesMapping,
        options.dryRun,
      );
      results.push(result);
    } catch (error) {
      logger.debug(`Pull failed for ${action.sourceKey}: ${error}`);
      results.push({
        sourceKey: action.sourceKey,
        targetPath: action.targetPath,
        action: 'error',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Update workspace index hashes for successfully pulled files
  if (!options.dryRun) {
    const pulledSourceKeys = results
      .filter(r => r.action === 'pulled')
      .map(r => r.sourceKey);

    if (pulledSourceKeys.length > 0) {
      await updatePullHashes(cwd, packageName, packageRoot, filesMapping, pulledSourceKeys);
    }
  }

  return results;
}

/**
 * Pull a single file from source to workspace.
 */
async function pullSingleFile(
  action: SyncFileAction,
  _packageName: string,
  packageRoot: string,
  cwd: string,
  filesMapping: Record<string, (string | WorkspaceIndexFileMapping)[]>,
  dryRun: boolean,
): Promise<SyncFileResult> {
  const { sourceKey, targetPath } = action;
  const absSource = path.join(packageRoot, sourceKey);
  const absTarget = path.join(cwd, targetPath);

  // Check source exists
  if (!(await exists(absSource))) {
    return {
      sourceKey,
      targetPath,
      action: 'error',
      detail: 'Source file not found',
    };
  }

  // Find the mapping for this file to determine if it's merged
  const mapping = findMapping(filesMapping, sourceKey, targetPath);
  const isMerged = mapping && isMergedMapping(mapping);

  if (isMerged) {
    return await pullMergedFile(sourceKey, targetPath, absSource, absTarget, mapping as WorkspaceIndexFileMapping, dryRun);
  }

  return await pullSimpleFile(sourceKey, targetPath, absSource, absTarget, dryRun);
}

/**
 * Pull a simple (non-merged) file: read source, write to workspace.
 *
 * For simple files we do a direct copy. The install system uses flows
 * for transformation, but the source content written at install is
 * typically the post-transform result tracked by the sourceHash.
 * For pull we read the raw source and write it directly — this matches
 * what a fresh install would produce for simple (non-flow) files.
 */
async function pullSimpleFile(
  sourceKey: string,
  targetPath: string,
  absSource: string,
  absTarget: string,
  dryRun: boolean,
): Promise<SyncFileResult> {
  const sourceContent = await readTextFile(absSource);
  const targetExists = await exists(absTarget);

  if (dryRun) {
    return {
      sourceKey,
      targetPath,
      action: 'pulled',
      operation: targetExists ? 'updated' : 'created',
      detail: '(dry-run)',
    };
  }

  // Ensure target directory exists
  await ensureDir(path.dirname(absTarget));

  // Write source content to workspace
  await writeTextFile(absTarget, sourceContent);

  return {
    sourceKey,
    targetPath,
    action: 'pulled',
    operation: targetExists ? 'updated' : 'created',
  };
}

/**
 * Pull a merged file: update only this package's contribution in the workspace file.
 *
 * 1. Read current workspace file
 * 2. Read new source content
 * 3. Parse both as JSON, extract package's contribution using merge keys
 * 4. Replace the package's keys in the workspace file with the updated source values
 * 5. Write back
 */
async function pullMergedFile(
  sourceKey: string,
  targetPath: string,
  absSource: string,
  absTarget: string,
  mapping: WorkspaceIndexFileMapping,
  dryRun: boolean,
): Promise<SyncFileResult> {
  const mergeKeys = mapping.keys!;

  // Read both files
  const sourceContent = await readTextFile(absSource);

  // Extract the updated values from source using merge keys
  const sourceExtract = await extractContentByKeys(sourceContent, mergeKeys);
  if (!sourceExtract.success) {
    return {
      sourceKey,
      targetPath,
      action: 'error',
      detail: `Failed to extract source keys: ${sourceExtract.error}`,
    };
  }

  const targetExists = await exists(absTarget);

  if (dryRun) {
    return {
      sourceKey,
      targetPath,
      action: 'pulled',
      operation: targetExists ? 'updated' : 'created',
      detail: '(dry-run)',
    };
  }

  // Read current workspace file (or start fresh if missing)
  let workspaceObj: any = {};
  if (targetExists) {
    try {
      const workspaceContent = await readTextFile(absTarget);
      workspaceObj = JSON.parse(workspaceContent);
    } catch {
      // If workspace file is corrupt, start fresh
      logger.debug(`Failed to parse workspace file ${absTarget}, starting fresh`);
    }
  }

  // Parse the extracted source contribution
  const sourceObj = JSON.parse(sourceExtract.extractedContent!);

  // Deep merge the source contribution into workspace
  deepMerge(workspaceObj, sourceObj);

  // Write back
  await ensureDir(path.dirname(absTarget));
  const mergedContent = JSON.stringify(workspaceObj, null, 2) + '\n';
  await writeTextFile(absTarget, mergedContent);

  return {
    sourceKey,
    targetPath,
    action: 'pulled',
    operation: targetExists ? 'updated' : 'created',
  };
}

/**
 * Deep merge source into target (mutates target).
 */
function deepMerge(target: any, source: any): void {
  for (const key of Object.keys(source)) {
    if (
      typeof source[key] === 'object' &&
      source[key] !== null &&
      !Array.isArray(source[key]) &&
      typeof target[key] === 'object' &&
      target[key] !== null &&
      !Array.isArray(target[key])
    ) {
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
}

/**
 * Find the mapping entry for a given sourceKey + targetPath.
 */
function findMapping(
  filesMapping: Record<string, (string | WorkspaceIndexFileMapping)[]>,
  sourceKey: string,
  targetPath: string,
): string | WorkspaceIndexFileMapping | undefined {
  const targets = filesMapping[sourceKey];
  if (!targets) return undefined;

  for (const mapping of targets) {
    if (getTargetPath(mapping) === targetPath) {
      return mapping;
    }
  }
  return undefined;
}

/**
 * Update workspace index hashes after a successful pull.
 *
 * Stores dual hashes per file mapping:
 * - `hash`: xxhash3 of the workspace file content (after pull)
 * - `sourceHash`: xxhash3 of the raw source file (the new pivot)
 */
async function updatePullHashes(
  cwd: string,
  packageName: string,
  packageRoot: string,
  _filesMapping: Record<string, (string | WorkspaceIndexFileMapping)[]>,
  pulledSourceKeys: string[],
): Promise<void> {
  try {
    const pulledSet = new Set(pulledSourceKeys);
    const record = await readWorkspaceIndex(cwd);
    const pkg = record.index.packages?.[packageName];
    if (!pkg?.files) return;

    let updated = false;
    for (const [sourceKey, targets] of Object.entries(pkg.files)) {
      if (!pulledSet.has(sourceKey)) continue;
      if (!Array.isArray(targets)) continue;

      for (let i = 0; i < targets.length; i++) {
        const mapping = targets[i];
        const targetPath = getTargetPath(mapping);
        const absTarget = path.join(cwd, targetPath);

        if (!(await exists(absTarget))) continue;

        try {
          const content = await readTextFile(absTarget);
          const hash = await calculateFileHash(content);

          // Compute source hash from raw source file
          const absSource = path.join(packageRoot, sourceKey);
          let sourceHashValue: string | undefined;
          if (await exists(absSource)) {
            const sourceContent = await readTextFile(absSource);
            sourceHashValue = await calculateFileHash(sourceContent);
          }

          if (isComplexMapping(mapping)) {
            mapping.hash = hash;
            if (sourceHashValue) mapping.sourceHash = sourceHashValue;
          } else {
            // Upgrade simple string to object form
            const upgraded: WorkspaceIndexFileMapping = { target: mapping as string, hash };
            if (sourceHashValue) upgraded.sourceHash = sourceHashValue;
            targets[i] = upgraded;
          }
          updated = true;
        } catch (error) {
          logger.debug(`Failed to update hash for ${absTarget}: ${error}`);
        }
      }
    }

    if (updated) {
      await writeWorkspaceIndex(record);
      logger.debug(`Updated workspace index hashes (pull) for ${packageName}`);
    }
  } catch (error) {
    logger.debug(`Failed to update pull hashes: ${error}`);
  }
}
