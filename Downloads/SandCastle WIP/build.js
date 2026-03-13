/**
 * SandCastle — esbuild config
 *
 * Bundles docs/web/api.js (and its imports from src/) into a single
 * browser-ready file at docs/web/bundle.js.
 *
 * The Electron main process (main.js, src/db.js, src/exporter.js) is NOT
 * bundled — it runs directly in Node.js as before.
 *
 * Usage:
 *   npm run build          → one-time build
 *   npm run watch          → rebuild on every file save (dev mode)
 *   npm run build:prod     → minified production build
 */

'use strict';

const esbuild = require('esbuild');
const watch   = process.argv.includes('--watch');
const prod    = process.argv.includes('--minify');

const config = {
  entryPoints: ['docs/web/api.js'],
  bundle:      true,
  outfile:     'docs/web/bundle.js',
  platform:    'browser',
  format:      'iife',
  sourcemap:   true,
  // fs and path are Node-only — parseFilePath (which uses them) is never
  // called from the browser. Marking them external prevents esbuild from
  // trying to stub them and keeps the bundle clean.
  external:    ['fs', 'path', 'electron'],
  minify:      prod,
};

if (watch) {
  esbuild.context(config).then(ctx => {
    ctx.watch();
    console.log('[esbuild] Watching for changes…');
  });
} else {
  esbuild.build(config).then(() => {
    console.log('[esbuild] Built docs/web/bundle.js' + (prod ? ' (minified)' : ''));
  }).catch(() => process.exit(1));
}
