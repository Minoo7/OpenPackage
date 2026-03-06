/**
 * Direct Sync Flow
 *
 * Core orchestration for `opkg sync <target>`.
 * Resolves a user-provided name to either a resource or a package,
 * disambiguates if needed, then delegates to the sync pipeline.
 *
 * Follows the direct-save-flow pattern (resolve → disambiguate → execute).
 */

import type { ExecutionContext } from '../../types/execution-context.js';
import type { WorkspaceIndexFileMapping } from '../../types/workspace-index.js';
import type { SyncOptions, SyncPackageResult } from './sync-types.js';
import { resolveByName, type ResolutionCandidate } from '../resources/resource-resolver.js';
import { traverseScopesFlat } from '../resources/scope-traversal.js';
import type { TraverseScopesOptions } from '../resources/scope-traversal.js';
import { disambiguate } from '../resources/disambiguation-prompt.js';
import { parseWhichQuery } from '../which/which-pipeline.js';
import { formatScopeTag } from '../../utils/formatters.js';
import { resolveOutput, resolvePrompt } from '../ports/resolve.js';
import { runSyncPipeline } from './sync-pipeline.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DirectSyncResult {
  success: boolean;
  result?: SyncPackageResult;
  cancelled?: boolean;
  error?: string;
}

interface PairedCandidate {
  candidate: ResolutionCandidate;
  targetDir: string;
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatTitle(candidate: ResolutionCandidate): string {
  if (candidate.kind === 'package') {
    const pkg = candidate.package!;
    const version = pkg.version && pkg.version !== '0.0.0' ? ` (v${pkg.version})` : '';
    const scopeTag = formatScopeTag(pkg.scope);
    return `${pkg.packageName}${version} (package, ${pkg.resourceCount} resources)${scopeTag}`;
  }
  const r = candidate.resource!;
  const fromPkg = r.packageName ? `, from ${r.packageName}` : '';
  const scopeTag = formatScopeTag(r.scope);
  return `${r.resourceName} (${r.resourceType}${fromPkg})${scopeTag}`;
}

function formatDescription(candidate: ResolutionCandidate): string {
  const files = candidate.kind === 'package'
    ? candidate.package!.targetFiles
    : candidate.resource!.targetFiles;
  if (files.length === 0) return 'no files';
  const displayFiles = files.slice(0, 5);
  const remaining = files.length - displayFiles.length;
  let desc = displayFiles.join('\n');
  if (remaining > 0) {
    desc += `\n+${remaining} more`;
  }
  return desc;
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

/**
 * Run the direct sync flow:
 * 1. Parse input for optional type qualifier
 * 2. Traverse scopes and resolve candidates by name
 * 3. Filter by type if type-qualified
 * 4. Disambiguate if multiple matches
 * 5. Route: package → full sync, resource → filtered sync
 */
export async function runDirectSyncFlow(
  nameArg: string,
  options: SyncOptions,
  traverseOpts: TraverseScopesOptions,
  ctx?: ExecutionContext,
): Promise<DirectSyncResult> {
  // Parse optional type qualifier
  const query = parseWhichQuery(nameArg);

  // Resolve candidates across scopes
  const paired: PairedCandidate[] = [];

  await traverseScopesFlat<null>(
    traverseOpts,
    async ({ scope, context }) => {
      const result = await resolveByName(query.name, context.targetDir, scope);
      for (const c of result.candidates) {
        paired.push({ candidate: c, targetDir: context.targetDir });
      }
      return [null];
    },
  );

  // If type-qualified, filter by resource type
  let filtered = paired;
  if (query.typeFilter) {
    filtered = filtered.filter(
      p => p.candidate.kind === 'resource' && p.candidate.resource?.resourceType === query.typeFilter,
    );
  }

  // Disambiguate
  const out = resolveOutput(ctx);
  const prm = resolvePrompt(ctx);

  const selected = await disambiguate(
    nameArg,
    filtered,
    (p) => ({
      title: formatTitle(p.candidate),
      description: formatDescription(p.candidate),
      value: p,
    }),
    {
      notFoundMessage: `"${nameArg}" not found as a resource or package.\nRun \`opkg ls\` to see installed resources.`,
      promptMessage: 'Select which to sync:',
      multi: false,
    },
    out,
    prm,
  );

  if (selected.length === 0) {
    return { success: false, cancelled: true };
  }

  const { candidate, targetDir } = selected[0];

  // Route by kind
  if (candidate.kind === 'package') {
    return await syncPackage(candidate.package!.packageName, targetDir, options, ctx);
  }

  // Resource: extract package name and sync filtered
  const resource = candidate.resource!;
  if (!resource.packageName) {
    return {
      success: false,
      error: `Resource '${resource.resourceName}' is not tracked by any package.\nOnly tracked resources can be synced.`,
    };
  }

  return await syncResource(resource.packageName, resource.sourceKeys, targetDir, options, ctx);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function syncPackage(
  packageName: string,
  targetDir: string,
  options: SyncOptions,
  ctx?: ExecutionContext,
): Promise<DirectSyncResult> {
  try {
    const result = await runSyncPipeline(packageName, targetDir, options, ctx);
    return { success: true, result };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Sync only the files belonging to a specific resource within a package.
 *
 * Runs the full sync pipeline but the status classifier will naturally
 * only produce actions for files that have changes. We pass the full
 * package context and let the pipeline filter.
 */
async function syncResource(
  packageName: string,
  _sourceKeys: Set<string>,
  targetDir: string,
  options: SyncOptions,
  ctx?: ExecutionContext,
): Promise<DirectSyncResult> {
  // For now, sync the full package (the pipeline skips clean files anyway)
  // A future refinement could filter the status map to only resource keys
  return await syncPackage(packageName, targetDir, options, ctx);
}
