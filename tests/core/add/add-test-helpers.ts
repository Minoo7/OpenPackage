import fs from 'node:fs';
import path from 'node:path';

const UTF8 = 'utf-8';

export function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

export function writeFile(p: string, content: string): void {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, content, { encoding: UTF8 });
}

export function readFile(p: string): string {
  return fs.readFileSync(p, { encoding: UTF8 });
}

export function fileExists(p: string): boolean {
  return fs.existsSync(p);
}

export function writeWorkspacePackageManifest(workspaceDir: string, pkgName = 'workspace-test'): void {
  const pkgDir = path.join(workspaceDir, '.openpackage');
  const manifest = [`name: ${pkgName}`, 'version: 1.0.0', ''].join('\n');
  writeFile(path.join(pkgDir, 'openpackage.yml'), manifest);
}
