/**
 * Direct Uninstall Flow
 *
 * Core orchestration for `opkg un <name>` (non-interactive).
 * Resolves candidates across scopes, disambiguates, and executes.
 * No terminal-UI dependencies — uses OutputPort/PromptPort via context.
 */

import type { UninstallOptions } from '../../types/index.js';
import type { ExecutionContext } from '../../types/execution-context.js';
import { resolveByName, type ResolutionCandidate } from '../resources/resource-resolver.js';
import { traverseScopesFlat, type ResourceScope } from '../resources/scope-traversal.js';
import { disambiguate } from '../resources/disambiguation-prompt.js';
import { formatScopeTag } from '../../utils/formatters.js';
import { executeUninstallCandidate } from './uninstall-executor.js';
import { resolveOutput, resolvePrompt } from '../ports/resolve.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DirectUninstallOptions extends UninstallOptions {
  global?: boolean;
}

export interface DirectUninstallResult {
  uninstalledCount: number;
  cancelled: boolean;
  uninstalledItems: Array<{
    name: string;
    kind: 'package' | 'resource';
    resourceType?: string;
    scope: ResourceScope;
  }>;
}

export interface CandidateFormatters {
  formatTitle: (candidate: ResolutionCandidate) => string;
  formatDescription: (candidate: ResolutionCandidate) => string;
}

// ---------------------------------------------------------------------------
// Default formatters (can be overridden by CLI/GUI for richer display)
// ---------------------------------------------------------------------------

function defaultFormatTitle(candidate: ResolutionCandidate): string {
  if (candidate.kind === 'package') {
    const pkg = candidate.package!;
    const version = pkg.version && pkg.version !== '0.0.0' ? ` (v${pkg.version})` : '';
    const scopeTag = formatScopeTag(pkg.scope);
    return `${pkg.packageName}${version} (package, ${pkg.resourceCount} resources)${scopeTag}`;
  }
  const r = candidate.resource!;
  const fromPkg = r.packageName ? `, from ${r.packageName}` : '';
  const scopeTag = formatScopeTag(r.scope);
  return `${r.resourceName} (${r.resourceType}${fromPkg})${scopeTag}`;
}

function defaultFormatDescription(candidate: ResolutionCandidate): string {
  const files = candidate.kind === 'package'
    ? candidate.package!.targetFiles
    : candidate.resource!.targetFiles;
  if (files.length === 0) return 'no files';
  const displayFiles = files.slice(0, 5);
  const remaining = files.length - displayFiles.length;
  let desc = displayFiles.join('\n');
  if (remaining > 0) {
    desc += `\n+${remaining} more`;
  }
  return desc;
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

/**
 * Run the direct (non-interactive) uninstall flow:
 * 1. Traverse scopes and resolve candidates by name
 * 2. Disambiguate if multiple matches
 * 3. Execute uninstall for each selected candidate
 */
export async function runDirectUninstallFlow(
  name: string,
  options: DirectUninstallOptions,
  traverseOpts: { programOpts?: Record<string, any>; globalOnly?: boolean; projectOnly?: boolean },
  createContext: (opts: { global: boolean; cwd?: string; interactive: boolean }) => Promise<ExecutionContext>,
  formatters?: CandidateFormatters
): Promise<DirectUninstallResult> {
  const fmt = formatters ?? {
    formatTitle: defaultFormatTitle,
    formatDescription: defaultFormatDescription,
  };

  const candidates = await traverseScopesFlat<ResolutionCandidate>(
    traverseOpts,
    async ({ scope, context }) => {
      const result = await resolveByName(name, context.targetDir, scope);
      return result.candidates;
    }
  );

  // Create a temporary context for prompt/output port access during disambiguation
  const disambiguationCtx = await createContext({
    global: traverseOpts.globalOnly ?? false,
    cwd: traverseOpts.programOpts?.cwd,
    interactive: true,
  });

  const selected = await disambiguate(
    name,
    candidates,
    (c) => ({
      title: fmt.formatTitle(c),
      description: fmt.formatDescription(c),
      value: c,
    }),
    {
      notFoundMessage: `"${name}" not found as a resource or package.\nRun \`opkg ls\` to see installed resources.`,
      promptMessage: 'Select which to uninstall:',
    },
    resolveOutput(disambiguationCtx),
    resolvePrompt(disambiguationCtx)
  );

  if (selected.length === 0) {
    return { uninstalledCount: 0, cancelled: true, uninstalledItems: [] };
  }

  const uninstalledItems: DirectUninstallResult['uninstalledItems'] = [];

  for (const candidate of selected) {
    const ctx = await createContext({
      global: candidate.resource?.scope === 'global' || candidate.package?.scope === 'global',
      cwd: traverseOpts.programOpts?.cwd,
      interactive: false,
    });
    await executeUninstallCandidate(candidate, options, ctx);

    if (candidate.kind === 'package') {
      uninstalledItems.push({
        name: candidate.package!.packageName,
        kind: 'package',
        scope: candidate.package!.scope,
      });
    } else {
      uninstalledItems.push({
        name: candidate.resource!.resourceName,
        kind: 'resource',
        resourceType: candidate.resource!.resourceType,
        scope: candidate.resource!.scope,
      });
    }
  }

  return { uninstalledCount: selected.length, cancelled: false, uninstalledItems };
}
