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
import { DefaultFlowExecutor } from '../flows/flow-executor.js';
import { mapPlatformFileToUniversal } from '../platform/platform-mapper.js';
import { MARKDOWN_EXTENSIONS } from '../../constants/index.js';
import type { WorkspaceIndexFileMapping } from '../../types/workspace-index.js';
import type { FlowContext } from '../../types/flows.js';
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
          path.join(packageSourceRoot, sourceKey),
          targetDir
        );
        results.set(key, status);
      }
    }
  }

  return results;
}

/**
 * Compare a simple (non-merged) file: hash workspace vs source.
 *
 * For markdown files deployed to a platform directory, runs the source through
 * the flow executor's own loadSourceFile → serializeTargetContent path — the
 * same code the installer uses.  This accounts for platform frontmatter merge,
 * YAML re-serialization, and any future install-time transforms without
 * maintaining a separate replica of the pipeline.
 */
async function checkSimpleFileStatus(
  absWorkspacePath: string,
  absSourcePath: string,
  targetDir: string
): Promise<ContentStatus> {
  try {
    if (!(await exists(absSourcePath))) {
      return 'clean';
    }

    const workspaceContent = await readTextFile(absWorkspacePath);

    // For markdown files, simulate the install pipeline so that expected
    // serialization changes (YAML scalar style, platform frontmatter) don't
    // produce false positives.
    const ext = path.extname(absSourcePath).toLowerCase();
    let sourceHash: string;

    if (MARKDOWN_EXTENSIONS.has(ext)) {
      try {
        const platformInfo = mapPlatformFileToUniversal(absWorkspacePath, targetDir);
        const executor = new DefaultFlowExecutor();
        // Build a minimal FlowContext — loadSourceFile only needs platform + direction
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
        sourceHash = await calculateFileHash(serialized);
      } catch {
        // Transform simulation failed — fall back to raw source comparison
        const sourceContent = await readTextFile(absSourcePath);
        sourceHash = await calculateFileHash(sourceContent);
      }
    } else {
      const sourceContent = await readTextFile(absSourcePath);
      sourceHash = await calculateFileHash(sourceContent);
    }

    const workspaceHash = await calculateFileHash(workspaceContent);
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
