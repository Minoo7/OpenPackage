/**
 * Resource Provenance
 *
 * Resolves a resource name to the package(s) that installed it,
 * enriched with provenance from the workspace index.
 *
 * Extracted from which-pipeline.ts for reuse by the `ls` command.
 */

import { resolveByName, type ResolutionCandidate } from './resource-resolver.js';
import { traverseScopesFlat, type TraverseScopesOptions, type ResourceScope } from './scope-traversal.js';
import { readWorkspaceIndex } from '../../utils/workspace-index-yml.js';
import { resolveDeclaredPath } from '../../utils/path-resolution.js';
import { exists } from '../../utils/fs.js';
import { checkContentStatus, type ContentStatus } from '../list/content-status-checker.js';
import { getMarkerFilename, toPluralKey, type ResourceTypeId } from './resource-registry.js';
import type { ResolvedResource } from './resource-builder.js';
import { parseResourceQuery } from './resource-query.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProvenanceResult {
  resourceName: string;
  resourceType: string;
  kind: 'tracked' | 'untracked';
  scope: ResourceScope;
  packageName?: string;
  packageVersion?: string;
  packageSourcePath?: string;
  targetFiles: string[];
  /** Per-file content status when --status is active. Keyed by target file path. */
  fileContentStatuses?: Record<string, ContentStatus>;
  /** Aggregate resource-level status derived from file statuses (worst-wins). */
  resourceStatus?: ContentStatus;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * Resolve which package(s) a resource belongs to.
 */
export async function resolveProvenance(
  input: string,
  traverseOpts: TraverseScopesOptions,
  options?: { status?: boolean }
): Promise<ProvenanceResult[]> {
  const query = parseResourceQuery(input);

  // Collect candidates paired with their targetDir for provenance lookup
  const paired: Array<{ candidate: ResolutionCandidate; targetDir: string }> = [];

  await traverseScopesFlat<null>(
    traverseOpts,
    async ({ scope, context }) => {
      const result = await resolveByName(query.name, context.targetDir, scope);
      for (const c of result.candidates) {
        paired.push({ candidate: c, targetDir: context.targetDir });
      }
      return [null];
    }
  );

  // Keep only resource-kind candidates
  let filtered = paired.filter(p => p.candidate.kind === 'resource' && p.candidate.resource);

  // If type-qualified, further filter by type
  if (query.typeFilter) {
    filtered = filtered.filter(
      p => p.candidate.resource!.resourceType === query.typeFilter
    );
  }

  // Enrich with provenance — cache workspace index reads per targetDir
  const indexCache = new Map<string, Awaited<ReturnType<typeof readWorkspaceIndex>>>();
  const results: ProvenanceResult[] = [];

  for (const { candidate, targetDir } of filtered) {
    const resource = candidate.resource!;
    const result: ProvenanceResult = {
      resourceName: resource.resourceName,
      resourceType: resource.resourceType,
      kind: resource.kind,
      scope: resource.scope,
      targetFiles: resource.targetFiles,
    };

    if (resource.kind === 'tracked' && resource.packageName) {
      result.packageName = resource.packageName;

      try {
        let indexRecord = indexCache.get(targetDir);
        if (!indexRecord) {
          indexRecord = await readWorkspaceIndex(targetDir);
          indexCache.set(targetDir, indexRecord);
        }
        const pkgEntry = indexRecord.index.packages[resource.packageName];
        if (pkgEntry) {
          result.packageVersion = pkgEntry.version;
          const relativePath = computeResourceRelativePath(resource);
          if (relativePath) {
            const basePath = pkgEntry.path.replace(/\/+$/, '');
            result.packageSourcePath = `${basePath}/${relativePath}`;
          } else {
            result.packageSourcePath = pkgEntry.path;
          }

          // Content status: filter files mapping to this resource's source keys
          if (options?.status && resource.sourceKeys.size > 0) {
            const sourceRoot = resolveDeclaredPath(pkgEntry.path, targetDir).absolute;
            if (await exists(sourceRoot)) {
              const filteredFiles: Record<string, (string | typeof pkgEntry.files[string][number])[]> = {};
              for (const key of resource.sourceKeys) {
                if (pkgEntry.files[key]) {
                  filteredFiles[key] = pkgEntry.files[key];
                }
              }
              if (Object.keys(filteredFiles).length > 0) {
                const statusMap = await checkContentStatus(targetDir, sourceRoot, filteredFiles);
                const fileStatuses: Record<string, ContentStatus> = {};
                for (const [compositeKey, status] of statusMap) {
                  // compositeKey is "sourceKey::targetPath" — extract targetPath
                  const targetPath = compositeKey.split('::')[1];
                  if (targetPath) fileStatuses[targetPath] = status;
                }
                if (Object.keys(fileStatuses).length > 0) {
                  result.fileContentStatuses = fileStatuses;
                  result.resourceStatus = deriveAggregateStatus(fileStatuses);
                }
              }
            }
          }
        }
      } catch {
        // Provenance enrichment is best-effort
      }
    }

    results.push(result);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive worst-wins aggregate status from per-file content statuses.
 */
function deriveAggregateStatus(statuses: Record<string, ContentStatus>): ContentStatus | undefined {
  const values = Object.values(statuses);
  if (values.length === 0) return undefined;
  if (values.includes('diverged')) return 'diverged';
  if (values.includes('source-deleted')) return 'source-deleted';
  if (values.includes('modified')) return 'modified';
  if (values.includes('outdated')) return 'outdated';
  if (values.includes('merged')) return 'merged';
  return undefined;
}

/**
 * Compute the resource's relative path within its package.
 *
 * - Marker-based types (skills): directory path via pluralKey/resourceName
 * - File-based types (agents, rules, etc.): first sourceKey (preserves extension)
 * - MCP: first sourceKey (e.g. "mcp.json")
 */
function computeResourceRelativePath(resource: ResolvedResource): string | undefined {
  const resourceType = resource.resourceType as ResourceTypeId;

  // Marker-based types → directory path (e.g. "skills/skill-dev")
  if (getMarkerFilename(resourceType)) {
    return `${toPluralKey(resourceType)}/${resource.resourceName}`;
  }

  // File-based types → use first source key (preserves extension)
  if (resource.sourceKeys.size > 0) {
    return resource.sourceKeys.values().next().value;
  }

  // Fallback → reconstruct from type/name
  const pluralKey = toPluralKey(resourceType);
  if (pluralKey === 'other') return undefined;
  return `${pluralKey}/${resource.resourceName}`;
}
