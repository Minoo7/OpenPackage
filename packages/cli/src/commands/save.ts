/**
 * Save Command (CLI layer)
 *
 * Thin shell over core/save/ pipelines.
 * Resolves a resource-spec to the appropriate save target,
 * then delegates to the direct save flow.
 */

import type { Command } from 'commander';

import type { SaveToSourceOptions } from '@opkg/core/core/save/save-to-source-pipeline.js';
import { normalizeSaveOptions } from '@opkg/core/core/save/save-options-normalizer.js';
import { toSaveJsonOutput } from '@opkg/core/core/save/save-result-reporter.js';
import { runDirectSaveFlow } from '@opkg/core/core/save/direct-save-flow.js';
import { runSaveAllFlow } from '@opkg/core/core/save/save-all-flow.js';
import { createCliExecutionContext } from '../cli/context.js';
import { resolveOutput } from '@opkg/core/core/ports/resolve.js';
import { printJsonSuccess, printJsonError } from '../utils/json-output.js';

interface SaveCommandOptions extends SaveToSourceOptions {
  force?: boolean;
  json?: boolean;
}

export async function setupSaveCommand(args: any[]): Promise<void> {
  const [nameArg, options, command] = args as [string | undefined, SaveCommandOptions, Command];
  const programOpts = command.parent?.opts() || {};

  // Normalize options at CLI boundary (validates --conflicts, aliases --force, etc.)
  const normalized = normalizeSaveOptions(options);

  // Build pipeline options from normalized values
  const pipelineOptions: SaveToSourceOptions = {
    dryRun: normalized.dryRun,
    conflicts: normalized.conflicts,
    prefer: normalized.prefer,
  };

  // ── Save-all path (no argument) ──────────────────────────────────────
  if (!nameArg) {
    const ctx = await createCliExecutionContext({
      cwd: programOpts.cwd,
      interactive: false,
      outputMode: 'plain',
    });

    const allResult = await runSaveAllFlow(pipelineOptions, ctx);

    if (options.json) {
      const { totals } = allResult.json;
      if (totals.packagesWithChanges === 0 && totals.packagesFailed > 0) {
        printJsonError(allResult.summary);
      } else {
        printJsonSuccess(allResult.json);
      }
    } else {
      const out = resolveOutput(ctx);
      const { totals } = allResult.json;
      if (totals.packagesWithChanges === 0 && totals.packagesFailed > 0) {
        throw new Error(allResult.summary);
      }
      out.success(allResult.summary);
    }
    return;
  }

  // ── Single-target path (existing behavior) ───────────────────────────
  const traverseOpts = { programOpts };
  const interactive = false;
  const ctx = await createCliExecutionContext({
    cwd: programOpts.cwd,
    interactive,
    outputMode: 'plain',
  });
  const result = await runDirectSaveFlow(nameArg, pipelineOptions, traverseOpts, ctx);

  // JSON output path
  if (options.json) {
    if (result.cancelled) {
      printJsonSuccess({ cancelled: true });
      return;
    }
    if (result.result) {
      if (!result.result.success) {
        printJsonError(result.result.error || 'Save operation failed');
        return;
      }
      if (result.result.data?.report) {
        const report = toSaveJsonOutput(result.result.data.report);
        const { success: _, ...data } = report;
        printJsonSuccess(data);
      } else {
        printJsonSuccess({ message: result.result.data?.message });
      }
    }
    return;
  }

  // Human-readable output path
  if (result.cancelled) {
    const out = resolveOutput(ctx);
    out.info('Save cancelled');
    return;
  }

  if (result.result) {
    const out = resolveOutput(ctx);
    if (!result.result.success) {
      throw new Error(result.result.error || 'Save operation failed');
    }
    if (result.result.data?.message) {
      out.success(result.result.data.message);
    }
  }
}
