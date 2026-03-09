/**
 * Base Strategy Module
 * 
 * Abstract base class providing shared functionality for installation strategies.
 */

import type { Platform } from '../../platforms.js';
import type { FlowContext } from '../../../types/flows.js';
import type { PackageFormat } from '../format-detector.js';
import type { InstallationStrategy, FlowInstallContext, FlowInstallResult } from './types.js';
import type { InstallOptions } from '../../../types/index.js';
import { logger } from '../../../utils/logger.js';
import { createEmptyResult } from './helpers/result-converter.js';
import { getApplicableFlows } from './helpers/flow-helpers.js';
import { logInstallationResult } from '../helpers/result-logging.js';
import { buildImportFlowContext, type ImportPipelineContext } from '../../flows/import-pipeline.js';

/**
 * Abstract base class for installation strategies
 */
export abstract class BaseStrategy implements InstallationStrategy {
  abstract readonly name: string;
  
  abstract canHandle(format: PackageFormat, platform: Platform): boolean;
  
  abstract install(
    context: FlowInstallContext,
    options?: InstallOptions,
    forceOverwrite?: boolean
  ): Promise<FlowInstallResult>;
  
  /**
   * Create an empty result object
   */
  protected createEmptyResult(): FlowInstallResult {
    return createEmptyResult();
  }
  
  /**
   * Get applicable flows for a platform (global + platform-specific)
   */
  protected getApplicableFlows(platform: Platform, cwd: string) {
    return getApplicableFlows(platform, cwd);
  }
  
  /**
   * Build flow context with standard variables
   *
   * Delegates to the shared import pipeline's buildImportFlowContext().
   */
  protected buildFlowContext(
    context: FlowInstallContext,
    direction: 'install' | 'save' = 'install'
  ): FlowContext {
    const pipelineCtx: ImportPipelineContext = {
      packageName: context.packageName,
      packageRoot: context.packageRoot,
      workspaceRoot: context.workspaceRoot,
      platform: context.platform,
      packageVersion: context.packageVersion,
      priority: context.priority,
      dryRun: context.dryRun,
      conversionContext: context.conversionContext,
      matchedPattern: context.matchedPattern,
    };
    return buildImportFlowContext(pipelineCtx, direction);
  }
  
  /**
   * Log strategy selection for debugging
   */
  protected logStrategySelection(context: FlowInstallContext): void {
    // Strategy selection logging removed for cleaner output
  }
  
  /**
   * Log installation results using shared utility
   */
  protected logResults(result: FlowInstallResult, context: FlowInstallContext): void {
    logInstallationResult(
      result,
      context.packageName,
      context.platform,
      context.dryRun ?? false
    );
  }
  
  /**
   * Create an error result
   */
  protected createErrorResult(
    context: FlowInstallContext,
    error: Error,
    message: string
  ): FlowInstallResult {
    return {
      success: false,
      filesProcessed: 0,
      filesWritten: 0,
      conflicts: [],
      errors: [{
        flow: { from: context.packageRoot, to: context.workspaceRoot },
        sourcePath: context.packageRoot,
        error,
        message
      }],
      targetPaths: [],
      fileMapping: {}
    };
  }

}
