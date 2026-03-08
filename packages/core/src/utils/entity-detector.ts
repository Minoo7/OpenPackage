/**
 * Entity Type Detection Utilities
 * 
 * Determines whether a path represents a package, workspace, or generic resource.
 */

import { join } from 'path';
import { exists, isDirectory } from './fs.js';
import type { ResourceTypeId } from '../types/resources.js';

/**
 * Entity type classification
 */
export type EntityType = 'workspace' | 'package' | 'resource';

/**
 * Detect whether a directory IS a single resource (skill, plugin, etc.)
 * rather than a package containing multiple resources.
 *
 * Returns the resource type if the directory is a single resource, or null
 * if it's a package/workspace/unknown.
 */
export async function detectSingleResourceType(path: string): Promise<ResourceTypeId | null> {
  // Package markers take priority — never treat a package as a single resource
  if (await exists(join(path, 'openpackage.yml'))) return null;
  if (await exists(join(path, '.openpackage', 'openpackage.yml'))) return null;

  // Skill: has SKILL.md at root
  if (await exists(join(path, 'SKILL.md'))) return 'skill';

  // Plugin: has .claude-plugin/plugin.json
  if (await exists(join(path, '.claude-plugin', 'plugin.json'))) return 'plugin';

  return null;
}

/**
 * Detect the type of entity at a given path.
 * 
 * Detection logic:
 * - workspace: Has .openpackage/openpackage.yml
 * - package: Has openpackage.yml, or has Claude plugin characteristics, or has standard package directories
 * - resource: Everything else (individual files, subdirectories without package markers)
 * 
 * @param path - Absolute path to check
 * @returns Entity type
 */
export async function detectEntityType(path: string): Promise<EntityType> {
  // Check for workspace marker (.openpackage/openpackage.yml)
  const workspaceMarker = join(path, '.openpackage', 'openpackage.yml');
  if (await exists(workspaceMarker)) {
    return 'workspace';
  }

  // Check for package marker (openpackage.yml at root)
  const packageMarker = join(path, 'openpackage.yml');
  if (await exists(packageMarker)) {
    return 'package';
  }

  // Check if this directory IS a single resource (skill dir, plugin dir, etc.)
  // This must come before the resource-dir heuristic, otherwise a skill dir
  // containing agents/ would be misclassified as a package.
  const singleType = await detectSingleResourceType(path);
  if (singleType !== null) {
    return 'resource';
  }

  // Check for Claude plugin characteristics (.claude-plugin/plugin.json)
  const claudePluginMarker = join(path, '.claude-plugin', 'plugin.json');
  if (await exists(claudePluginMarker)) {
    return 'package';
  }

  // Check for standard package directories (agents/, skills/, commands/, rules/, hooks/)
  const packageDirs = ['agents', 'skills', 'commands', 'rules', 'hooks'];
  for (const dir of packageDirs) {
    const dirPath = join(path, dir);
    if (await exists(dirPath) && await isDirectory(dirPath)) {
      return 'package';
    }
  }

  // Default to resource for everything else
  return 'resource';
}

/**
 * Get the display name for an entity.
 * 
 * For packages: reads name from openpackage.yml, falls back to directory name
 * For other types: uses the provided name
 * 
 * @param path - Absolute path to the entity
 * @param fallbackName - Name to use if package name cannot be determined
 * @returns Display name
 */
export async function getEntityDisplayName(
  path: string,
  fallbackName: string
): Promise<string> {
  const entityType = await detectEntityType(path);

  // For packages and workspaces, try to read the name from openpackage.yml
  if (entityType === 'package' || entityType === 'workspace') {
    try {
      const { parsePackageYml } = await import('./package-yml.js');
      const manifestPath = entityType === 'workspace'
        ? join(path, '.openpackage', 'openpackage.yml')
        : join(path, 'openpackage.yml');

      if (await exists(manifestPath)) {
        const manifest = await parsePackageYml(manifestPath);
        if (manifest.name) {
          return manifest.name;
        }
      }
    } catch (error) {
      // Fall through to use fallback name
    }
  }

  return fallbackName;
}
