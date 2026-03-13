/**
 * Sync Workspace-Deleted Detector
 *
 * Detects source keys where ALL workspace targets have been deleted.
 * Must run BEFORE the healer, which removes stale mappings and erases
 * the evidence of user-initiated deletions.
 */

import path from 'path';

import type { WorkspaceIndexFileMapping } from '../../types/workspace-index.js';
import type { WorkspaceDeletedEntry } from './sync-types.js';
import { exists } from '../../utils/fs.js';
import { getTargetPath } from '../../utils/workspace-index-helpers.js';

/**
 * Detect source keys where every workspace target has been deleted.
 *
 * If only SOME targets for a source key are missing, skip it — the healer
 * handles partial cleanup. Only return entries where ALL targets are gone,
 * which signals intentional user deletion.
 */
export async function detectWorkspaceDeletedEntries(
  cwd: string,
  filesMapping: Record<string, (string | WorkspaceIndexFileMapping)[]>,
): Promise<WorkspaceDeletedEntry[]> {
  // Build a flat list of all checks so we can batch into a single Promise.all()
  const checks: Array<{ sourceKey: string; targetPaths: string[]; startIdx: number }> = [];
  const allPaths: string[] = [];

  for (const [sourceKey, targets] of Object.entries(filesMapping)) {
    if (!Array.isArray(targets) || targets.length === 0) continue;
    const targetPaths = targets.map(m => getTargetPath(m));
    checks.push({ sourceKey, targetPaths, startIdx: allPaths.length });
    allPaths.push(...targetPaths);
  }

  if (allPaths.length === 0) return [];

  const existResults = await Promise.all(
    allPaths.map(tp => exists(path.join(cwd, tp))),
  );

  const entries: WorkspaceDeletedEntry[] = [];
  for (const { sourceKey, targetPaths, startIdx } of checks) {
    const allMissing = targetPaths.every((_, i) => !existResults[startIdx + i]);
    if (allMissing) {
      entries.push({ sourceKey, allTargets: targetPaths });
    }
  }

  return entries;
}
