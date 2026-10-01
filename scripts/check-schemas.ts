#!/usr/bin/env npx tsx
/**
 * CI schema + description drift detection.
 *
 * Compares the core's Zod schemas and model-facing description constants
 * against the VS Code extension's `contributes.languageModelTools` manifest,
 * and exits non-zero on drift. The manifest is what Copilot actually reads, so
 * drift here means the agent is being told about a version of the core that no
 * longer exists.
 *
 * Requirements: 10.1, 10.2
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as allSchemas from '../src/tools/schemas.js';
import * as allDescriptions from '../src/tools/descriptions.js';
import {
  collectSchemaEntries,
  extensionOnlyProperties,
  extensionOnlyTools,
  generateInputSchema,
  toolNameToDescriptionExport,
} from './tool-map.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Compare a generated inputSchema against a manifest entry. */
function compareSchemas(
  generated: Record<string, unknown>,
  manifest: Record<string, unknown>,
  toolName: string,
): string[] {
  const diffs: string[] = [];
  const tolerated = new Set(extensionOnlyProperties[toolName] ?? []);

  if (generated.type !== manifest.type) {
    diffs.push(`type: "${generated.type}" vs "${manifest.type}"`);
  }

  const genRequired = (generated.required as string[] | undefined) ?? [];
  const pkgRequired = (manifest.required as string[] | undefined) ?? [];
  const missingRequired = genRequired.filter((r) => !pkgRequired.includes(r));
  const extraRequired = pkgRequired.filter((r) => !genRequired.includes(r));
  if (missingRequired.length > 0) diffs.push(`missing required: ${missingRequired.join(', ')}`);
  if (extraRequired.length > 0) diffs.push(`extra required: ${extraRequired.join(', ')}`);

  const genProps = (generated.properties ?? {}) as Record<string, unknown>;
  const pkgProps = (manifest.properties ?? {}) as Record<string, unknown>;
  const genKeys = Object.keys(genProps).sort();
  const pkgKeys = Object.keys(pkgProps).sort();

  const missingKeys = genKeys.filter((k) => !pkgKeys.includes(k));
  const extraKeys = pkgKeys.filter((k) => !genKeys.includes(k) && !tolerated.has(k));
  if (missingKeys.length > 0) diffs.push(`missing properties: ${missingKeys.join(', ')}`);
  if (extraKeys.length > 0) diffs.push(`extra properties: ${extraKeys.join(', ')}`);

  for (const key of genKeys.filter((k) => pkgKeys.includes(k))) {
    const genProp = genProps[key] as Record<string, unknown>;
    const pkgProp = pkgProps[key] as Record<string, unknown>;
    if (genProp.type !== pkgProp.type) {
      diffs.push(`${key}.type: "${genProp.type}" vs "${pkgProp.type}"`);
    }
    const genEnum = JSON.stringify(genProp.enum ?? null);
    const pkgEnum = JSON.stringify(pkgProp.enum ?? null);
    if (genEnum !== pkgEnum) {
      diffs.push(`${key}.enum: ${genEnum} vs ${pkgEnum}`);
    }
  }

  return diffs;
}

/** One-line preview of where two description strings first differ. */
function describeTextDrift(expected: string, actual: string | undefined): string {
  if (actual === undefined) return 'modelDescription: missing';
  let i = 0;
  while (i < expected.length && i < actual.length && expected[i] === actual[i]) i++;
  const at = expected.slice(i, i + 60).replace(/\n/g, '\\n');
  const got = actual.slice(i, i + 60).replace(/\n/g, '\\n');
  return `modelDescription: diverges at char ${i}\n       core: …${at}…\n       pkg:  …${got}…`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const extensionPkgPath = resolve(__dirname, '..', '..', 'vscode-agentic-debug', 'package.json');
const pkg = JSON.parse(readFileSync(extensionPkgPath, 'utf-8'));
const tools: Array<{ name: string; inputSchema: Record<string, unknown>; modelDescription?: string }> =
  pkg.contributes?.languageModelTools ?? [];
const byName = new Map(tools.map((t) => [t.name, t]));

const descriptions = allDescriptions as unknown as Record<string, string>;
let hasDrift = false;

for (const entry of collectSchemaEntries(allSchemas as unknown as Record<string, unknown>)) {
  const tool = byName.get(entry.toolName);
  if (!tool) {
    console.error(`❌ ${entry.toolName}: not declared in Extension package.json`);
    hasDrift = true;
    continue;
  }

  const generated = generateInputSchema(entry, tool.inputSchema);
  const diffs = compareSchemas(generated, tool.inputSchema ?? {}, entry.toolName);

  const descExport = toolNameToDescriptionExport[entry.toolName];
  const expected = descExport ? descriptions[descExport] : undefined;
  if (expected !== undefined && tool.modelDescription !== expected) {
    diffs.push(describeTextDrift(expected, tool.modelDescription));
  }

  if (diffs.length > 0) {
    hasDrift = true;
    console.error(`❌ ${entry.toolName}:`);
    for (const diff of diffs) console.error(`   ${diff}`);
  } else {
    console.log(`✅ ${entry.toolName}: OK`);
  }
}

// Tools with no input schema still have prose that can rot.
for (const [toolName, descExport] of Object.entries(toolNameToDescriptionExport)) {
  if (
    byName.has(toolName) &&
    !collectSchemaEntries(allSchemas as unknown as Record<string, unknown>).some((e) => e.toolName === toolName)
  ) {
    const tool = byName.get(toolName)!;
    const expected = descriptions[descExport];
    if (expected !== undefined && tool.modelDescription !== expected) {
      hasDrift = true;
      console.error(`❌ ${toolName}:\n   ${describeTextDrift(expected, tool.modelDescription)}`);
    } else {
      console.log(`✅ ${toolName}: OK (description only)`);
    }
  }
}

// Anything in the manifest we do not know about is either a new core tool that
// was never mapped, or an extension-only tool that must be declared as such.
for (const tool of tools) {
  const known = toolNameToDescriptionExport[tool.name] !== undefined || extensionOnlyTools.has(tool.name);
  if (!known) {
    hasDrift = true;
    console.error(`❌ ${tool.name}: in the manifest but not in tool-map.ts — map it or declare it extension-only`);
  }
}

if (hasDrift) {
  console.error('\nDrift detected. Run `npm run sync-schemas` to fix.');
  process.exit(1);
} else {
  console.log(`\nAll ${tools.length} tools in sync.`);
}
