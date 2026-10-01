/**
 * Property-based tests for Zod schema validation.
 * Task 1.7: Schema validation properties
 *
 * Property 1: debugWaitSchema validates timeout inputs correctly
 * Property 2: debugEvaluateSchema context enum rejects invalid values
 *
 * **Validates: Requirements 2.1, 3.1**
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { debugWaitSchema } from '../tools/debug-wait.js';
import { debugEvaluateSchema } from '../tools/debug-evaluate.js';

describe('Property 1: debugWaitSchema validates timeout inputs correctly', () => {
  /**
   * **Validates: Requirements 2.1**
   *
   * For any integer value, parsing { timeout: value } through debugWaitSchema
   * should succeed. For any non-integer number or non-number value, parsing
   * should fail with a validation error.
   */
  it('accepts any integer timeout value', () => {
    fc.assert(
      fc.property(
        fc.integer(),
        (value) => {
          const result = debugWaitSchema.safeParse({ timeout: value });
          expect(result.success).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('accepts omitted timeout (optional field)', () => {
    fc.assert(
      fc.property(
        fc.constant(undefined),
        () => {
          const result = debugWaitSchema.safeParse({});
          expect(result.success).toBe(true);
        },
      ),
      { numRuns: 1 },
    );
  });

  it('rejects non-integer numbers as timeout', () => {
    fc.assert(
      fc.property(
        fc.double({ noInteger: true, noNaN: true, noDefaultInfinity: true, min: -1e6, max: 1e6 }),
        (value) => {
          // Only test actual non-integers (doubles that aren't whole numbers)
          fc.pre(value % 1 !== 0);
          const result = debugWaitSchema.safeParse({ timeout: value });
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('rejects non-number types as timeout', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.boolean(),
          fc.constant(null),
          fc.array(fc.integer()),
          fc.dictionary(fc.string(), fc.integer()),
        ),
        (value) => {
          const result = debugWaitSchema.safeParse({ timeout: value });
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('Property 2: debugEvaluateSchema context enum rejects invalid values', () => {
  /**
   * **Validates: Requirements 3.1**
   *
   * For any string that is not one of 'watch', 'repl', or 'hover',
   * parsing it as the context field of debugEvaluateSchema should fail.
   * For any string that is one of those three values, parsing should succeed.
   */
  const VALID_CONTEXTS = ['watch', 'repl', 'hover'] as const;

  it('accepts valid context enum values', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...VALID_CONTEXTS),
        (context) => {
          const result = debugEvaluateSchema.safeParse({
            expression: 'test',
            context,
          });
          expect(result.success).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('accepts omitted context (optional field)', () => {
    const result = debugEvaluateSchema.safeParse({ expression: 'test' });
    expect(result.success).toBe(true);
  });

  it('rejects invalid context strings', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !VALID_CONTEXTS.includes(s as any)),
        (context) => {
          const result = debugEvaluateSchema.safeParse({
            expression: 'test',
            context,
          });
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});
