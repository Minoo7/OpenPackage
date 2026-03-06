/**
 * Sync Conflict Resolver
 *
 * Interactive conflict resolution for diverged files in human mode
 * (no --conflicts flag, no --json).
 *
 * Presents per-file choices via PromptPort and returns updated actions
 * with resolution field populated.
 */

import type { PromptPort } from '../ports/prompt.js';
import type { SyncFileAction } from './sync-types.js';

/**
 * Resolve conflicts interactively by prompting the user for each diverged file.
 *
 * @param conflicts - File actions of type 'conflict'
 * @param prompt - PromptPort for interactive prompts
 * @returns Updated actions with resolution or converted to push/pull/skip
 */
export async function resolveConflictsInteractively(
  conflicts: SyncFileAction[],
  prompt: PromptPort,
): Promise<SyncFileAction[]> {
  const resolved: SyncFileAction[] = [];

  for (const action of conflicts) {
    if (action.type !== 'conflict') {
      resolved.push(action);
      continue;
    }

    const choice = await prompt.select<'workspace' | 'source' | 'skip'>(
      `Conflict: ${action.targetPath} (both workspace and source changed)`,
      [
        { title: 'Use workspace version (push)', value: 'workspace' },
        { title: 'Use source version (pull)', value: 'source' },
        { title: 'Skip this file', value: 'skip' },
      ],
    );

    if (choice === 'workspace') {
      resolved.push({ type: 'push', sourceKey: action.sourceKey, targetPath: action.targetPath });
    } else if (choice === 'source') {
      resolved.push({ type: 'pull', sourceKey: action.sourceKey, targetPath: action.targetPath });
    } else {
      resolved.push({ type: 'skip', sourceKey: action.sourceKey, targetPath: action.targetPath, reason: 'user skipped' });
    }
  }

  return resolved;
}
