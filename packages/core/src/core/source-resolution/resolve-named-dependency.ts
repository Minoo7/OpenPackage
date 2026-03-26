import path from 'path';

import { normalizePackageName } from '../../utils/package-name.js';
import { detectWorkspaceMutableSource, detectGlobalMutableSource, type MutableSourceInfo } from '../install/local-source-resolution.js';
import { resolveRegistryVersion } from './resolve-registry-version.js';
import { MUTABILITY, SOURCE_TYPES } from '../../constants/index.js';
import type { ResolvedPackageSource } from './types.js';

export interface ResolveNamedDependencyOptions {
  /** Semver version or constraint. */
  version?: string;
  /** Explicit semver constraint (overrides version if both provided). */
  constraint?: string;
  /** Skip registry fallback — only check mutable sources (workspace + global). */
  skipRegistry?: boolean;
}

function buildMutableResult(normalizedName: string, source: MutableSourceInfo): ResolvedPackageSource {
  return {
    packageName: normalizedName,
    absolutePath: path.join(source.packageRootDir, path.sep),
    declaredPath: source.packageRootDir,
    mutability: MUTABILITY.MUTABLE,
    version: source.version,
    sourceType: SOURCE_TYPES.PATH
  };
}

/**
 * Canonical resolution function for named package dependencies.
 *
 * Implements the standard fallback chain:
 *   1. Workspace mutable source  (.openpackage/packages/<name>/)
 *   2. Global mutable source     (~/.openpackage/packages/<name>/)
 *   3. Registry                  (~/.openpackage/registry/<name>/<version>/)
 *
 * All install paths (single install, bulk install, dependency graph resolution)
 * should use this function to ensure consistent source resolution.
 */
export async function resolveNamedDependency(
  packageName: string,
  cwd: string,
  options?: ResolveNamedDependencyOptions
): Promise<ResolvedPackageSource> {
  const normalizedName = normalizePackageName(packageName);

  const workspaceSource = await detectWorkspaceMutableSource(cwd, normalizedName);
  if (workspaceSource) return buildMutableResult(normalizedName, workspaceSource);

  const globalSource = await detectGlobalMutableSource(normalizedName);
  if (globalSource) return buildMutableResult(normalizedName, globalSource);

  if (options?.skipRegistry) {
    throw new Error(`Package '${packageName}' not found in workspace or global packages.`);
  }

  // Registry fallback — don't pass cwd to avoid re-checking workspace/global
  // (we already checked above and they weren't found).
  const constraint = options?.constraint ?? options?.version;
  const registry = await resolveRegistryVersion(normalizedName, { constraint });
  return {
    packageName: normalizedName,
    absolutePath: registry.absolutePath,
    declaredPath: registry.declaredPath,
    mutability: MUTABILITY.IMMUTABLE,
    version: registry.version,
    sourceType: SOURCE_TYPES.REGISTRY,
    resolutionSource: registry.resolutionSource
  };
}
