/**
 * Add Orchestrator
 *
 * Core orchestration logic for the `add` command.
 * Classifies input, dispatches to the correct pipeline (dependency, workspace-resource, copy),
 * and returns typed results. No terminal-UI dependencies.
 */

import { join, relative, resolve } from 'path';

import type { ExecutionContext } from '../../types/execution-context.js';
import type { CommandResult } from '../../types/index.js';
import { classifyAddInput, type AddInputClassification, type AddClassifyOptions } from './add-input-classifier.js';
import { runAddDependencyFlow, type AddDependencyResult, type AddDependencyOptions } from './add-dependency-flow.js';
import { runAddToSourcePipeline, runAddToSourcePipelineBatch, addSourceEntriesToPackage, type AddToSourceResult, type AddToSourceOptions } from './add-to-source-pipeline.js';
import { classifyResourceSpec, resolveResourceSpec } from '../resources/resource-spec.js';
import { disambiguatePlatform, groupFilesByPlatform } from '../platform/platform-disambiguation.js';
import { buildEntriesFromWorkspaceResource } from '../resources/workspace-resource-discovery.js';
import { getResourceTypeDef } from '../resources/resource-registry.js';
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
  platform?: string;
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

    const { candidate, targetDir } = resolved[0];
    const resource = candidate.resource!;

    // Discover files and build entries using shared workspace resource discovery.
    // Handles both dirName types (disk scan) and dirName:null types (targetFiles fallback).
    const resourceType = resource.resourceType;
    const typeDef = getResourceTypeDef(resourceType);

    // For platform disambiguation, we need the raw discovered files first
    let entries = await buildEntriesFromWorkspaceResource(
      resourceType, resource.resourceName, resource.targetFiles, targetDir,
    );

    // Platform disambiguation: filter entries to a single platform when multi-platform
    if (typeDef.dirName) {
      const entryRels = entries.map(e => ({
        entry: e,
        rel: relative(targetDir, e.sourcePath),
      }));
      const platformGroups = groupFilesByPlatform(entryRels.map(e => e.rel), targetDir);
      const platformKeys = [...platformGroups.keys()].filter((k): k is string => k !== null);

      if (platformKeys.length > 1) {
        const selectedPlatform = await disambiguatePlatform({
          targetDir,
          resourceLabel: resourceSpec,
          specifiedPlatform: options.platform,
          execContext,
        });
        const allowedRels = new Set([
          ...(platformGroups.get(selectedPlatform) ?? []),
          ...(platformGroups.get(null) ?? []),
        ]);
        entries = entryRels
          .filter(e => allowedRels.has(e.rel))
          .map(e => e.entry);
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

  // --platform only valid with resource references
  if (options.platform) {
    throw new Error('--platform can only be used with resource references (e.g., skills/foo), not file paths.');
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
