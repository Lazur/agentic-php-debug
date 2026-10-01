import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planJsonSchema } from '../plan/schema.js';

/**
 * schemas/debug-plan.v1.schema.json is what editors validate *.debugplan.json
 * files against. It is generated from the Zod schema; this catches a Zod change
 * that was not followed by `npm run emit-plan-schema`.
 */
describe('committed plan JSON Schema', () => {
  it('matches the Zod source', () => {
    const file = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schemas', 'debug-plan.v1.schema.json');
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual(planJsonSchema());
  });
});
