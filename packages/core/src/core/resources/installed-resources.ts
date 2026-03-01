import path from 'path';
import { classifySourceKeyBatch } from './resource-classifier.js';
import type { ResourceCatalog, ResourceEntry, ResourceFileRef } from './resource-catalog.js';
import { createCatalog } from './resource-catalog.js';
import { getTargetPath } from '../../utils/workspace-index-helpers.js';
import { exists } from '../../utils/fs.js';
import type { WorkspaceIndexPackage } from '../../types/workspace-index.js';

export async function buildInstalledResourceCatalog(
  pkgEntry: WorkspaceIndexPackage,
  targetDir: string
): Promise<ResourceCatalog> {
  const entryMap = new Map<string, ResourceEntry>();
  const filesObj = pkgEntry.files || {};
  const classified = classifySourceKeyBatch(Object.keys(filesObj));

  for (const [sourceKey, mappings] of Object.entries(filesObj)) {
    if (!Array.isArray(mappings) || mappings.length === 0) {
      continue;
    }

    const cls = classified.get(sourceKey)!;
    const mapKey = `${cls.resourceType}:${cls.resourceName}`;

    let entry = entryMap.get(mapKey);
    if (!entry) {
      entry = {
        origin: 'installed',
        resourceType: cls.resourceType,
        name: cls.resourceName,
        files: [],
      };
      entryMap.set(mapKey, entry);
    }

    for (const mapping of mappings) {
      const target = getTargetPath(mapping);
      const absPath = path.join(targetDir, target);
      const fileExists = await exists(absPath);
      const fileRef: ResourceFileRef = { sourceKey, target, exists: fileExists };
      entry.files.push(fileRef);
    }
  }

  const entries = [...entryMap.values()];
  return createCatalog(entries);
}
