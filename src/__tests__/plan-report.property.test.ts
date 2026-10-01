import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  compareToGolden,
  diffJson,
  evaluateExpectations,
  normalizeReport,
  type PlanRunReport,
  type StopRecord,
} from '../plan/report.js';
import { Redactor } from '../plan/redact.js';
import { DebugPlanSchema } from '../plan/schema.js';
import { canonicalJson, PLAN_DEFAULTS } from '../plan/validate.js';

const ROOT = '/work/app';

const valueArb = fc.record({
  value: fc.string({ maxLength: 20 }),
  type: fc.constantFrom('int', 'float', 'string', 'bool'),
  volatile: fc.option(fc.constant(true as const), { nil: undefined }),
});

const stopArb: fc.Arbitrary<StopRecord> = fc.record({
  seq: fc.nat({ max: 100 }),
  probe: fc.option(fc.constantFrom('a', 'b'), { nil: null }),
  kind: fc.constantFrom('line', 'unmatched') as fc.Arbitrary<StopRecord['kind']>,
  hit: fc.nat({ max: 10 }),
  captured: fc.boolean(),
  reason: fc.constantFrom('breakpoint', 'exception'),
  threadId: fc.integer({ min: 1, max: 9 }),
  location: fc.record({
    file: fc.constantFrom(`${ROOT}/src/Cart.php`, '/vendor/lib.php'),
    line: fc.integer({ min: 1, max: 500 }),
  }),
  frames: fc.array(
    fc.record({
      index: fc.nat({ max: 5 }),
      file: fc.constant(`${ROOT}/src/Cart.php`),
      line: fc.integer({ min: 1, max: 500 }),
    }),
    { maxLength: 3 },
  ),
  evaluate: fc.dictionary(fc.constantFrom('$a', '$b', 'microtime(true)'), valueArb),
  at: fc.nat(),
});

const reportArb: fc.Arbitrary<PlanRunReport> = fc.record({
  reportVersion: fc.constant(1 as const),
  runId: fc.uuid(),
  plan: fc.record({ name: fc.constant('p'), version: fc.constant(1), hash: fc.constant('h'), root: fc.constant(ROOT) }),
  surface: fc.constantFrom('in-process', 'mcp'),
  env: fc.record({ node: fc.constant('v22'), platform: fc.constant('darwin') }),
  startedAt: fc.date({ noInvalidDate: true }).map((d) => d.toISOString()),
  durationMs: fc.nat(),
  outcome: fc.constantFrom('completed', 'timeout') as fc.Arbitrary<PlanRunReport['outcome']>,
  phases: fc.record({ initialize: fc.record({ ms: fc.nat() }) }),
  breakpoints: fc.constant([]),
  stops: fc.array(stopArb, { maxLength: 5 }),
  probes: fc.constant({}),
  unmatchedStops: fc.nat({ max: 3 }),
  expectations: fc.constant([]),
  predictions: fc.constant([]),
  errors: fc.constant([]),
  warnings: fc.constant([]),
});

const VOLATILE_KEYS = [
  'runId',
  'startedAt',
  'durationMs',
  'phases',
  'env',
  'surface',
  'at',
  'threadId',
  'id',
  'output',
];

function keysDeep(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysDeep(x, out);
    }
  }
  return out;
}

describe('normalizeReport (property)', () => {
  it('removes every field that differs between identical runs', () => {
    fc.assert(
      fc.property(reportArb, (report) => {
        const n = normalizeReport(report);
        const keys = keysDeep(n);
        for (const k of VOLATILE_KEYS) expect(keys.has(k)).toBe(false);
        const text = JSON.stringify(n);
        expect(text).not.toContain(`"${ROOT}/`);
        for (const s of (n as { stops: Array<{ evaluate?: Record<string, { volatile?: true }> }> }).stops) {
          for (const v of Object.values(s.evaluate ?? {})) expect(v.volatile).toBeUndefined();
        }
      }),
    );
  });

  it('is insensitive to run ids, timings, thread numbering and surface', () => {
    fc.assert(
      fc.property(reportArb, fc.uuid(), fc.integer({ min: 10, max: 99 }), (report, otherId, offset) => {
        const twin: PlanRunReport = {
          ...report,
          runId: otherId,
          durationMs: report.durationMs + 17,
          surface: report.surface === 'mcp' ? 'in-process' : 'mcp',
          stops: report.stops.map((s) => ({ ...s, threadId: s.threadId + offset, at: s.at + 5 })),
        };
        expect(compareToGolden(normalizeReport(twin), normalizeReport(report)).equal).toBe(true);
      }),
    );
  });

  it('keeps real behavioural differences visible', () => {
    fc.assert(
      fc.property(
        reportArb.filter((r) => r.stops.length > 0),
        (report) => {
          const changed: PlanRunReport = {
            ...report,
            stops: report.stops.map((s, i) => (i === 0 ? { ...s, hit: s.hit + 1 } : s)),
          };
          const cmp = compareToGolden(normalizeReport(changed), normalizeReport(report));
          expect(cmp.equal).toBe(false);
          expect(cmp.diffs[0]).toContain('.hit');
        },
      ),
    );
  });
});

describe('diffJson (property)', () => {
  it('finds no difference between a value and its canonical copy', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        expect(diffJson(v, JSON.parse(canonicalJson(v)))).toEqual([]);
      }),
      // A "__proto__" key used to be dropped by canonicalJson.
      { examples: [[JSON.parse('{"":{"__proto__":""}}')]] },
    );
  });
});

describe('Redactor (property)', () => {
  const redactor = new Redactor([...PLAN_DEFAULTS.redactNames], [...PLAN_DEFAULTS.redactScopes]);

  it('redacts any name containing a sensitive fragment, in any case', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 8 }),
        fc.constantFrom(...PLAN_DEFAULTS.redactNames),
        fc.string({ maxLength: 8 }),
        fc.boolean(),
        (pre, fragment, post, upper) => {
          const name = `$${pre}${upper ? fragment.toUpperCase() : fragment}${post}`;
          expect(redactor.isSensitiveName(name)).toBe(true);
          expect(redactor.isSensitiveExpression(`$x->${upper ? fragment.toUpperCase() : fragment}`)).toBe(true);
        },
      ),
    );
  });

  it('leaves everyday names alone', () => {
    for (const name of ['$author', '$authority', '$total', '$items', '$keyboard', '$user']) {
      expect(redactor.isSensitiveName(name)).toBe(false);
    }
    expect(redactor.isValueRedactedScope('superglobals')).toBe(true);
    expect(redactor.isValueRedactedScope('Locals')).toBe(false);
  });
});

describe('plan schema (property)', () => {
  const probeArb = fc.record({
    id: fc.stringMatching(/^[a-z][a-z0-9_-]{0,10}$/),
    file: fc.constant('src/Cart.php'),
    line: fc.integer({ min: 1, max: 1000 }),
    capture: fc.record(
      {
        stack: fc.integer({ min: 1, max: 10 }),
        evaluate: fc.array(fc.constantFrom('$a', '$b->c', 'count($d)'), { maxLength: 3 }),
      },
      { requiredKeys: [] },
    ),
  });

  it('accepts generated plans and round-trips them through JSON unchanged', () => {
    fc.assert(
      fc.property(fc.array(probeArb, { minLength: 1, maxLength: 4 }), (probes) => {
        const plan = { version: 1, name: 'gen', trigger: { kind: 'manual' }, probes };
        const parsed = DebugPlanSchema.parse(plan);
        expect(DebugPlanSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
      }),
    );
  });

  it('rejects unknown fields instead of ignoring them', () => {
    const r = DebugPlanSchema.safeParse({ version: 1, name: 'x', trigger: { kind: 'manual' }, probes: [], typo: true });
    expect(r.success).toBe(false);
  });
});

describe('evaluateExpectations', () => {
  it('requires a value assertion to hold at every captured hit when no hit is given', () => {
    const stop = (hit: number, value: string): StopRecord => ({
      seq: hit,
      probe: 'a',
      kind: 'line',
      hit,
      captured: true,
      reason: 'breakpoint',
      threadId: 1,
      evaluate: { $x: { value, type: 'int' } },
      at: 0,
    });
    const report = { stops: [stop(1, '1'), stop(2, '2')], probes: {}, outcome: 'completed' as const };
    const [all, some] = evaluateExpectations(report, [
      { probe: 'a', expr: '$x', matches: '^\\d$' },
      { probe: 'a', expr: '$x', equals: '1' },
    ]);
    expect(all.pass).toBe(true);
    expect(some.pass).toBe(false);
    expect(some.message).toContain('hit 2');
  });
});
