#!/usr/bin/env npx tsx
/**
 * Write the debug plan JSON Schema to schemas/debug-plan.v1.schema.json.
 *
 * The Zod schema in src/plan/schema.ts is the source of truth; this file is the
 * derived copy editors (VS Code's jsonValidation), MCP clients and humans read.
 * `--check` fails instead of writing when the committed copy has drifted.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planJsonSchema } from '../src/plan/schema.js';

const out = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'schemas', 'debug-plan.v1.schema.json');
const text = `${JSON.stringify(planJsonSchema(), null, 2)}\n`;

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(out, 'utf-8');
  } catch {
    /* missing counts as drift */
  }
  if (current !== text) {
    console.error(`❌ ${out} is out of date. Run \`npm run emit-plan-schema\`.`);
    process.exit(1);
  }
  console.log('✅ plan schema in sync');
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  console.log(`Wrote ${out}`);
}
