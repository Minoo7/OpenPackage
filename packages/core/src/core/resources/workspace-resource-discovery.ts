/**
 * Workspace Resource Discovery
 *
 * Shared module for discovering resource files in workspace platform directories
 * and mapping them to SourceEntry[]. Used by both the add and move commands.
 */

import { basename, join } from 'path';

import fg from 'fast-glob';
import { isJunk } from 'junk';

import type { ResourceTypeId, ResourceTypeDef } from '../../types/resources.js';
import type { SourceEntry } from '../add/source-collector.js';
import { getResourceTypeDef } from './resource-registry.js';
import { mapWorkspaceFileToUniversal } from '../platform/platform-mapper.js';
import { getDetectedPlatforms, getPlatformDefinition, deriveRootDirFromFlows } from '../platforms.js';
import { exists } from '../../utils/fs.js';

/**
 * Scan all platform directories for files belonging to a specific resource.
 * Returns absolute paths found on disk — no index/install-state needed.
 */
export async function discoverResourceFiles(
  typeDef: ResourceTypeDef,
  resourceName: string,
  targetDir: string,
): Promise<string[]> {
  const platforms = await getDetectedPlatforms(targetDir);
  const seen = new Set<string>();
  const results: string[] = [];
  const escaped = fg.escapePath(resourceName);

  for (const platform of platforms) {
    try {
      const def = getPlatformDefinition(platform, targetDir);
      const rootDir = deriveRootDirFromFlows(def);
      const cwd = join(targetDir, rootDir, typeDef.dirName!);

      // Marker-based (e.g. skills/) -> grab everything inside the directory
      // File-based (e.g. rules/) -> also grab single-file matches like name.*
      const patterns = [`${escaped}/**/*`];
      if (!typeDef.marker) {
        patterns.push(`${escaped}.*`);
      }

      const matches = await fg(patterns, { cwd, absolute: true, dot: false });
      for (const abs of matches) {
        if (isJunk(basename(abs))) continue;
        if (seen.has(abs)) continue;
        seen.add(abs);
        results.push(abs);
      }
    } catch {
      // Platform directory may not exist — expected, skip.
    }
  }

  return results;
}

/**
 * Build SourceEntry[] from workspace resource files using flow-based mapping.
 *
 * For types with a dirName (skills, rules, agents, etc.) this scans platform
 * directories via discoverResourceFiles. For dirName:null types (mcp, plugin, other)
 * it falls back to targetFiles with an exists() guard.
 *
 * Registry paths are derived via mapWorkspaceFileToUniversal() — the same
 * flow-based logic used by the add command — ensuring consistent paths.
 */
export async function buildEntriesFromWorkspaceResource(
  resourceType: ResourceTypeId,
  resourceName: string,
  targetFiles: string[],
  targetDir: string,
): Promise<SourceEntry[]> {
  const typeDef = getResourceTypeDef(resourceType);
  let discoveredFiles: string[];

  if (typeDef.dirName) {
    discoveredFiles = await discoverResourceFiles(typeDef, resourceName, targetDir);
  } else {
    discoveredFiles = [];
    for (const tf of targetFiles) {
      const abs = join(targetDir, tf);
      if (await exists(abs)) discoveredFiles.push(abs);
    }
  }

  const entries: SourceEntry[] = [];
  const seenRegistryPaths = new Set<string>();

  for (const absSource of discoveredFiles) {
    let mapping;
    try {
      mapping = mapWorkspaceFileToUniversal(absSource, targetDir);
    } catch {
      continue;
    }
    if (!mapping) continue;
    const registryPath = [mapping.subdir, mapping.relPath].filter(Boolean).join('/');
    if (seenRegistryPaths.has(registryPath)) continue;
    seenRegistryPaths.add(registryPath);
    entries.push({ sourcePath: absSource, registryPath });
  }

  return entries;
}
