import { fileURLToPath } from 'node:url';

/**
 * Absolute path of the vscode-php-debug adapter bundled by
 * scripts/build-adapter.mjs into dist/adapter/ next to this module.
 *
 * Only call this from the ESM build: esbuild's CJS bundles (e.g.
 * vscode-agentic-debug) have no import.meta.url and must pass their own path.
 */
export function bundledAdapterPath(): string {
  if (!import.meta.url) {
    throw new Error('adapterPath is required when agentic-php-debug is bundled as CommonJS');
  }
  return fileURLToPath(new URL('./adapter/phpDebug.js', import.meta.url));
}
