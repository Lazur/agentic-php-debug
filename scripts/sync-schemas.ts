#!/usr/bin/env npx tsx
/**
 * Schema + description sync.
 *
 * Writes the core's generated JSON Schemas and model-facing description
 * constants into the VS Code extension's `contributes.languageModelTools`
 * entries. The core is the single source of truth for both; this script makes
 * the manifest a derived artifact rather than a hand-maintained copy.
 *
 * Extension-only properties (see tool-map.ts) are preserved, not deleted —
 * running this used to silently drop `backendMode` from debug_launch.
 *
 * Requirements: 10.3
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as allSchemas from '../src/tools/schemas.js';
import * as allDescriptions from '../src/tools/descriptions.js';
import {
  collectSchemaEntries,
  generateInputSchema,
  toolNameToDescriptionExport,
} from './tool-map.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const extensionPkgPath = resolve(__dirname, '..', '..', 'vscode-agentic-debug', 'package.json');
const pkg = JSON.parse(readFileSync(extensionPkgPath, 'utf-8'));
const tools: Array<{ name: string; inputSchema: Record<string, unknown>; modelDescription?: string }> =
  pkg.contributes?.languageModelTools ?? [];
const byName = new Map(tools.map((t) => [t.name, t]));

const descriptions = allDescriptions as unknown as Record<string, string>;
let schemasWritten = 0;
let descriptionsWritten = 0;

for (const entry of collectSchemaEntries(allSchemas as unknown as Record<string, unknown>)) {
  const tool = byName.get(entry.toolName);
  if (!tool) {
    console.warn(`⚠️  ${entry.toolName}: not found in Extension package.json, skipping`);
    continue;
  }
  tool.inputSchema = generateInputSchema(entry, tool.inputSchema);
  schemasWritten++;
  console.log(`✅ ${entry.toolName}: inputSchema synced`);
}

for (const [toolName, descExport] of Object.entries(toolNameToDescriptionExport)) {
  const tool = byName.get(toolName);
  if (!tool) continue;
  const expected = descriptions[descExport];
  if (expected === undefined) {
    console.warn(`⚠️  ${toolName}: ${descExport} not exported from descriptions.ts`);
    continue;
  }
  if (tool.modelDescription !== expected) {
    tool.modelDescription = expected;
    descriptionsWritten++;
    console.log(`✅ ${toolName}: modelDescription synced`);
  }
}

writeFileSync(extensionPkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
console.log(
  `\nSynced ${schemasWritten} schemas and ${descriptionsWritten} descriptions into ${extensionPkgPath}`,
);
