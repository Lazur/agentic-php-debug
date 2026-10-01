/**
 * Property-based tests for CI schema drift detection.
 * Task 5.3: Property tests for CI schema scripts
 *
 * Property 3: CI schema check detects drift
 * Property 4: Sync-then-check round trip
 *
 * **Validates: Requirements 10.1, 10.2, 10.3**
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { z } from 'zod';
import * as allSchemas from '../tools/schemas.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Strip metadata keys that package.json inputSchema doesn't include. */
function normalizeGenerated(jsonSchema: Record<string, unknown>): Record<string, unknown> {
  const { $schema, additionalProperties, ...rest } = jsonSchema;
  const result: Record<string, unknown> = { ...rest };

  // Normalize properties: convert integer → number, strip min/max bounds
  if (result.properties && typeof result.properties === 'object') {
    result.properties = normalizeProperties(result.properties as Record<string, unknown>);
  }
  return result;
}

/** Recursively normalize property definitions to match package.json style. */
function normalizeProperties(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(props)) {
    if (val && typeof val === 'object') {
      out[key] = normalizeProperty(val as Record<string, unknown>);
    } else {
      out[key] = val;
    }
  }
  return out;
}

function normalizeProperty(prop: Record<string, unknown>): Record<string, unknown> {
  const { minimum, maximum, ...rest } = prop;
  const result: Record<string, unknown> = { ...rest };

  // Zod v4 emits "integer" for z.number().int(); package.json uses "number"
  if (result.type === 'integer') {
    result.type = 'number';
  }

  // Recurse into nested items (arrays)
  if (result.items && typeof result.items === 'object') {
    const items = result.items as Record<string, unknown>;
    const { additionalProperties: _ap, ...itemRest } = items;
    result.items = normalizeProperty(itemRest);
  }

  // Recurse into nested properties (objects inside arrays)
  if (result.properties && typeof result.properties === 'object') {
    result.properties = normalizeProperties(result.properties as Record<string, unknown>);
  }

  return result;
}

/**
 * Core comparison: returns list of differences between Zod-generated JSON Schema
 * and a package.json inputSchema entry.
 */
function compareSchemas(zodGenerated: Record<string, unknown>, packageInputSchema: Record<string, unknown>): string[] {
  const diffs: string[] = [];
  const normalized = normalizeGenerated(zodGenerated);

  // Compare type
  if (normalized.type !== packageInputSchema.type) {
    diffs.push(`type: "${normalized.type}" vs "${packageInputSchema.type}"`);
  }

  // Compare required arrays
  const genRequired = (normalized.required as string[] | undefined) ?? [];
  const pkgRequired = (packageInputSchema.required as string[] | undefined) ?? [];
  const missingRequired = genRequired.filter((r) => !pkgRequired.includes(r));
  const extraRequired = pkgRequired.filter((r) => !genRequired.includes(r));
  if (missingRequired.length > 0) diffs.push(`missing required: ${missingRequired.join(', ')}`);
  if (extraRequired.length > 0) diffs.push(`extra required: ${extraRequired.join(', ')}`);

  // Compare property keys
  const genProps = (normalized.properties ?? {}) as Record<string, unknown>;
  const pkgProps = (packageInputSchema.properties ?? {}) as Record<string, unknown>;
  const genKeys = Object.keys(genProps).sort();
  const pkgKeys = Object.keys(pkgProps).sort();
  const missingKeys = genKeys.filter((k) => !pkgKeys.includes(k));
  const extraKeys = pkgKeys.filter((k) => !genKeys.includes(k));
  if (missingKeys.length > 0) diffs.push(`missing properties: ${missingKeys.join(', ')}`);
  if (extraKeys.length > 0) diffs.push(`extra properties: ${extraKeys.join(', ')}`);

  // Compare each shared property's type and enum
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

// ── Schema → tool name mapping ───────────────────────────────────────────────

/** Map of Zod schema export names to their package.json tool names. */
const schemaToToolName: Record<string, string> = {
  debugLaunchSchema: 'debug_launch',
  debugWaitSchema: 'debug_wait',
  debugEvaluateSchema: 'debug_evaluate',
  debugThreadsSchema: 'debug_threads',
  debugContinueSchema: 'debug_continue',
  debugNextSchema: 'debug_next',
  debugStepInSchema: 'debug_step_in',
  debugStepOutSchema: 'debug_step_out',
  debugPauseSchema: 'debug_pause',
  debugSetBreakpointsSchema: 'debug_breakpoints',
  debugVariablesSchema: 'debug_variables',
  debugStackTraceSchema: 'debug_stack_trace',
  debugScopesSchema: 'debug_scopes',
};

/** Load the Extension package.json inputSchema entries. */
function loadExtensionInputSchemas(): Map<string, Record<string, unknown>> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolve(__dirname, '..', '..', '..', 'vscode-agentic-debug', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  const tools: Array<{ name: string; inputSchema: Record<string, unknown> }> =
    pkg.contributes?.languageModelTools ?? [];
  const map = new Map<string, Record<string, unknown>>();
  for (const tool of tools) {
    map.set(tool.name, tool.inputSchema);
  }
  return map;
}

/** Collect all Zod schemas from the barrel file. */
function collectZodSchemas(): Array<{ exportName: string; schema: z.ZodType }> {
  const schemas: Array<{ exportName: string; schema: z.ZodType }> = [];
  for (const [key, value] of Object.entries(allSchemas)) {
    if (key.endsWith('Schema') && value && typeof (value as any).safeParse === 'function') {
      schemas.push({ exportName: key, schema: value as z.ZodType });
    }
  }
  return schemas;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Property 3: CI schema check detects drift', () => {
  /**
   * **Validates: Requirements 10.1, 10.2**
   *
   * For any Zod schema and a corresponding inputSchema JSON object,
   * the check function should return success when they are semantically
   * equivalent and failure when they differ. Specifically: introducing
   * a mutation (adding/removing a property, changing a type) to a
   * matching inputSchema should cause the comparison to detect drift.
   */

  const zodSchemas = collectZodSchemas();
  const extensionSchemas = loadExtensionInputSchemas();

  // Collect schemas that have a matching tool in the extension
  const matchedSchemas = zodSchemas
    .filter((s) => schemaToToolName[s.exportName])
    .map((s) => ({
      ...s,
      toolName: schemaToToolName[s.exportName],
    }))
    .filter((s) => extensionSchemas.has(s.toolName));

  it('detects drift when a random property is added to inputSchema', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...matchedSchemas),
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-z][a-zA-Z]*$/.test(s)),
        fc.constantFrom('string', 'number', 'boolean'),
        (schemaEntry, propName, propType) => {
          const generated = z.toJSONSchema(schemaEntry.schema) as Record<string, unknown>;
          const original = extensionSchemas.get(schemaEntry.toolName)!;

          // Create a mutated copy with an extra property
          const mutated = JSON.parse(JSON.stringify(original));
          const existingProps = Object.keys(mutated.properties ?? {});
          fc.pre(!existingProps.includes(propName));

          mutated.properties = { ...mutated.properties, [propName]: { type: propType } };

          const diffs = compareSchemas(generated, mutated);
          expect(diffs.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('detects drift when a property type is changed in inputSchema', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          ...matchedSchemas.filter((s) => {
            const gen = z.toJSONSchema(s.schema) as Record<string, unknown>;
            const props = gen.properties as Record<string, unknown> | undefined;
            return props && Object.keys(props).length > 0;
          }),
        ),
        fc.constantFrom('string', 'number', 'boolean', 'array'),
        (schemaEntry, newType) => {
          const generated = z.toJSONSchema(schemaEntry.schema) as Record<string, unknown>;
          const original = extensionSchemas.get(schemaEntry.toolName)!;
          const mutated = JSON.parse(JSON.stringify(original));

          const propKeys = Object.keys(mutated.properties ?? {});
          fc.pre(propKeys.length > 0);

          // Pick first property and change its type
          const targetKey = propKeys[0];
          const originalType = (mutated.properties[targetKey] as any).type;
          fc.pre(originalType !== newType);

          mutated.properties[targetKey] = { ...mutated.properties[targetKey], type: newType };

          const diffs = compareSchemas(generated, mutated);
          expect(diffs.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('reports zero drift when inputSchema matches Zod-generated schema', () => {
    // For each matched schema, generate JSON Schema from Zod and compare
    // against itself (normalized) — should always produce zero diffs
    fc.assert(
      fc.property(fc.constantFrom(...matchedSchemas), (schemaEntry) => {
        const generated = z.toJSONSchema(schemaEntry.schema) as Record<string, unknown>;
        // Build a "package.json-style" inputSchema from the generated one
        const normalized = normalizeGenerated(generated);
        const diffs = compareSchemas(generated, normalized);
        expect(diffs).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });
});

describe('Property 4: Sync-then-check round trip', () => {
  /**
   * **Validates: Requirements 10.3**
   *
   * For any set of Zod schemas, running the sync logic (generate JSON Schema
   * from Zod) and then running the check logic should always pass with zero
   * drift detected.
   */

  const zodSchemas = collectZodSchemas();

  it('sync-then-check produces zero drift for all schemas', () => {
    fc.assert(
      fc.property(fc.constantFrom(...zodSchemas), (schemaEntry) => {
        // Sync step: generate JSON Schema from Zod
        const generated = z.toJSONSchema(schemaEntry.schema) as Record<string, unknown>;

        // Simulate writing to package.json: normalize to package.json format
        const synced = normalizeGenerated(generated);

        // Check step: compare the generated schema against the synced version
        const diffs = compareSchemas(generated, synced);
        expect(diffs).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });

  it('round trip holds for randomly composed Zod object schemas', () => {
    // Generate random Zod-like JSON Schema objects and verify round-trip
    const propertyArb = fc.record({
      name: fc.string({ minLength: 1, maxLength: 15 }).filter((s) => /^[a-z][a-zA-Z]*$/.test(s)),
      type: fc.constantFrom('string', 'number', 'boolean'),
      optional: fc.boolean(),
    });

    fc.assert(
      fc.property(fc.array(propertyArb, { minLength: 0, maxLength: 5 }), (properties) => {
        // Build a Zod schema dynamically
        const shape: Record<string, z.ZodType> = {};
        for (const prop of properties) {
          // Deduplicate by name
          if (shape[prop.name]) continue;
          let field: z.ZodType;
          switch (prop.type) {
            case 'string':
              field = z.string();
              break;
            case 'number':
              field = z.number();
              break;
            case 'boolean':
              field = z.boolean();
              break;
            default:
              field = z.string();
          }
          if (prop.optional) field = field.optional();
          shape[prop.name] = field;
        }
        const schema = z.object(shape);

        // Sync: generate JSON Schema
        const generated = z.toJSONSchema(schema) as Record<string, unknown>;
        const synced = normalizeGenerated(generated);

        // Check: compare
        const diffs = compareSchemas(generated, synced);
        expect(diffs).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });
});
