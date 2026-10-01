#!/usr/bin/env node
/**
 * Bundle the vscode-php-debug DAP adapter into dist/adapter/phpDebug.js.
 *
 * Upstream (xdebug/vscode-php-debug) is a VS Code extension, not an npm
 * package, so it is pulled in as a pinned git devDependency ("php-debug") and
 * esbuild compiles its src/phpDebug.ts entry directly — no upstream tsc build.
 * Everything the adapter needs at runtime is inlined, so dist/adapter/ is
 * self-contained and consumers (this server, vscode-agentic-debug) ship it
 * without any node_modules.
 */
import { build } from 'esbuild';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const upstream = dirname(require.resolve('php-debug/package.json'));
const outDir = join(root, 'dist', 'adapter');

mkdirSync(outDir, { recursive: true });

const { metafile } = await build({
  entryPoints: [join(upstream, 'src', 'phpDebug.ts')],
  outfile: join(outDir, 'phpDebug.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  metafile: true,
  logLevel: 'warning',
});

// terminal.ts loads these via __dirname, so they must sit next to phpDebug.js.
for (const asset of ['terminateProcess.sh', 'TerminalHelper.scpt']) {
  copyFileSync(join(upstream, 'src', asset), join(outDir, asset));
}
// terminal.ts spawnSync()s this directly; upstream ships it 0644, which fails with EACCES.
chmodSync(join(outDir, 'terminateProcess.sh'), 0o755);
copyFileSync(join(upstream, 'LICENSE.txt'), join(outDir, 'LICENSE.php-debug.txt'));
writeFileSync(join(outDir, 'ThirdPartyNotices.txt'), thirdPartyNotices(Object.keys(metafile.inputs)));

// This package is "type": "module"; the bundle is CJS, so scope it back.
writeFileSync(join(outDir, 'package.json'), '{ "type": "commonjs" }\n');

// Record exactly which upstream commit was bundled, for diagnostics.
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
const spec = pkg.devDependencies['php-debug'];
writeFileSync(join(outDir, 'VERSION'), `xdebug/vscode-php-debug ${spec.split('#')[1] ?? spec}\n`);

console.log(`Bundled vscode-php-debug adapter → ${join('dist', 'adapter', 'phpDebug.js')}`);

/**
 * License texts of upstream and of every npm package esbuild inlined into the
 * bundle — MIT/ISC require them to travel with the code.
 */
function thirdPartyNotices(inputs) {
  const pkgDirs = new Set([upstream]);
  for (const input of inputs) {
    const m = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
    if (m) pkgDirs.add(join(root, m[1]));
  }
  const sections = [...pkgDirs].sort().map((dir) => {
    const { name, version, license } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
    const file = readdirSync(dir).find((f) => /^licen[cs]e/i.test(f));
    const text = file ? readFileSync(join(dir, file), 'utf-8').trim() : `License: ${license}`;
    return `${name}@${version} (${license})\n\n${text}`;
  });
  return (
    'This adapter bundles xdebug/vscode-php-debug and its npm dependencies.\n' +
    'Their license notices follow.\n\n' +
    sections.join(`\n\n${'='.repeat(78)}\n\n`) +
    '\n'
  );
}
