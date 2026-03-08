/**
 * Add Orchestrator
 *
 * Core orchestration logic for the `add` command.
 * Classifies input, dispatches to the correct pipeline (dependency, workspace-resource, copy),
 * and returns typed results. No terminal-UI dependencies.
 */

import { join, resolve } from 'path';

import type { ExecutionContext } from '../../types/execution-context.js';
import type { CommandResult } from '../../types/index.js';
import { classifyAddInput, type AddInputClassification, type AddClassifyOptions } from './add-input-classifier.js';
import { runAddDependencyFlow, type AddDependencyResult, type AddDependencyOptions } from './add-dependency-flow.js';
import { runAddToSourcePipeline, runAddToSourcePipelineBatch, addSourceEntriesToPackage, type AddToSourceResult, type AddToSourceOptions } from './add-to-source-pipeline.js';
import { classifyResourceSpec, resolveResourceSpec } from '../resources/resource-spec.js';
import { mapWorkspaceFileToUniversal } from '../platform/platform-mapper.js';
import { exists } from '../../utils/fs.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AddResourceResult =
  | { kind: 'dependency'; result: AddDependencyResult; classification: AddInputClassification }
  | { kind: 'copy'; result: CommandResult<AddToSourceResult> }
  | { kind: 'workspace-resource'; result: CommandResult<AddToSourceResult> };

export interface ProcessAddResourceOptions {
  copy?: boolean;
  dev?: boolean;
  to?: string;
  platformSpecific?: boolean;
  force?: boolean;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Check if input looks like a bare name (could be registry or local path) */
function isBareNameInput(input: string): boolean {
  return (
    !input.startsWith('./') &&
    !input.startsWith('../') &&
    !input.startsWith('/') &&
    !input.startsWith('~') &&
    !input.endsWith('/')
  );
}

/**
 * Process a single resource spec through the add pipeline.
 * Classifies the input and dispatches to the appropriate flow
 * (dependency, workspace-resource, or copy).
 *
 * Returns a typed discriminated union so the caller (CLI or GUI)
 * can render the result however it chooses.
 */
export async function processAddResource(
  resourceSpec: string,
  options: ProcessAddResourceOptions,
  cwd: string,
  execContext: ExecutionContext
): Promise<AddResourceResult> {
  // Check if input is a resource reference (e.g., `agents/ui-designer`)
  const spec = classifyResourceSpec(resourceSpec);
  if (spec.kind === 'resource-ref') {
    if (options.dev) {
      throw new Error('--dev can only be used when adding a dependency, not when copying files');
    }
    const traverseOpts = { programOpts: { cwd } };
    const resolved = await resolveResourceSpec(resourceSpec, traverseOpts, {
      notFoundMessage: `"${resourceSpec}" not found as a resource.\nRun \`opkg ls\` to see installed resources.`,
      promptMessage: 'Select which resource to add:',
      multi: false,
      scopePreference: 'project',
    }, execContext);

    if (resolved.length === 0) {
      throw new Error(`No resource found for "${resourceSpec}".`);
    }

    const { candidate, packageSourcePath, targetDir } = resolved[0];
    const resource = candidate.resource!;

    // Build source entries directly from the resource's sourceKeys.
    // We read from the installed package source directory (not the workspace
    // deployment path) to preserve the correct package-relative registryPaths.
    const entries: Array<{ sourcePath: string; registryPath: string }> = [];

    if (packageSourcePath && resource.sourceKeys.size > 0) {
      // Tracked resource with a package source — read from source directory
      for (const sourceKey of resource.sourceKeys) {
        const absSource = join(packageSourcePath, sourceKey);
        if (await exists(absSource)) {
          entries.push({ sourcePath: absSource, registryPath: sourceKey });
        }
      }
    } else {
      // Untracked resource (or tracked without source) — fall back to deployed target files.
      // Use the platform mapper to convert workspace paths back to universal registry paths.
      const seenRegistryPaths = new Set<string>();

      for (const targetFile of resource.targetFiles) {
        const absSource = join(targetDir, targetFile);
        const mapping = mapWorkspaceFileToUniversal(absSource, targetDir);
        if (!mapping) continue;
        const registryPath = [mapping.subdir, mapping.relPath].filter(Boolean).join('/');
        if (seenRegistryPaths.has(registryPath)) continue;
        seenRegistryPaths.add(registryPath);
        if (await exists(absSource)) {
          entries.push({ sourcePath: absSource, registryPath });
        }
      }
    }

    if (entries.length === 0) {
      const nameContext = resource.packageName || 'unknown source';
      throw new Error(`No source files found for resource "${resourceSpec}" from ${nameContext}.`);
    }

    const result = await addSourceEntriesToPackage(options.to, entries, { ...options, execContext });
    if (!result.success) {
      throw new Error(result.error || 'Add operation failed');
    }
    return { kind: 'workspace-resource', result };
  }

  const classification = await classifyAddInput(resourceSpec, cwd, {
    copy: options.copy,
    dev: options.dev,
  });

  if (classification.mode === 'dependency') {
    if (options.platformSpecific) {
      throw new Error('--platform-specific can only be used with --copy or when adding files');
    }
    try {
      const result = await runAddDependencyFlow(classification, {
        dev: options.dev,
        to: options.to,
      });
      return { kind: 'dependency', result, classification };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (isBareNameInput(resourceSpec)) {
        const localPath = resolve(cwd, resourceSpec);
        if (await exists(localPath)) {
          throw new Error(
            `${msg}\n\nA local path './${resourceSpec}' exists — did you mean:\n  opkg add ./${resourceSpec}`
          );
        }
      }
      throw error;
    }
  }

  if (classification.mode === 'workspace-resource') {
    if (options.dev) {
      throw new Error('--dev can only be used when adding a dependency, not when copying files');
    }
    const resource = classification.resolvedResource!;
    const absPath = resource.sourcePath || join(execContext.targetDir, resource.targetFiles[0]);

    const result = await runAddToSourcePipeline(options.to, absPath, { ...options, execContext });
    if (!result.success) {
      throw new Error(result.error || 'Add operation failed');
    }
    return { kind: 'workspace-resource', result };
  }

  // copy mode
  if (options.dev) {
    throw new Error('--dev can only be used when adding a dependency, not when copying files');
  }
  const result = await runAddToSourcePipeline(options.to, classification.copySourcePath!, { ...options, execContext });
  if (!result.success) {
    throw new Error(result.error || 'Add operation failed');
  }
  return { kind: 'copy', result };
}
