/**
 * Platform Root Files Utilities
 * Shared utilities for collecting and working with platform root file names
 */

import { FILE_PATTERNS } from '../../constants/index.js';
import type { Platform } from '../../types/platform.js';
import { getPlatformDefinition } from '../platforms.js';

/**
 * Get all platform root file names (including universal AGENTS.md) for the given platforms.
 * @param platforms - Array of platforms to collect root files from
 * @param targetDir - Optional target directory for platform config overrides
 * @returns Set of root file names
 */
export function getPlatformRootFileNames(platforms: Platform[], targetDir?: string): Set<string> {
  const names = new Set<string>([FILE_PATTERNS.AGENTS_MD]);
  for (const platform of platforms) {
    const def = getPlatformDefinition(platform, targetDir);
    if (def.rootFile) {
      names.add(def.rootFile);
    }
  }
  return names;
}
