/**
 * Platform-aware dependency filtering.
 *
 * Computes the intersection of root-resolved platforms and each dependency's
 * declared platforms. Dependencies with an empty intersection are skipped.
 * Transitive skip propagation ensures that orphaned subtrees (where all
 * parents are skipped) are also skipped.
 */

import type { WaveGraph, WaveNode } from './types.js';
import { getNodePackageName } from './types.js';
import type { Platform } from '../../platforms.js';
import { resolvePlatformName } from '../../platforms.js';

// ============================================================================
// Types
// ============================================================================

export interface PlatformSkipInfo {
  nodeId: string;
  packageName: string;
  /** Raw platform names as declared in the dependency's manifest (pre-alias-resolution) */
  declaredPlatforms: string[];
  /** Resolved root platforms for this install operation */
  rootPlatforms: Platform[];
  reason: string;
}

// ============================================================================
// Pure functions
// ============================================================================

/**
 * Compute the effective platforms for a single node by intersecting its
 * declared platforms with the root-resolved platforms.
 *
 * If the node declares no platforms (universal package), it inherits all
 * root platforms for backward compatibility.
 */
export function computeEffectivePlatforms(
  node: WaveNode,
  rootPlatforms: Platform[]
): Platform[] {
  const declared = node.metadata?.platforms;
  if (!declared || declared.length === 0) {
    // Universal dependency — receives all root platforms
    return rootPlatforms;
  }

  // Resolve aliases (e.g. "claude-code" → "claude") and deduplicate
  const resolvedDeclaredSet = new Set<Platform>();
  for (const raw of declared) {
    const resolved = resolvePlatformName(raw);
    if (resolved) {
      resolvedDeclaredSet.add(resolved);
    }
  }

  // Intersection: only platforms that both root and dependency declare
  return rootPlatforms.filter(rp => resolvedDeclaredSet.has(rp));
}

/**
 * Compute platform skips for every node in the graph.
 *
 * Phase 1: Raw intersection — compute effective platforms per node.
 * Phase 2: Transitive propagation in reverse topological order (parents
 *          before children in install-order terms, since installOrder is
 *          leaves-first). A node is transitively skipped when ALL of its
 *          parents are skipped and it has at least one parent (root-level
 *          deps are never transitively skipped).
 *
 * Returns effective platforms for non-skipped nodes and skip info for
 * skipped nodes.
 */
export function computePlatformSkips(
  graph: WaveGraph,
  rootPlatforms: Platform[]
): {
  effectivePlatforms: Map<string, Platform[]>;
  skippedNodes: Map<string, PlatformSkipInfo>;
} {
  const effectivePlatforms = new Map<string, Platform[]>();
  const skippedNodes = new Map<string, PlatformSkipInfo>();

  // Phase 1: Compute raw intersection for every node
  const rawEffective = new Map<string, Platform[]>();
  for (const [nodeId, node] of graph.nodes) {
    rawEffective.set(nodeId, computeEffectivePlatforms(node, rootPlatforms));
  }

  // Phase 2: Propagate transitive skips in reverse topological order.
  // installOrder is leaves-first, so reversing gives parents-before-children.
  const skippedSet = new Set<string>();
  const reverseOrder = [...graph.installOrder].reverse();

  for (const nodeId of reverseOrder) {
    const node = graph.nodes.get(nodeId);
    if (!node) continue;

    const effective = rawEffective.get(nodeId) ?? [];
    const packageName = getNodePackageName(node);
    const declared = node.metadata?.platforms ?? [];

    if (effective.length === 0) {
      // Directly incompatible — empty intersection
      skippedSet.add(nodeId);
      skippedNodes.set(nodeId, {
        nodeId,
        packageName,
        declaredPlatforms: declared,
        rootPlatforms,
        reason: `requires [${declared.join(', ')}], installing to [${rootPlatforms.join(', ')}]`,
      });
    } else if (
      node.parents.length > 0 &&
      node.parents.every(pid => skippedSet.has(pid))
    ) {
      // Transitively skipped — all dependents are skipped
      skippedSet.add(nodeId);
      skippedNodes.set(nodeId, {
        nodeId,
        packageName,
        declaredPlatforms: declared,
        rootPlatforms,
        reason: `all dependents skipped`,
      });
    } else {
      // Not skipped — record effective platforms
      effectivePlatforms.set(nodeId, effective);
    }
  }

  return { effectivePlatforms, skippedNodes };
}
