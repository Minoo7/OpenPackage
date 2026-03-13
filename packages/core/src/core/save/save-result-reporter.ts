/**
 * Result Reporter
 * 
 * This module formats save operation results for user display.
 * It aggregates write results, conflict analyses, and other pipeline
 * data into a comprehensive report structure.
 * 
 * Key responsibilities:
 * - Build SaveReport from pipeline results
 * - Create CommandResult objects
 * - Provide helpers for success/error cases
 * 
 * @module save-result-reporter
 */

import type { CommandResult } from '../../types/index.js';
import type { ConflictAnalysis } from './save-conflict-analyzer.js';
import type { WriteResult, StatusSummary } from './save-types.js';

/**
 * SaveReport contains aggregated save operation results
 * 
 * This structure provides all the data needed to display
 * a comprehensive summary of the save operation to the user.
 */
export interface SaveReport {
  /** Package name that was saved */
  packageName: string;

  /** Whether this was a dry-run (no files written) */
  dryRun?: boolean;

  /** Total number of candidate groups processed */
  totalGroups: number;

  /** Number of groups that required action (not skipped) */
  groupsWithAction: number;

  /** Total files written successfully */
  filesSaved: number;

  /** Files created (new) */
  filesCreated: number;

  /** Files updated (existing) */
  filesUpdated: number;

  /** Platform-specific files written */
  platformSpecificFiles: number;

  /** Number of interactive resolutions (user prompts) */
  interactiveResolutions: number;

  /** Number of conflicts skipped due to --conflicts skip/auto */
  conflictsSkipped: number;

  /** Details of skipped conflicts */
  skippedConflicts: Array<{ registryPath: string; candidateCount: number; reason: string }>;

  /** Write errors that occurred */
  errors: Array<{ path: string; error: Error }>;

  /** All write results (for detailed reporting) */
  writeResults: WriteResult[];

  /** Number of files that were already clean (skipped by pre-filter) */
  filesClean: number;

  /** Number of files that were outdated (source updated, skipped) */
  filesOutdated: number;

  /** Number of files that diverged (both sides changed) */
  filesDiverged: number;

  /** Paths of outdated files (for user guidance) */
  outdatedFilePaths: string[];

  /** Paths of diverged files (for user awareness) */
  divergedFilePaths: string[];
}

/**
 * Build save report from pipeline results
 * 
 * Aggregates data from conflict analyses and write results into
 * a comprehensive SaveReport structure.
 * 
 * @param packageName - Package that was saved
 * @param analyses - Array of conflict analyses (one per group)
 * @param allWriteResults - Array of write result arrays (one array per group)
 * @returns SaveReport with aggregated statistics
 */
export function buildSaveReport(
  packageName: string,
  analyses: ConflictAnalysis[],
  allWriteResults: WriteResult[][],
  dryRun?: boolean,
  statusSummary?: StatusSummary
): SaveReport {
  // Count groups
  const totalGroups = analyses.length;
  const groupsWithAction = analyses.filter(
    a => a.type !== 'no-action-needed' && a.type !== 'no-change-needed'
  ).length;

  // Flatten write results
  const flatResults = allWriteResults.flat();

  // Count successful writes (exclude 'skipped' — source already had correct content)
  const successfulWrites = flatResults.filter(r => r.success && r.operation.operation !== 'skipped');
  const filesSaved = successfulWrites.length;

  // Count created vs updated
  const filesCreated = successfulWrites.filter(
    r => r.operation.operation === 'created'
  ).length;
  const filesUpdated = successfulWrites.filter(
    r => r.operation.operation === 'updated'
  ).length;

  // Count platform-specific files
  const platformSpecificFiles = successfulWrites.filter(
    r => r.operation.isPlatformSpecific
  ).length;

  // Count interactive resolutions
  const interactiveResolutions = analyses.filter(
    a => a.recommendedStrategy === 'interactive' && a.type === 'needs-resolution'
  ).length;

  // Count skipped conflicts
  const skippedConflicts = analyses
    .filter(a => a.skippedReason)
    .map(a => ({
      registryPath: a.registryPath,
      candidateCount: a.uniqueWorkspaceCandidates.length,
      reason: a.skippedReason!
    }));

  // Extract errors
  const errors = flatResults
    .filter(r => !r.success)
    .map(r => ({
      path: r.operation.registryPath,
      error: r.error || new Error('Unknown write error')
    }));

  // Status summary fields
  const filesClean = statusSummary?.cleanFileCount ?? 0;
  const filesOutdated = statusSummary?.outdatedFiles.length ?? 0;
  const filesDiverged = statusSummary?.divergedFiles.length ?? 0;
  const outdatedFilePaths = statusSummary?.outdatedFiles ?? [];
  const divergedFilePaths = statusSummary?.divergedFiles ?? [];

  return {
    packageName,
    dryRun,
    totalGroups,
    groupsWithAction,
    filesSaved,
    filesCreated,
    filesUpdated,
    platformSpecificFiles,
    interactiveResolutions,
    conflictsSkipped: skippedConflicts.length,
    skippedConflicts,
    errors,
    writeResults: flatResults,
    filesClean,
    filesOutdated,
    filesDiverged,
    outdatedFilePaths,
    divergedFilePaths
  };
}

/**
 * Create CommandResult from SaveReport
 * 
 * Wraps the report in a CommandResult structure with formatted message.
 * 
 * @param report - Save report to wrap
 * @returns CommandResult with success status and formatted message
 */
export function createCommandResult(report: SaveReport): CommandResult {
  return {
    success: true,
    data: {
      report: report
    }
  };
}

/**
 * Create success result for simple cases
 * 
 * Helper for early-exit scenarios like "no changes detected".
 * 
 * @param packageName - Package name
 * @param message - Success message to display
 * @returns CommandResult with success status
 */
export function createSuccessResult(
  packageName: string,
  message: string
): CommandResult {
  return {
    success: true,
    data: {
      message: message,
      packageName: packageName
    }
  };
}

