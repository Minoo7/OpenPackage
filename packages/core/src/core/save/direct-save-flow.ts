/**
 * Direct Save Flow
 *
 * Core orchestration for `opkg save <resource-spec>`.
 * Resolves a user-provided name to either a resource or a package,
 * disambiguates if needed, then delegates to the save pipeline.
 *
 * Follows the direct-uninstall-flow pattern (resolve → disambiguate → execute).
 * No terminal-UI dependencies — uses OutputPort/PromptPort via context.
 */

import type { CommandResult } from '../../types/index.js';
import type { ExecutionContext } from '../../types/execution-context.js';
import type { WorkspaceIndexFileMapping } from '../../types/workspace-index.js';
import { resolveByName, type ResolutionCandidate } from '../resources/resource-resolver.js';
import { traverseScopesFlat } from '../resources/scope-traversal.js';
import type { TraverseScopesOptions } from '../resources/scope-traversal.js';
import { disambiguate } from '../resources/disambiguation-prompt.js';
import { parseWhichQuery } from '../which/which-pipeline.js';
import { formatScopeTag } from '../../utils/formatters.js';
import { resolveOutput, resolvePrompt } from '../ports/resolve.js';
import { logger } from '../../utils/logger.js';
import {
  validateSavePreconditions,
  executeSavePipeline,
  type SaveToSourceOptions,
} from './save-to-source-pipeline.js';
import { createErrorResult } from './save-result-reporter.js';
import { clearConversionCache, initSharedTempDir, cleanupSharedTempDir } from './save-conversion-helper.js';
import { detectNewWorkspaceFiles, detectAllNewWorkspaceFiles } from './save-new-file-detector.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DirectSaveResult {
  success: boolean;
  result?: CommandResult;
  cancelled?: boolean;
}

/** Candidate paired with the workspace directory it was resolved from */
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
 * Run the direct save flow:
 * 1. Parse input for optional type qualifier (e.g., `skills/my-skill`)
 * 2. Traverse scopes and resolve candidates by name
 * 3. Filter by type if type-qualified
 * 4. Disambiguate if multiple matches
 * 5. Route: package → full save, resource → filtered save
 */
export async function runDirectSaveFlow(
  nameArg: string,
  options: SaveToSourceOptions,
  traverseOpts: TraverseScopesOptions,
  ctx?: ExecutionContext
): Promise<DirectSaveResult> {
  // Parse optional type qualifier
  const query = parseWhichQuery(nameArg);

  // Resolve candidates across scopes, pairing each with its targetDir
  // (needed so we can read the correct workspace index later)
  const paired: PairedCandidate[] = [];

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

  // If type-qualified, filter by resource type
  let filtered = paired;
  if (query.typeFilter) {
    filtered = filtered.filter(
      p => p.candidate.kind === 'resource' && p.candidate.resource?.resourceType === query.typeFilter
    );
  }

  // Disambiguate (operates on the candidate inside the pair)
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
      promptMessage: 'Select which to save:',
      multi: false,
    },
    out,
    prm
  );

  if (selected.length === 0) {
    return { success: false, cancelled: true };
  }

  const { candidate, targetDir } = selected[0];

  // Route by kind
  if (candidate.kind === 'package') {
    return await savePackage(candidate.package!.packageName, targetDir, options, ctx);
  }

  // Resource: extract package name, validate, and filter filesMapping
  const resource = candidate.resource!;
  if (!resource.packageName) {
    return {
      success: false,
      result: createErrorResult(
        `Resource '${resource.resourceName}' is not tracked by any package.\nOnly tracked resources can be saved back to source.`
      ),
    };
  }

  return await saveResource(resource.packageName, resource.sourceKeys, targetDir, options, ctx);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Save all files for a package (equivalent to the old full-package save).
 */
async function savePackage(
  packageName: string,
  targetDir: string,
  options: SaveToSourceOptions,
  ctx?: ExecutionContext
): Promise<DirectSaveResult> {
  try {
    await initSharedTempDir();

    const validation = await validateSavePreconditions(packageName, targetDir);
    if (!validation.valid) {
      return { success: false, result: createErrorResult(validation.error!) };
    }

    // Detect new (untracked) workspace files across all resources in the package
    const newEntries = await detectAllNewWorkspaceFiles(validation.filesMapping!, validation.cwd!);
    const augmentedMapping = { ...validation.filesMapping!, ...newEntries };

    const result = await executeSavePipeline(
      packageName,
      validation.packageRoot!,
      validation.cwd!,
      augmentedMapping,
      options,
      ctx
    );

    return { success: result.success, result };
  } finally {
    clearConversionCache();
    await cleanupSharedTempDir();
  }
}

/**
 * Save only the files belonging to a specific resource within a package.
 * Filters the filesMapping to only include source keys that belong to the resource.
 */
async function saveResource(
  packageName: string,
  sourceKeys: Set<string>,
  targetDir: string,
  options: SaveToSourceOptions,
  ctx?: ExecutionContext
): Promise<DirectSaveResult> {
  try {
    await initSharedTempDir();

    const validation = await validateSavePreconditions(packageName, targetDir);
    if (!validation.valid) {
      return { success: false, result: createErrorResult(validation.error!) };
    }

    // Filter filesMapping to only include this resource's source keys
    const fullMapping = validation.filesMapping!;
    const filteredMapping: Record<string, (string | WorkspaceIndexFileMapping)[]> = {};

    for (const key of sourceKeys) {
      if (fullMapping[key]) {
        filteredMapping[key] = fullMapping[key];
      }
    }

    // Detect new (untracked) workspace files belonging to this resource
    const newEntries = await detectNewWorkspaceFiles(sourceKeys, fullMapping, validation.cwd!);
    for (const [regPath, targets] of Object.entries(newEntries)) {
      filteredMapping[regPath] = targets;
    }

    if (Object.keys(filteredMapping).length === 0) {
      logger.warn(`No matching file mappings found for resource source keys in package '${packageName}'`);
      return {
        success: false,
        result: createErrorResult(
          `No file mappings found for the selected resource in package '${packageName}'.`
        ),
      };
    }

    const result = await executeSavePipeline(
      packageName,
      validation.packageRoot!,
      validation.cwd!,
      filteredMapping,
      options,
      ctx
    );

    return { success: result.success, result };
  } finally {
    clearConversionCache();
    await cleanupSharedTempDir();
  }
}
