import { basename, join, relative } from 'path';
import type { InstallOptions, ExecutionContext } from '../../../types/index.js';
import type { InstallationContext, PackageSource } from './context.js';
import { classifyPackageInput } from '../package-input.js';
import { normalizePlatforms } from '../../platform/platform-mapper.js';
import { parsePackageYml } from '../../../utils/package-yml.js';
import { getLocalPackageYmlPath, getLocalOpenPackageDir } from '../../../utils/paths.js';
import { exists } from '../../../utils/fs.js';
import { createWorkspacePackageYml, ensureLocalOpenPackageStructure } from '../../package-management.js';
import { logger } from '../../../utils/logger.js';
import type { ResourceInstallationSpec } from '../convenience-matchers.js';

/**
 * Result of building contexts for bulk install.
 * Workspace root context is built here; dependency resolution is handled
 * separately by the wave engine in runRecursiveBulkInstall.
 */
export interface BulkInstallContextsResult {
  workspaceContext: InstallationContext | null;
  hasDependencies: boolean;
}

/**
 * Build context for registry-based installation
 */
export async function buildRegistryInstallContext(
  execContext: ExecutionContext,
  packageName: string,
  options: InstallOptions & { version?: string; registryPath?: string }
): Promise<InstallationContext> {
  const source: PackageSource = {
    type: 'registry',
    packageName,
    version: options.version,
    registryPath: options.registryPath
  };
  
  return {
    execution: execContext,
    targetDir: execContext.targetDir,
    source,
    mode: 'install',
    options,
    platforms: normalizePlatforms(options.platforms) || [],
    installScope: 'full',
    resolvedPackages: [],
    warnings: [],
    errors: []
  };
}

/**
 * Build context for path-based installation
 */
export async function buildPathInstallContext(
  execContext: ExecutionContext,
  sourcePath: string,
  options: InstallOptions & { sourceType: 'directory' | 'tarball' }
): Promise<InstallationContext> {
  // Will need to load package to get name
  // For now, we'll populate after loading
  const source: PackageSource = {
    type: 'path',
    packageName: '', // Populated after loading
    localPath: sourcePath,
    sourceType: options.sourceType
  };
  
  return {
    execution: execContext,
    targetDir: execContext.targetDir,
    source,
    mode: 'install',
    options,
    platforms: normalizePlatforms(options.platforms) || [],
    installScope: 'full',
    resolvedPackages: [],
    warnings: [],
    errors: []
  };
}

/**
 * Build context for git-based installation
 */
export async function buildGitInstallContext(
  execContext: ExecutionContext,
  gitUrl: string,
  options: InstallOptions & { gitRef?: string; gitPath?: string }
): Promise<InstallationContext> {
  const source: PackageSource = {
    type: 'git',
    packageName: '', // Populated after loading
    gitUrl,
    gitRef: options.gitRef,
    gitPath: options.gitPath
  };
  
  return {
    execution: execContext,
    targetDir: execContext.targetDir,
    source,
    mode: 'install',
    options,
    platforms: normalizePlatforms(options.platforms) || [],
    installScope: 'full',
    resolvedPackages: [],
    warnings: [],
    errors: []
  };
}

/**
 * Build context for workspace root installation
 * Used when installing/applying workspace-level files from .openpackage/
 */
export async function buildWorkspaceRootInstallContext(
  execContext: ExecutionContext,
  options: InstallOptions,
  mode: 'install' | 'apply' = 'install'
): Promise<InstallationContext | null> {
  const cwd = execContext.targetDir;
  
  // Ensure .openpackage/ structure exists
  await ensureLocalOpenPackageStructure(cwd);
  
  // Create workspace manifest if it doesn't exist
  await createWorkspacePackageYml(cwd);
  
  const openpackageDir = getLocalOpenPackageDir(cwd);
  const packageYmlPath = getLocalPackageYmlPath(cwd);
  
  // Check if workspace manifest exists
  if (!(await exists(packageYmlPath))) {
    return null;
  }
  
  // Load workspace manifest
  let config;
  try {
    config = await parsePackageYml(packageYmlPath);
  } catch (error) {
    logger.warn(`Failed to read workspace manifest: ${error}`);
    return null;
  }
  
  // Use workspace directory name as package name if not specified in manifest
  const packageName = config.name || basename(cwd);
  
  const source: PackageSource = {
    type: 'workspace',
    packageName,
    version: config.version,
    contentRoot: openpackageDir
  };
  
  return {
    execution: execContext,
    targetDir: execContext.targetDir,
    source,
    mode,
    options: mode === 'apply' ? { ...options, force: true } : options,
    platforms: normalizePlatforms(options.platforms) || [],
    installScope: 'full',
    resolvedPackages: [],
    warnings: [],
    errors: []
  };
}



/**
 * Build context from package input (auto-detect type)
 */
export async function buildInstallContext(
  execContext: ExecutionContext,
  packageInput: string | undefined,
  options: InstallOptions
): Promise<InstallationContext | InstallationContext[] | BulkInstallContextsResult> {
  // No input = bulk install (returns workspace + dependency contexts separately)
  if (!packageInput) {
    return buildBulkInstallContexts(execContext, options);
  }
  
  // Classify input to determine source type (use sourceCwd for input resolution)
  const classification = await classifyPackageInput(packageInput, execContext.sourceCwd);
  
  switch (classification.type) {
    case 'registry':
      return buildRegistryInstallContext(execContext, classification.name!, options);
    
    case 'directory':
    case 'tarball':
      return buildPathInstallContext(execContext, classification.resolvedPath!, {
        ...options,
        sourceType: classification.type
      });
    
    case 'git':
      return buildGitInstallContext(execContext, classification.gitUrl!, {
        ...options,
        gitRef: classification.gitRef,
        gitPath: classification.gitPath
      });
    
    default:
      throw new Error(`Unknown package input type: ${classification.type}`);
  }
}

/**
 * Build contexts for bulk installation.
 * Returns workspace root context and a flag indicating whether the manifest declares dependencies.
 * Actual dependency resolution and installation is handled by the wave engine in runRecursiveBulkInstall.
 */
async function buildBulkInstallContexts(
  execContext: ExecutionContext,
  options: InstallOptions
): Promise<BulkInstallContextsResult> {
  const cwd = execContext.targetDir;

  // Build workspace root context (run as distinct stage before dependencies)
  const workspaceContext = await buildWorkspaceRootInstallContext(execContext, options, 'install');

  // Ensure workspace manifest exists before reading
  await createWorkspacePackageYml(cwd);

  // Check whether the manifest declares any dependencies (for empty-manifest messaging)
  const opkgYmlPath = getLocalPackageYmlPath(cwd);
  const opkgYml = await parsePackageYml(opkgYmlPath);

  const deps = ((opkgYml as any).packages ?? (opkgYml as any).dependencies ?? []) as any[];
  const devDeps = (((opkgYml as any).devDependencies ?? (opkgYml as any)['dev-dependencies'] ?? []) as any[]);
  const hasDependencies = [...deps, ...devDeps].filter(Boolean).length > 0;

  return { workspaceContext: workspaceContext ?? null, hasDependencies };
}

/**
 * Build context from a ResourceSpec (Phase 3: Resource Model)
 */
export async function buildResourceInstallContext(
  execContext: ExecutionContext,
  resourceSpec: any, // ResourceSpec from resource-arg-parser
  options: InstallOptions
): Promise<InstallationContext> {
  let source: PackageSource;
  
  switch (resourceSpec.type) {
    case 'github-url':
    case 'github-shorthand':
      // Git source with resource path
      source = {
        type: 'git',
        packageName: '', // Populated after loading
        gitUrl: resourceSpec.gitUrl!,
        gitRef: resourceSpec.ref,
        // IMPORTANT: In resource-mode, `resourceSpec.path` represents a resource filter
        // (file or directory) within the repo, NOT a git subdirectory to clone into.
        // `gitPath` is reserved for "package lives in subdirectory" semantics (legacy/manifest).
        resourcePath: resourceSpec.path // Store resource path for base detection + scoping
      };
      break;
    
    case 'registry':
      // Registry source with optional path
      source = {
        type: 'registry',
        packageName: resourceSpec.name!,
        version: resourceSpec.version,
        resourcePath: resourceSpec.path
      };
      break;
    
    case 'filepath':
      // Local path source
      const absolutePath = resourceSpec.absolutePath!;
      const relativePath = relative(execContext.sourceCwd, absolutePath).replace(/\\/g, '/');
      const resourcePath = relativePath.startsWith('..') ? basename(absolutePath) : relativePath;
      source = {
        type: 'path',
        packageName: '', // Populated after loading
        localPath: absolutePath,
        sourceType: resourceSpec.isDirectory ? 'directory' : 'tarball',
        resourcePath
      };
      break;
    
    default:
      throw new Error(`Unknown resource type: ${resourceSpec.type}`);
  }
  
  return {
    execution: execContext,
    targetDir: execContext.targetDir,
    source,
    mode: 'install',
    options,
    platforms: normalizePlatforms(options.platforms) || [],
    installScope: 'full', // May be narrowed to 'subset' during path scoping
    resolvedPackages: [],
    warnings: [],
    errors: []
  };
}

function buildResourceMatchedPattern(
  resourceSpec: ResourceInstallationSpec,
  repoRoot: string,
  basePath: string
): string | undefined {
  const absoluteResourcePath = join(repoRoot, resourceSpec.resourcePath);
  const relativeToBase = relative(basePath, absoluteResourcePath)
    .replace(/\\/g, '/')
    .replace(/^\.\/?/, '');

  if (!relativeToBase) {
    return undefined;
  }

  if (resourceSpec.resourceKind === 'directory') {
    const normalized = relativeToBase.replace(/\/$/, '');
    return `${normalized}/**`;
  }

  return relativeToBase;
}

/**
 * Prepare resource contexts for multi-resource pipeline: set localPath
 * for path sources so the pipeline uses the correct root.
 */
export function prepareResourceContextsForMultiInstall(
  contexts: InstallationContext[],
  repoRoot: string
): InstallationContext[] {
  return contexts.map(rc => {
    if (rc.source.type === 'path') {
      rc.source.localPath = repoRoot;
    }
    return rc;
  });
}

/**
 * Build multiple contexts for resource-centric installations.
 * For single-file installs from plugins, scopes the package name to the resource path
 * so the workspace index key is e.g. gh@user/repo/plugin/agents/foo.md rather than the plugin root.
 * 
 * All contexts produced here are 'subset' scope -- they install a filtered set of files
 * from the package, not the entire package.
 */
export function buildResourceInstallContexts(
  baseContext: InstallationContext,
  resourceSpecs: ResourceInstallationSpec[],
  repoRoot: string
): InstallationContext[] {
  const detectedBase = baseContext.detectedBase ?? baseContext.source.contentRoot ?? baseContext.targetDir;
  const baseRelative = baseContext.baseRelative ?? (relative(repoRoot, detectedBase) || '.');

  return resourceSpecs.map(spec => {
    const effectiveBase = baseContext.detectedBase ?? spec.basePath;
    const matchedPattern = buildResourceMatchedPattern(spec, repoRoot, effectiveBase) ?? baseContext.matchedPattern;

    // For single-file installs, scope the package name so index key and manifest are e.g.
    // gh@user/repo/plugins/feature-dev/agents/code-architect.md (not plugin root)
    const isSingleFile = Boolean(
      matchedPattern &&
      !matchedPattern.includes('*') &&
      !matchedPattern.includes('?') &&
      !matchedPattern.includes('[')
    );
    const baseName = baseContext.source.packageName;
    const scopedName = isSingleFile ? `${baseName}/${matchedPattern}` : baseName;

    const source: PackageSource = {
      ...baseContext.source,
      packageName: scopedName,
      resourcePath: spec.resourcePath,
      resourceVersion: spec.resourceVersion
    };

    let resolvedPackages = baseContext.resolvedPackages;
    if (isSingleFile && baseContext.resolvedPackages.length > 0) {
      resolvedPackages = baseContext.resolvedPackages.map(pkg => ({
        ...pkg,
        name: pkg.isRoot ? scopedName : pkg.name
      }));
    } else if (baseContext.resolvedPackages.length === 0) {
      resolvedPackages = [];
    }

    return {
      ...baseContext,
      source,
      resolvedPackages,
      warnings: [],
      errors: [],
      detectedBase: effectiveBase,
      baseRelative: baseRelative === '' ? '.' : baseRelative,
      baseSource: baseContext.baseSource,
      matchedPattern,
      installScope: 'subset'
    };
  });
}


