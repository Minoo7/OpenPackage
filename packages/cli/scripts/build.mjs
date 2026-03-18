import { build } from 'esbuild';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..');

// Build with esbuild
// splitting: true ensures dynamic import() calls produce separate chunks,
// so only the invoked command's code is loaded at runtime.
await build({
  entryPoints: [join(root, 'src/index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2020',
  outdir: join(root, 'dist'),
  banner: {
    js: '#!/usr/bin/env node',
  },
  // Preserve dynamic imports as separate chunks for lazy command loading
  splitting: true,
  // Keep npm packages external (avoids CJS/ESM compat issues).
  // The project's own source is bundled; npm deps stay in node_modules.
  packages: 'external',
  sourcemap: true,
  // Tree-shake unused code
  treeShaking: true,
  // Keep readable output for debugging
  minifySyntax: true,
  minifyWhitespace: false,
  minifyIdentifiers: false,
});

console.log('Build complete: dist/');
