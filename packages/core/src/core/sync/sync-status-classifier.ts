/**
 * Sync Status Classifier
 *
 * Takes output of checkContentStatus() and classifies each file into a
 * SyncFileAction based on direction and conflict strategy.
 *
 * Decision matrix:
 *
 * | Status   | Push-only       | Pull-only       | Bidirectional      |
 * |----------|-----------------|-----------------|---------------------|
 * | clean    | skip            | skip            | skip                |
 * | modified | push            | skip            | push                |
 * | outdated | skip            | pull            | pull                |
 * | diverged | push (ws wins)  | pull (src wins) | per --conflicts     |
 * | merged   | push (extract)  | skip            | push (extract)      |
 */

import type { ContentStatus } from '../list/content-status-checker.js';
import type { SyncFileAction, SyncDirection, SyncConflictStrategy } from './sync-types.js';

export function classifyFileActions(
  statusMap: Map<string, ContentStatus>,
  direction: SyncDirection,
  conflicts?: SyncConflictStrategy,
): SyncFileAction[] {
  const actions: SyncFileAction[] = [];

  for (const [compositeKey, status] of statusMap) {
    const [sourceKey, targetPath] = parseCompositeKey(compositeKey);

    const action = classifySingle(sourceKey, targetPath, status, direction, conflicts);
    if (action) {
      actions.push(action);
    }
  }

  return actions;
}

function parseCompositeKey(key: string): [string, string] {
  const idx = key.indexOf('::');
  if (idx === -1) return [key, key];
  return [key.slice(0, idx), key.slice(idx + 2)];
}

function classifySingle(
  sourceKey: string,
  targetPath: string,
  status: ContentStatus,
  direction: SyncDirection,
  conflicts?: SyncConflictStrategy,
): SyncFileAction | null {
  switch (status) {
    case 'clean':
      return null; // Skip clean files entirely

    case 'modified':
      if (direction === 'pull') {
        return { type: 'skip', sourceKey, targetPath, reason: 'modified (push direction only)' };
      }
      return { type: 'push', sourceKey, targetPath };

    case 'outdated':
      if (direction === 'push') {
        return { type: 'skip', sourceKey, targetPath, reason: 'outdated (pull direction only)' };
      }
      return { type: 'pull', sourceKey, targetPath };

    case 'diverged':
      return classifyDiverged(sourceKey, targetPath, direction, conflicts);

    case 'merged':
      // Merged files with workspace changes should be pushed
      if (direction === 'pull') {
        return { type: 'skip', sourceKey, targetPath, reason: 'merged (push direction only)' };
      }
      return { type: 'push', sourceKey, targetPath };

    case 'source-deleted':
      if (direction === 'push') {
        return { type: 'skip', sourceKey, targetPath, reason: 'source-deleted (cannot push)' };
      }
      return { type: 'remove', sourceKey, targetPath };

    default:
      return null;
  }
}

function classifyDiverged(
  sourceKey: string,
  targetPath: string,
  direction: SyncDirection,
  conflicts?: SyncConflictStrategy,
): SyncFileAction {
  // Directional modes have deterministic resolution
  if (direction === 'push') {
    return { type: 'push', sourceKey, targetPath };
  }
  if (direction === 'pull') {
    return { type: 'pull', sourceKey, targetPath };
  }

  // Bidirectional with explicit strategy
  if (conflicts === 'workspace') {
    return { type: 'push', sourceKey, targetPath };
  }
  if (conflicts === 'source') {
    return { type: 'pull', sourceKey, targetPath };
  }
  if (conflicts === 'skip' || conflicts === 'auto') {
    return { type: 'skip', sourceKey, targetPath, reason: `diverged (${conflicts})` };
  }

  // No strategy in bidirectional → needs interactive resolution
  return { type: 'conflict', sourceKey, targetPath };
}
