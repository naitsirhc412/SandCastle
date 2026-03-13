/**
 * SandCastle — esbuild config
 *
 * Builds the same bundle to two locations:
 *   renderer/bundle.js   → loaded by renderer/deskindex.html (Electron desktop)
 *   docs/web/bundle.js   → loaded by docs/webindex.html (browser / GitHub Pages)
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

const shared = {
  entryPoints: ['docs/web/api.js'],
  bundle:      true,
  platform:    'browser',
  format:      'iife',
  sourcemap:   true,
  external:    ['fs', 'path', 'electron'],
  minify:      prod,
};

const targets = [
  { outfile: 'renderer/bundle.js',  label: 'renderer/bundle.js'  },
  { outfile: 'docs/web/bundle.js',  label: 'docs/web/bundle.js'  },
];

if (watch) {
  Promise.all(targets.map(t =>
    esbuild.context({ ...shared, outfile: t.outfile }).then(ctx => ctx.watch())
  )).then(() => {
    console.log('[esbuild] Watching for changes — building to both targets…');
  });
} else {
  Promise.all(targets.map(t =>
    esbuild.build({ ...shared, outfile: t.outfile }).then(() =>
      console.log('[esbuild] Built ' + t.label + (prod ? ' (minified)' : ''))
    )
  )).catch(() => process.exit(1));
}