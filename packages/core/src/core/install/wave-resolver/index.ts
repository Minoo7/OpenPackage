/**
 * Wave-based BFS dependency resolver.
 *
 * Processes dependencies in breadth-first waves -- each wave batches all
 * unresolved packages at the current frontier, fetches their metadata in
 * parallel, discovers new dependencies, and repeats until the queue is empty.
 *
 * Public API:
 *   resolveWave()          - Run the BFS resolution loop
 *   buildInstallContexts() - Convert the graph into pipeline-ready contexts
 *   updateWorkspaceIndex() - Post-install index update
 */

export { resolveWave } from './wave-engine.js';
export { buildInstallContexts, type BuildContextOptions } from './context-builder.js';
export { updateWorkspaceIndex } from './index-updater.js';
export type {
  WaveNode,
  WaveGraph,
  WaveResult,
  WaveVersionSolution,
  WaveVersionConflict,
  WaveResolverOptions,
  FetchResult,
  PackageFetcher,
  FetcherOptions
} from './types.js';
export { getNodePackageName } from './types.js';
export { computeEffectivePlatforms, computePlatformSkips, type PlatformSkipInfo } from './platform-filter.js';
