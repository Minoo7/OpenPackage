import type { ListPackageReport, ListTreeNode } from './list-pipeline.js';
import { flattenResourceGroups, renderFlatResourceList, getChildPrefix, getTreeConnector, type TreeRenderConfig, type EnhancedFileMapping, type EnhancedResourceInfo, type EnhancedResourceGroup, type ResourceScope } from './list-tree-renderer.js';
import { formatScopeBadge, formatScopeBadgeAlways, formatPathForDisplay } from '../../utils/formatters.js';
import type { ScopeResult, HeaderInfo } from './scope-data-collector.js';
import type { ProvenanceResult } from '../resources/resource-provenance.js';
import type { ViewMetadataEntry } from './view-metadata.js';
import type { OutputPort } from '../ports/output.js';
import { resolveOutput } from '../ports/resolve.js';

export type { ViewMetadataEntry } from './view-metadata.js';
export { extractMetadataFromManifest } from './view-metadata.js';

export function printMetadataSection(metadata: ViewMetadataEntry[], output?: OutputPort): void {
  const out = output ?? resolveOutput();
  out.info(sectionHeader('Metadata', metadata.length));
  metadata.forEach((entry) => {
    const valueStr = Array.isArray(entry.value)
      ? entry.value.join(', ')
      : String(entry.value);
    out.info(`${dim(entry.key + ':')} ${valueStr}`);
  });
}

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';

export function dim(text: string): string {
  return `${DIM}${text}${RESET}`;
}

export function cyan(text: string): string {
  return `${CYAN}${text}${RESET}`;
}

function red(text: string): string {
  return `${RED}${text}${RESET}`;
}

function yellow(text: string): string {
  return `${YELLOW}${text}${RESET}`;
}

export function sectionHeader(title: string, count: number): string {
  return `${cyan(`[${title}]`)} ${dim(`(${count})`)}`;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatPackageLine(pkg: ListPackageReport, statusEnabled?: boolean): string {
  const version = pkg.version && pkg.version !== '0.0.0' ? `@${pkg.version}` : '';

  let stateSuffix = '';
  if (pkg.state === 'missing') {
    stateSuffix = dim(' (missing)');
  }

  // Show status tags for mutable packages with changes
  const statusTags: string[] = [];
  if (statusEnabled && !pkg.isRegistryPackage) {
    if (pkg.modifiedCount && pkg.modifiedCount > 0) {
      statusTags.push(yellow(`[${pkg.modifiedCount} modified]`));
    }
    if (pkg.outdatedCount && pkg.outdatedCount > 0) {
      statusTags.push(cyan(`[${pkg.outdatedCount} outdated]`));
    }
    if (pkg.divergedCount && pkg.divergedCount > 0) {
      statusTags.push(red(`[${pkg.divergedCount} diverged]`));
    }
    if (pkg.sourceDeletedCount && pkg.sourceDeletedCount > 0) {
      statusTags.push(red(`[${pkg.sourceDeletedCount} deleted from source]`));
    }
  }
  const statusTag = statusTags.length > 0 ? ' ' + statusTags.join(' ') : '';

  return `${pkg.name}${version}${stateSuffix}${statusTag}`;
}

function formatFilePath(file: EnhancedFileMapping): string {
  if (file.scope === 'global' && !file.target.startsWith('~')) {
    return `~/${file.target}`;
  }
  return file.target;
}

// ---------------------------------------------------------------------------
// File and resource group printing
// ---------------------------------------------------------------------------

function printFileList(
  files: { source: string; target: string; exists: boolean; contentStatus?: string }[],
  prefix: string,
  out: OutputPort,
  statusEnabled?: boolean
): void {
  const sortedFiles = [...files].sort((a, b) => a.target.localeCompare(b.target));

  for (let i = 0; i < sortedFiles.length; i++) {
    const file = sortedFiles[i];
    const isLast = i === sortedFiles.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    let label: string;
    if (!file.exists) {
      label = `${dim(file.target)} ${red('[MISSING]')}`;
    } else if (statusEnabled && file.contentStatus === 'diverged') {
      label = `${dim(file.target)} ${red('[diverged]')}`;
    } else if (statusEnabled && file.contentStatus === 'modified') {
      label = `${dim(file.target)} ${yellow('[modified]')}`;
    } else if (statusEnabled && file.contentStatus === 'outdated') {
      label = `${dim(file.target)} ${cyan('[outdated]')}`;
    } else if (statusEnabled && file.contentStatus === 'source-deleted') {
      label = `${dim(file.target)} ${red('[deleted from source]')}`;
    } else if (statusEnabled && file.contentStatus === 'merged') {
      label = `${dim(file.target)} ${dim('[merged]')}`;
    } else {
      label = dim(file.target);
    }
    out.info(`${prefix}${connector}${label}`);
  }
}

// ---------------------------------------------------------------------------
// Header rendering
// ---------------------------------------------------------------------------

/**
 * Print the header line for a list view (deps or resources).
 * Shows `name@version [scope]` for package-scoped headers,
 * or `name@version (path) [type]` for workspace/fallback headers.
 */
function printListHeader(
  headerInfo: HeaderInfo | undefined,
  fallbackResult: { headerName: string; headerVersion?: string; headerPath: string; headerType: string } | undefined,
  out: OutputPort
): void {
  if (headerInfo) {
    const version = headerInfo.version ? `@${headerInfo.version}` : '';
    if (headerInfo.scope) {
      const scopeBadge = dim(formatScopeBadgeAlways(headerInfo.scope));
      out.info(`${headerInfo.name}${version} ${scopeBadge}`);
    } else {
      const typeTag = dim(`[${headerInfo.type}]`);
      out.info(`${headerInfo.name}${version} ${dim(`(${headerInfo.path})`)} ${typeTag}`);
    }
  } else if (fallbackResult) {
    const version = fallbackResult.headerVersion ? `@${fallbackResult.headerVersion}` : '';
    const typeTag = dim(`[${fallbackResult.headerType}]`);
    out.info(`${fallbackResult.headerName}${version} ${dim(`(${fallbackResult.headerPath})`)} ${typeTag}`);
  }
}

// ---------------------------------------------------------------------------
// Deps view
// ---------------------------------------------------------------------------

interface DepsPackageEntry {
  report: ListPackageReport;
  children: ListTreeNode[];
  scopes: Set<ResourceScope>;
}

function printDepTreeNode(
  node: ListTreeNode,
  prefix: string,
  isLast: boolean,
  showFiles: boolean,
  out: OutputPort,
  statusEnabled?: boolean
): void {
  const hasChildren = node.children.length > 0;
  const hasFiles = showFiles && node.report.fileList && node.report.fileList.length > 0;
  const hasBranches = hasChildren || hasFiles;

  const connector = isLast
    ? (hasBranches ? '└─┬ ' : '└── ')
    : (hasBranches ? '├─┬ ' : '├── ');
  const childPrefix = getChildPrefix(prefix, isLast);

  out.info(`${prefix}${connector}${formatPackageLine(node.report, statusEnabled)}`);

  if (hasFiles) {
    printFileList(node.report.fileList!, childPrefix, out, statusEnabled);
  }

  node.children.forEach((child, index) => {
    const isLastChild = index === node.children.length - 1;
    printDepTreeNode(child, childPrefix, isLastChild, showFiles, out, statusEnabled);
  });
}

export function printDepsView(
  results: Array<{ scope: ResourceScope; result: ScopeResult }>,
  showFiles: boolean,
  headerInfo?: HeaderInfo,
  output?: OutputPort,
  statusEnabled?: boolean
): void {
  const out = output ?? resolveOutput();
  const packageMap = new Map<string, DepsPackageEntry>();

  for (const { scope, result } of results) {
    for (const node of result.tree) {
      const key = node.report.name;
      if (packageMap.has(key)) {
        packageMap.get(key)!.scopes.add(scope);
      } else {
        packageMap.set(key, {
          report: node.report,
          children: node.children,
          scopes: new Set([scope])
        });
      }
    }
  }

  if (packageMap.size === 0) {
    out.info(dim('No packages installed.'));
    return;
  }

  // Collect workspace root names from ALL scope results — these are self-entries
  // representing each scope's root, not real dependency packages.
  const workspaceRootNames = new Set<string>();
  for (const { result } of results) {
    if (result.headerType === 'workspace' && result.headerName) {
      workspaceRootNames.add(result.headerName);
    }
  }

  // Also include the display header's workspace name
  let workspaceEntry: DepsPackageEntry | undefined;
  if (headerInfo?.type === 'workspace' && headerInfo.name) {
    workspaceRootNames.add(headerInfo.name);
    // Preserve the header workspace entry so its files can be shown with -f
    workspaceEntry = packageMap.get(headerInfo.name);
  }

  // Remove all workspace root entries from the dependency display
  for (const name of workspaceRootNames) {
    packageMap.delete(name);
  }

  printListHeader(headerInfo, results.length > 0 ? results[0].result : undefined, out);

  const entries = Array.from(packageMap.values())
    .sort((a, b) => a.report.name.localeCompare(b.report.name));

  out.info(sectionHeader('Dependencies', entries.length));

  // If workspace was excluded, show its files under the header when -f is used.
  // Use empty prefix so workspace files appear as siblings of dep entries.
  if (workspaceEntry && showFiles && workspaceEntry.report.fileList && workspaceEntry.report.fileList.length > 0) {
    printFileList(workspaceEntry.report.fileList, '', out, statusEnabled);
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const isLast = i === entries.length - 1;
    const hasChildren = entry.children.length > 0;
    const hasFiles = showFiles && entry.report.fileList && entry.report.fileList.length > 0;
    const hasBranches = hasChildren || hasFiles;

    const scopeBadge = dim(formatScopeBadge(entry.scopes));
    const connector = isLast
      ? (hasBranches ? '└─┬ ' : '└── ')
      : (hasBranches ? '├─┬ ' : '├── ');
    const childPrefix = getChildPrefix('', isLast);

    out.info(`${connector}${formatPackageLine(entry.report, statusEnabled)} ${scopeBadge}`);

    // Show flat file list for the package when -f is requested
    if (hasFiles) {
      printFileList(entry.report.fileList!, childPrefix, out, statusEnabled);
    }

    for (let ci = 0; ci < entry.children.length; ci++) {
      const child = entry.children[ci];
      const isLastChild = ci === entry.children.length - 1;
      printDepTreeNode(child, childPrefix, isLastChild, showFiles, out, statusEnabled);
    }
  }
}

// ---------------------------------------------------------------------------
// Resources view (default)
// ---------------------------------------------------------------------------

export function printResourcesView(
  groups: EnhancedResourceGroup[],
  showFiles: boolean,
  headerInfo?: HeaderInfo,
  output?: OutputPort,
  statusEnabled?: boolean
): void {
  const out = output ?? resolveOutput();
  printListHeader(headerInfo, undefined, out);

  // Show package label only when listing workspace (not a specific package).
  // Temporarily disabled behind feature flag; set OPKG_LIST_SHOW_PACKAGE_LABELS=true to enable.
  const showPackageLabels =
    headerInfo?.type !== 'package' &&
    process.env.OPKG_LIST_SHOW_PACKAGE_LABELS === 'true';

  const config: TreeRenderConfig<EnhancedFileMapping> = {
    formatPath: (file) => formatFilePath(file),
    isMissing: (file) => file.status === 'missing',
    sortFiles: (a, b) => formatFilePath(a).localeCompare(formatFilePath(b)),
    getResourceBadge: (scopes) => scopes ? dim(formatScopeBadgeAlways(scopes)) : '',
    ...(showPackageLabels && {
      getResourcePackageLabels: (packages) => {
        if (!packages || packages.size === 0) return [];
        return Array.from(packages)
          .sort()
          .map((pkg) => dim(`(${pkg})`));
      }
    }),
    ...(statusEnabled && {
      getFileStatusTag: (file: EnhancedFileMapping) => {
        if (file.status === 'diverged') return red('[diverged]');
        if (file.status === 'modified') return yellow('[modified]');
        if (file.status === 'outdated') return cyan('[outdated]');
        if (file.contentStatus === 'source-deleted') return red('[deleted from source]');
        if (file.status === 'untracked') return dim('[untracked]');
        if (file.contentStatus === 'merged') return dim('[merged]');
        return undefined;
      },
      getResourceStatusTag: (resource: EnhancedResourceInfo) => {
        if (resource.status === 'diverged') return red('[diverged]');
        if (resource.status === 'modified') return yellow('[modified]');
        if (resource.status === 'outdated') return cyan('[outdated]');
        if (resource.status === 'untracked') return dim('[untracked]');
        if (resource.status === 'missing') return red('[MISSING]');
        return undefined;
      }
    })
  };

  const flatResources = flattenResourceGroups(groups);
  out.info(sectionHeader('Installed', flatResources.length));
  renderFlatResourceList(flatResources, '', showFiles, config);
}

// ---------------------------------------------------------------------------
// Resource provenance view
// ---------------------------------------------------------------------------

/**
 * Print resource provenance results (which package(s) installed a resource).
 * Caller is responsible for empty-results messaging; this is a pure renderer.
 */
export function printProvenanceView(
  resourceQuery: string,
  results: ProvenanceResult[],
  options: { files?: boolean },
  output?: OutputPort
): void {
  const out = output ?? resolveOutput();

  out.info(resourceQuery);
  out.info(sectionHeader('Installed', results.length));

  for (let i = 0; i < results.length; i++) {
    printProvenanceEntry(results[i], i, results.length, options, out);
  }
}

function printProvenanceEntry(
  result: ProvenanceResult,
  index: number,
  total: number,
  options: { files?: boolean },
  out: OutputPort
): void {
  const isLast = index === total - 1;

  // Entry name: "pkg@version" (tracked) or "(untracked)"
  const entryName = result.kind === 'tracked'
    ? `${result.packageName}${result.packageVersion ? `@${result.packageVersion}` : ''}`
    : '(untracked)';

  // Scope badge
  const scopeBadge = formatScopeBadge(result.scope);
  const scopeSuffix = scopeBadge ? ` ${dim(scopeBadge)}` : '';

  // Only files create tree branches; source annotation is not a tree child
  const hasFiles = !!options.files && result.targetFiles.length > 0;
  const hasSourceLine = result.kind === 'tracked' && !!result.packageSourcePath;

  const connector = getTreeConnector(isLast, hasFiles);
  const childPrefix = getChildPrefix('', isLast);

  out.info(`${connector}${entryName}${scopeSuffix}`);

  // Source path annotation (tracked only) — same pattern as package labels in renderResource
  if (hasSourceLine) {
    const sourcePrefix = hasFiles ? childPrefix + '│ ' : childPrefix + '  ';
    out.info(`${sourcePrefix}${dim(formatPathForDisplay(result.packageSourcePath!))}`);
  }

  // Files (with -f)
  if (hasFiles) {
    const sorted = [...result.targetFiles].sort();
    for (let i = 0; i < sorted.length; i++) {
      const isLastFile = i === sorted.length - 1;
      const fileConnector = getTreeConnector(isLastFile, false);
      out.info(`${childPrefix}${fileConnector}${dim(formatPathForDisplay(sorted[i]))}`);
    }
  }
}
