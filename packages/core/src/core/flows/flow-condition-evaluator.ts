/**
 * Flow Condition Evaluator
 *
 * Shared logic for evaluating `when` conditional clauses and resolving
 * variable references ($$platform, $$source) in flow definitions.
 *
 * Extracted from save-conversion-helper.ts and save-write-coordinator.ts
 * to eliminate duplication.
 *
 * @module flow-condition-evaluator
 */

import type { Platform } from '../platforms.js';
import { logger } from '../../utils/logger.js';

/**
 * Evaluate 'when' conditional clause
 *
 * Simplified evaluation for common patterns used in platforms.jsonc.
 * Handles $eq and $ne comparisons with $$platform and $$source variables.
 *
 * @param when - Conditional expression
 * @param platform - Current platform
 * @param _workspaceRoot - Workspace root (unused, kept for signature compatibility)
 * @returns True if condition is met
 */
export function evaluateWhenCondition(
  when: any,
  platform: Platform,
  _workspaceRoot?: string
): boolean {
  // Handle { "$eq": ["$$platform", "claude"] }
  if (when.$eq && Array.isArray(when.$eq) && when.$eq.length === 2) {
    const left = resolveVariable(when.$eq[0], platform);
    const right = resolveVariable(when.$eq[1], platform);
    return left === right;
  }

  // Handle { "$ne": ["$$platform", "claude"] }
  if (when.$ne && Array.isArray(when.$ne) && when.$ne.length === 2) {
    const left = resolveVariable(when.$ne[0], platform);
    const right = resolveVariable(when.$ne[1], platform);
    return left !== right;
  }

  // Handle { "exists": "AGENTS.md" }
  if (when.exists) {
    // For save, we're converting workspace -> universal
    // The 'exists' check is relative to source (workspace in this case)
    // For simplicity, assume file exists if we got to this point
    return true;
  }

  // Unknown condition type - assume not met (conservative)
  logger.debug('Unknown condition type in when clause', { when });
  return false;
}

/**
 * Resolve variable references like $$platform, $$source
 */
export function resolveVariable(value: any, platform: Platform): any {
  if (typeof value === 'string') {
    if (value === '$$platform' || value === '$$source') {
      return platform;
    }
  }
  return value;
}
