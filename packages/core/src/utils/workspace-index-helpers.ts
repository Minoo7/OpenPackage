/**
 * Helper functions for working with workspace index file mappings
 */

import type { WorkspaceIndexFileMapping } from '../types/workspace-index.js';

/**
 * Extract target path from a mapping (handles both string and object forms)
 */
export function getTargetPath(mapping: string | WorkspaceIndexFileMapping): string {
  return typeof mapping === 'string' ? mapping : mapping.target;
}

/**
 * Check if a mapping is complex (has key tracking)
 */
export function isComplexMapping(mapping: string | WorkspaceIndexFileMapping): mapping is WorkspaceIndexFileMapping {
  return typeof mapping !== 'string';
}

/**
 * Check if a mapping represents a merged file (multiple packages contributing to one target)
 */
export function isMergedMapping(
  mapping: string | WorkspaceIndexFileMapping
): mapping is WorkspaceIndexFileMapping {
  return (
    typeof mapping !== 'string' &&
    !!mapping.merge &&
    Array.isArray(mapping.keys) &&
    mapping.keys.length > 0
  );
}

/**
 * Extract all target paths from file mappings
 */
export function extractAllTargetPaths(
  files: Record<string, (string | WorkspaceIndexFileMapping)[]>
): string[] {
  const paths: string[] = [];
  
  for (const mappings of Object.values(files)) {
    for (const mapping of mappings) {
      paths.push(getTargetPath(mapping));
    }
  }
  
  return paths;
}
