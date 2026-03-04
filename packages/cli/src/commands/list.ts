import { Command } from 'commander';

import { CommandResult } from '@opkg/core/types/index.js';
import { ValidationError } from '@opkg/core/utils/errors.js';
import { createCliExecutionContext } from '../cli/context.js';
import {
  collectScopedData,
  mergeTrackedAndUntrackedResources,
  mergeResourcesAcrossScopes,
  resolveWorkspaceHeader,
  type HeaderInfo
} from '@opkg/core/core/list/scope-data-collector.js';
import { dim, printDepsView, printResourcesView } from '@opkg/core/core/list/list-printers.js';
import type { EnhancedResourceGroup, ResourceScope } from '@opkg/core/core/list/list-tree-renderer.js';
import { printJsonSuccess } from '../utils/json-output.js';

interface ListOptions {
  global?: boolean;
  project?: boolean;
  files?: boolean;
  status?: boolean;
  platforms?: string[];
  deps?: boolean;
  json?: boolean;
}

// ---------------------------------------------------------------------------
// JSON serialization helpers
// ---------------------------------------------------------------------------

function serializeResourcesView(mergedResources: EnhancedResourceGroup[]) {
  return mergedResources.map(group => ({
    resourceType: group.resourceType,
    resources: group.resources.map(r => ({
      name: r.name,
      status: r.status,
      scopes: [...r.scopes],
      packages: r.packages ? [...r.packages] : [],
      files: r.files.map(f => ({
        source: f.source,
        target: f.target,
        status: f.status,
        scope: f.scope,
      })),
    })),
  }));
}

function serializeDepsView(results: Array<{ scope: ResourceScope; result: any }>) {
  return results.map(({ scope, result }) => ({
    scope,
    packages: (result.data.packages ?? []).map((pkg: any) => ({
      name: pkg.packageName ?? pkg.name,
      version: pkg.version,
      state: pkg.state ?? 'installed',
      dependencies: pkg.dependencies ?? [],
      ...(pkg.modifiedCount !== undefined ? { modifiedCount: pkg.modifiedCount } : {}),
      ...(pkg.outdatedCount !== undefined ? { outdatedCount: pkg.outdatedCount } : {}),
      ...(pkg.divergedCount !== undefined ? { divergedCount: pkg.divergedCount } : {}),
      ...(pkg.isRegistryPackage !== undefined ? { isRegistryPackage: pkg.isRegistryPackage } : {}),
      files: (pkg.files ?? []).map((f: any) => ({
        source: f.source,
        target: f.target,
        status: f.status,
        scope: f.scope,
      })),
    })),
  }));
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

async function listCommand(
  packageName: string | undefined,
  options: ListOptions,
  command: Command
): Promise<CommandResult> {
  const programOpts = command.parent?.opts() || {};

  if (options.project && options.global) {
    throw new ValidationError('Cannot use --project and --global together.');
  }

  const explicitScope = options.project || options.global;
  const showProject = options.project || !explicitScope;
  const showGlobal = options.global || !explicitScope;

  const results = await collectScopedData(
    packageName,
    {
      showProject,
      showGlobal,
      pipelineOptions: {
        files: options.files || options.status, // status implies file-level detail
        all: true, // Always build full tree: deps view needs it for display, resources view needs it to collect from transitive deps
        status: options.status,
        platforms: options.platforms
      },
      cwd: programOpts.cwd
    },
    (opts) => createCliExecutionContext({ global: opts.global, cwd: opts.cwd })
  );

  if (results.length === 0) {
    if (options.json) {
      const view = options.deps ? 'deps' : 'resources';
      printJsonSuccess(view === 'deps' ? { view, scopes: [] } : { view, resources: [] });
      return { success: true };
    }
    if (packageName) {
      console.log(dim(`Package '${packageName}' is not installed.`));
    } else if (options.deps) {
      console.log(dim('No packages installed.'));
    } else {
      console.log(dim('No resources found.'));
    }
    return { success: true };
  }

  // --- Deps view ---
  if (options.deps) {
    if (options.json) {
      printJsonSuccess({ view: 'deps', scopes: serializeDepsView(results) });
      return { success: true };
    }
    // --- Compute header ---
    let listHeaderInfo: HeaderInfo | undefined;
    if (packageName) {
      const firstResult = results[0].result;
      const targetPkg = firstResult.data.targetPackage;
      listHeaderInfo = targetPkg
        ? {
            name: targetPkg.name,
            version: targetPkg.version !== '0.0.0' ? targetPkg.version : undefined,
            path: firstResult.headerPath,
            type: firstResult.headerType
          }
        : {
            name: packageName,
            version: undefined,
            path: firstResult.headerPath,
            type: firstResult.headerType
          };
    } else if (showProject) {
      const projectContext = await createCliExecutionContext({
        global: false,
        cwd: programOpts.cwd
      });
      listHeaderInfo = await resolveWorkspaceHeader(projectContext);
    } else {
      listHeaderInfo = results.length > 0
        ? {
            name: results[0].result.headerName,
            version: results[0].result.headerVersion,
            path: results[0].result.headerPath,
            type: results[0].result.headerType
          }
        : undefined;
    }
    printDepsView(results, !!options.files, listHeaderInfo, undefined, !!options.status);
    return { success: true };
  }

  // --- Resources view (default) ---
  const scopedResources: Array<{ scope: ResourceScope; groups: EnhancedResourceGroup[] }> = [];

  for (const { scope, result } of results) {
    // When listing a specific package, don't include untracked files
    const untrackedData = packageName ? undefined : result.data.untrackedFiles;
    const merged = mergeTrackedAndUntrackedResources(result.tree, untrackedData, scope);
    if (merged.length > 0) {
      scopedResources.push({ scope, groups: merged });
    }
  }

  if (scopedResources.length === 0) {
    if (options.json) {
      printJsonSuccess({ view: 'resources', resources: [] });
      return { success: true };
    }
    if (packageName) {
      console.log(dim(`No resources found for package '${packageName}'.`));
    } else {
      console.log(dim('No resources found.'));
    }
    return { success: true };
  }

  const mergedResources = mergeResourcesAcrossScopes(scopedResources);

  if (options.json) {
    printJsonSuccess({ view: 'resources', resources: serializeResourcesView(mergedResources) });
    return { success: true };
  }

  // --- Compute header for human-readable output ---
  let listHeaderInfo: HeaderInfo | undefined;
  if (packageName) {
    const firstResult = results[0].result;
    const targetPkg = firstResult.data.targetPackage;
    listHeaderInfo = targetPkg
      ? {
          name: targetPkg.name,
          version: targetPkg.version !== '0.0.0' ? targetPkg.version : undefined,
          path: firstResult.headerPath,
          type: firstResult.headerType
        }
      : {
          name: packageName,
          version: undefined,
          path: firstResult.headerPath,
          type: firstResult.headerType
        };
  } else if (showProject) {
    const projectContext = await createCliExecutionContext({
      global: false,
      cwd: programOpts.cwd
    });
    listHeaderInfo = await resolveWorkspaceHeader(projectContext);
  } else {
    listHeaderInfo = results.length > 0
      ? {
          name: results[0].result.headerName,
          version: results[0].result.headerVersion,
          path: results[0].result.headerPath,
          type: results[0].result.headerType
        }
      : undefined;
  }

  printResourcesView(mergedResources, !!options.files, listHeaderInfo, undefined, !!options.status);

  return { success: true };
}

// ---------------------------------------------------------------------------
// Command setup
// ---------------------------------------------------------------------------

export async function setupListCommand(args: any[]): Promise<void> {
  const [packageName, options, command] = args as [string | undefined, ListOptions, Command];
  await listCommand(packageName, options, command);
}
