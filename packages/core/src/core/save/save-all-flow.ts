/**
 * Save All Flow
 *
 * Orchestrates `opkg save` with no argument — discovers all mutable packages
 * with modified files and saves them sequentially.
 *
 * Discovery is a lightweight gatekeeper (mutability + content status) that
 * filters the package list. Per-package execution delegates to `savePackage()`
 * from direct-save-flow, which owns the full validate → detect → pipeline →
 * cleanup lifecycle.
 */

import type { ExecutionContext } from '../../types/execution-context.js';
import { readWorkspaceIndex } from '../../utils/workspace-index-yml.js';
import { resolvePackageSource } from '../source-resolution/resolve-package-source.js';
import { isRegistryPath } from '../source-mutability.js';
import { checkContentStatus } from '../list/content-status-checker.js';
import { detectAllNewWorkspaceFiles } from './save-new-file-detector.js';
import { savePackage, type DirectSaveResult } from './direct-save-flow.js';
import { toSaveJsonOutput } from './save-result-reporter.js';
import type { SaveToSourceOptions } from './save-to-source-pipeline.js';
import { logger } from '../../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SaveAllJsonOutput {
  packages: Array<{
    packageName: string;
    status: 'saved' | 'no-changes' | 'error';
    result?: Record<string, unknown>;
    error?: string;
  }>;
  totals: {
    packagesProcessed: number;
    packagesWithChanges: number;
    packagesFailed: number;
    totalFilesSaved: number;
  };
}

export interface SaveAllResult {
  json: SaveAllJsonOutput;
  summary: string;
}

interface ModifiedPackageInfo {
  packageName: string;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Discover all mutable packages that have modified workspace files.
 *
 * Iterates the workspace index, skips immutable (registry) packages,
 * and runs a lightweight content-status check to detect modifications.
 * New untracked workspace files are also detected (for marker-based resources).
 */
export async function discoverModifiedPackages(
  targetDir: string,
): Promise<ModifiedPackageInfo[]> {
  const { index } = await readWorkspaceIndex(targetDir);
  const packages = index.packages ?? {};
  const modified: ModifiedPackageInfo[] = [];

  for (const [packageName, pkgEntry] of Object.entries(packages)) {
    if (!pkgEntry.files || Object.keys(pkgEntry.files).length === 0) continue;

    // Resolve source and skip immutable packages
    let source;
    try {
      source = await resolvePackageSource(targetDir, packageName);
    } catch (error) {
      logger.debug(`Skipping ${packageName}: failed to resolve source: ${error}`);
      continue;
    }

    if (isRegistryPath(source.absolutePath)) {
      logger.debug(`Skipping ${packageName}: immutable (registry)`);
      continue;
    }

    // Quick content-status check — any non-clean file means "modified"
    try {
      const statusMap = await checkContentStatus(
        targetDir,
        source.absolutePath,
        pkgEntry.files,
      );

      const hasChanges = Array.from(statusMap.values()).some(
        s => s === 'modified' || s === 'diverged',
      );

      // Also detect new untracked workspace files
      const newEntries = await detectAllNewWorkspaceFiles(pkgEntry.files, targetDir);
      const hasNewFiles = Object.keys(newEntries).length > 0;

      if (hasChanges || hasNewFiles) {
        modified.push({ packageName });
      }
    } catch (error) {
      // If status check fails, include the package (let the pipeline decide)
      logger.debug(`Status check failed for ${packageName}, including anyway: ${error}`);
      modified.push({ packageName });
    }
  }

  return modified;
}

// ---------------------------------------------------------------------------
// Result extraction
// ---------------------------------------------------------------------------

/**
 * Extract per-package JSON + summary line from a DirectSaveResult.
 */
function extractPackageResult(
  packageName: string,
  directResult: DirectSaveResult,
): {
  entry: SaveAllJsonOutput['packages'][number];
  summaryLine: string;
  filesSaved: number;
} {
  if (!directResult.success || !directResult.result) {
    const error = directResult.result?.error || 'Save operation failed';
    return {
      entry: { packageName, status: 'error', error },
      summaryLine: `  \u2717 ${packageName}: ${error}`,
      filesSaved: 0,
    };
  }

  const report = directResult.result.data?.report;
  if (report) {
    const saved: number = report.filesSaved ?? 0;
    if (saved > 0) {
      return {
        entry: { packageName, status: 'saved', result: toSaveJsonOutput(report) },
        summaryLine: `  \u2713 ${packageName}: ${saved} file(s) saved`,
        filesSaved: saved,
      };
    }
  }

  return {
    entry: { packageName, status: 'no-changes' },
    summaryLine: `  - ${packageName}: no changes`,
    filesSaved: 0,
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Run save-all flow: discover modified packages and save each sequentially.
 *
 * Sequential execution is required because shared temp dirs for format
 * conversions and because it produces cleaner output ordering.
 *
 * Per-package execution delegates to `savePackage()` which owns the full
 * validate → detect-new-files → pipeline → cleanup lifecycle.
 */
export async function runSaveAllFlow(
  options: SaveToSourceOptions,
  ctx: ExecutionContext,
): Promise<SaveAllResult> {
  const targetDir = ctx.targetDir;
  const modifiedPackages = await discoverModifiedPackages(targetDir);

  if (modifiedPackages.length === 0) {
    return {
      json: {
        packages: [],
        totals: {
          packagesProcessed: 0,
          packagesWithChanges: 0,
          packagesFailed: 0,
          totalFilesSaved: 0,
        },
      },
      summary: 'No modified packages found',
    };
  }

  const packageResults: SaveAllJsonOutput['packages'] = [];
  const summaryLines: string[] = [];
  let totalFilesSaved = 0;
  let packagesWithChanges = 0;
  let packagesFailed = 0;

  for (const pkg of modifiedPackages) {
    try {
      const directResult = await savePackage(pkg.packageName, targetDir, options, ctx);
      const { entry, summaryLine, filesSaved } = extractPackageResult(
        pkg.packageName,
        directResult,
      );

      packageResults.push(entry);
      summaryLines.push(summaryLine);

      if (entry.status === 'saved') {
        packagesWithChanges++;
        totalFilesSaved += filesSaved;
      } else if (entry.status === 'error') {
        packagesFailed++;
      }
    } catch (error) {
      packagesFailed++;
      const message = error instanceof Error ? error.message : String(error);
      packageResults.push({
        packageName: pkg.packageName,
        status: 'error',
        error: message,
      });
      summaryLines.push(`  \u2717 ${pkg.packageName}: ${message}`);
    }
  }

  // Build summary
  const prefix = options.dryRun ? '(dry-run) ' : '';
  const header = packagesWithChanges > 0
    ? `${prefix}Saved ${packagesWithChanges} package(s), ${totalFilesSaved} file(s) total`
    : `${prefix}No changes to save`;
  const failureLine = packagesFailed > 0
    ? `\n  ${packagesFailed} package(s) failed`
    : '';
  const summary = `${header}\n${summaryLines.join('\n')}${failureLine}`;

  return {
    json: {
      packages: packageResults,
      totals: {
        packagesProcessed: modifiedPackages.length,
        packagesWithChanges,
        packagesFailed,
        totalFilesSaved,
      },
    },
    summary,
  };
}
