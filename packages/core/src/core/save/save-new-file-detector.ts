/**
 * Save New File Detector
 *
 * Detects untracked workspace files that belong to a marker-based resource
 * (e.g. skills with SKILL.md) and returns them as new entries to inject
 * into the filesMapping before executing the save pipeline.
 *
 * Only marker-based resource types are supported because other types
 * (rule, agent, command, hook) are single-file and live in shared
 * category directories where file ownership is ambiguous.
 */

import { join, dirname } from 'path';
import { DIR_TO_TYPE } from '../../constants/index.js';
import { getMarkerFilename } from '../resources/resource-registry.js';
import { classifySourceKeyBatch } from '../resources/resource-classifier.js';
import { collectSourceEntries } from '../add/source-collector.js';
import { getTargetPath } from '../../utils/workspace-index-helpers.js';
import { isDirectory } from '../../utils/fs.js';
import type { WorkspaceIndexFileMapping } from '../../types/workspace-index.js';

type FilesMapping = Record<string, (string | WorkspaceIndexFileMapping)[]>;

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Check if the given source keys belong to a marker-based resource type.
 */
function isMarkerBasedResource(sourceKeys: Iterable<string>): boolean {
  for (const key of sourceKeys) {
    const firstSegment = key.replace(/\\/g, '/').split('/')[0];
    const typeId = DIR_TO_TYPE[firstSegment];
    if (typeId && getMarkerFilename(typeId) !== null) {
      return true;
    }
    return false; // only need the first key
  }
  return false;
}

/**
 * Compute the longest common directory prefix from a set of source keys.
 * Returns empty string if keys are at category level only (e.g. `rules/a.md`).
 *
 * Example: `{skills/s/SKILL.md, skills/s/lib.ts}` → `skills/s/`
 */
function computeCommonSourcePrefix(sourceKeys: Iterable<string>): string {
  const dirs: string[] = [];
  for (const key of sourceKeys) {
    const normalized = key.replace(/\\/g, '/');
    const parts = normalized.split('/');
    // Need at least 3 segments to have a resource-specific prefix
    // e.g. skills/name/file.md → prefix is skills/name/
    if (parts.length >= 3) {
      dirs.push(parts.slice(0, -1).join('/') + '/');
    }
  }

  if (dirs.length === 0) return '';

  // Find the longest common prefix
  let prefix = dirs[0];
  for (let i = 1; i < dirs.length; i++) {
    while (!dirs[i].startsWith(prefix) && prefix.length > 0) {
      // Remove last segment
      const trimmed = prefix.slice(0, -1); // remove trailing /
      const lastSlash = trimmed.lastIndexOf('/');
      prefix = lastSlash >= 0 ? trimmed.slice(0, lastSlash + 1) : '';
    }
  }

  return prefix;
}

/**
 * Derive unique workspace directories from source keys' target paths.
 */
function deriveWorkspaceDirs(
  sourceKeys: Iterable<string>,
  filesMapping: FilesMapping,
  workspaceRoot: string,
): Set<string> {
  const dirs = new Set<string>();
  for (const key of sourceKeys) {
    const mappings = filesMapping[key];
    if (!mappings) continue;
    for (const m of mappings) {
      const target = getTargetPath(m);
      const absDir = dirname(join(workspaceRoot, target));
      dirs.add(absDir);
    }
  }
  return dirs;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect new (untracked) workspace files for a single resource's source keys.
 *
 * Scans the workspace directories derived from the resource's file mappings,
 * collects all files via the import-flow mapper, and returns those not already
 * present in `sourceKeys`.
 *
 * @returns A mapping from registry path → workspace-relative target paths
 *          (same shape as filesMapping entries). Empty if the resource type
 *          is not marker-based or no new files are found.
 */
export async function detectNewWorkspaceFiles(
  sourceKeys: Set<string>,
  filesMapping: FilesMapping,
  workspaceRoot: string,
): Promise<Record<string, string[]>> {
  if (!isMarkerBasedResource(sourceKeys)) return {};

  const prefix = computeCommonSourcePrefix(sourceKeys);
  if (prefix === '') return {};

  const workspaceDirs = deriveWorkspaceDirs(sourceKeys, filesMapping, workspaceRoot);
  const result: Record<string, string[]> = {};

  for (const dir of workspaceDirs) {
    if (!(await isDirectory(dir))) continue;

    const entries = await collectSourceEntries(dir, workspaceRoot);
    for (const entry of entries) {
      // Only include files under the same resource prefix
      if (!entry.registryPath.startsWith(prefix)) continue;
      // Skip files already tracked
      if (sourceKeys.has(entry.registryPath)) continue;

      if (!result[entry.registryPath]) {
        result[entry.registryPath] = [];
      }

      // Derive the workspace-relative target path
      const absWorkspaceRoot = workspaceRoot;
      const target = entry.sourcePath.startsWith(absWorkspaceRoot)
        ? entry.sourcePath.slice(absWorkspaceRoot.length + 1)
        : entry.sourcePath;

      if (!result[entry.registryPath].includes(target)) {
        result[entry.registryPath].push(target);
      }
    }
  }

  return result;
}

/**
 * Detect new workspace files across all resources in a package's filesMapping.
 *
 * Groups source keys by resource, then calls `detectNewWorkspaceFiles` for
 * each marker-based resource. Results are merged into a single mapping.
 */
export async function detectAllNewWorkspaceFiles(
  filesMapping: FilesMapping,
  workspaceRoot: string,
): Promise<Record<string, string[]>> {
  const classified = classifySourceKeyBatch(Object.keys(filesMapping));

  // Group source keys by resource fullName
  const resourceGroups = new Map<string, Set<string>>();
  for (const [key, cls] of classified) {
    if (!resourceGroups.has(cls.fullName)) {
      resourceGroups.set(cls.fullName, new Set());
    }
    resourceGroups.get(cls.fullName)!.add(key);
  }

  const merged: Record<string, string[]> = {};

  for (const keys of resourceGroups.values()) {
    if (!isMarkerBasedResource(keys)) continue;

    const newEntries = await detectNewWorkspaceFiles(keys, filesMapping, workspaceRoot);
    for (const [regPath, targets] of Object.entries(newEntries)) {
      if (!merged[regPath]) {
        merged[regPath] = [];
      }
      for (const t of targets) {
        if (!merged[regPath].includes(t)) {
          merged[regPath].push(t);
        }
      }
    }
  }

  return merged;
}

// Exported for testing
export { isMarkerBasedResource as _isMarkerBasedResource };
export { computeCommonSourcePrefix as _computeCommonSourcePrefix };
