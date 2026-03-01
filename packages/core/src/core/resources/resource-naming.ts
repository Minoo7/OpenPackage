import { basename } from 'path';

export function stripExtension(filename: string): string {
  return filename.replace(/\.[^.]+$/, '') || filename;
}

export function defaultNameFromPath(filePath: string): string {
  return stripExtension(basename(filePath));
}

export function defaultNameFromSkillDir(dirPath: string): string {
  return basename(dirPath);
}

export function preferFrontmatterName(
  frontmatterName: string | undefined,
  fallbackName: string
): string {
  return frontmatterName && frontmatterName.trim().length > 0
    ? frontmatterName
    : fallbackName;
}
