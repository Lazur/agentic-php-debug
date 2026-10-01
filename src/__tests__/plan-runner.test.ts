import { describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakePhp, type FakeConnection, type FakeStop } from './helpers/fake-php.js';
import { validatePlan } from '../plan/validate.js';
import { InProcessInvoker, JournalingInvoker, type ToolInvoker } from '../plan/invoker.js';
import { runPlan, type RunPlanOptions } from '../plan/runner.js';
import { compareToGolden, normalizeReport } from '../plan/report.js';
import { coreToolDefinitions } from '../tools/registry.js';
import { SessionState } from '../session.js';

const CART_PHP = `<?php
function lineTotal(float $price, int $qty): float
{
    $lineTotal = round($price * $qty, 2);
    return $lineTotal;
}
$items = [[1.115, 3], [2.5, 1]];
$total = 0;
foreach ($items as [$price, $qty]) {
    $total += lineTotal($price, $qty);
}
echo $total;
`;

function workspace(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'plan-runner-')));
  writeFileSync(join(dir, 'cart.php'), CART_PHP);
  return dir;
}

const FAST_LIMITS = { idleMs: 20, waitMs: 200, connectTimeoutMs: 400, timeoutMs: 5000 };

function plan(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    name: 'cart',
    trigger: { kind: 'command', argv: ['php', 'cart.php'] },
    probes: [{ id: 'line-total', file: 'cart.php', line: 5, capture: { evaluate: ['$lineTotal'] } }],
    limits: FAST_LIMITS,
    ...overrides,
  };
}

function stopAt(dir: string, line: number, extra: Partial<FakeStop> = {}): FakeStop {
  return { file: join(dir, 'cart.php'), line, function: 'lineTotal', ...extra };
}

function invokerFor(fake: FakePhp) {
  const session = fake.session();
  const invoker = new InProcessInvoker(
    session,
    coreToolDefinitions({ launchDeps: { isPortBound: async () => false } }),
  );
  return { session, invoker };
}

async function run(
  fake: FakePhp,
  dir: string,
  planInput: object,
  connections: FakeConnection[],
  opts: {
    trigger?: Parameters<FakePhp['trigger']>[1];
    run?: Partial<RunPlanOptions>;
    wrap?: (inner: ToolInvoker) => ToolInvoker;
  } = {},
) {
  const v = validatePlan(planInput, { baseDir: dir });
  expect(v.errors).toEqual([]);
  const { session, invoker } = invokerFor(fake);
  const journaling = new JournalingInvoker(opts.wrap ? opts.wrap(invoker) : invoker);
  const report = await runPlan(v.plan!, {
    invoker: journaling,
    startTrigger: fake.trigger(connections, opts.trigger),
    ...opts.run,
  });
  return { report, session, journal: journaling.entries };
}

describe('plan runner', () => {
  it('arms breakpoints before triggering, captures every hit, and tears down', async () => {
    const dir = workspace();
    const fake = new FakePhp();
    const { report, session, journal } = await run(
      fake,
      dir,
      plan({
        expect: [
          { probe: 'line-total', hits: 2 },
          { probe: 'line-total', hit: 1, expr: '$lineTotal', equals: '3.35' },
          { sequence: ['line-total', 'line-total'] },
          { outcome: 'completed' },
          { trigger: { exitCode: 0 } },
        ],
      }),
      [
        {
          stops: [
            stopAt(dir, 5, { evaluate: { $lineTotal: { result: '3.35', type: 'float' } } }),
            stopAt(dir, 5, { evaluate: { $lineTotal: { result: '2.5', type: 'float' } } }),
          ],
        },
      ],
    );

    expect(report.outcome).toBe('completed');
    expect(report.probes['line-total']).toEqual({ kind: 'line', hits: 2, captured: 2 });
    expect(report.stops.map((s) => s.evaluate?.['$lineTotal']?.value)).toEqual(['3.35', '2.5']);
    expect(report.breakpoints).toMatchObject([{ probe: 'line-total', verification: 'pending_connection' }]);
    expect(report.expectations.every((r) => r.pass)).toBe(true);
    expect(session.state).toBe(SessionState.Terminated);

    // The file's breakpoints are sent exactly once (re-sending resets hit counters)
    // and the tools run in phase order.
    expect(fake.commands().filter((c) => c === 'setBreakpoints')).toHaveLength(1);
    const tools = journal.map((e) => e.tool);
    expect(tools.slice(0, 4)).toEqual(['debug_status', 'debug_launch', 'debug_set_breakpoints', 'debug_status']);
    expect(tools.at(-1)).toBe('debug_terminate');
    // Captures read variables without running PHP where the adapter can.
    expect(fake.requests.find((r) => r.command === 'evaluate')?.args.context).toBe('watch');
  });

  it('reports failed expectations with the observed value', async () => {
    const dir = workspace();
    const fake = new FakePhp();
    const { report } = await run(
      fake,
      dir,
      plan({
        expect: [
          { probe: 'line-total', hit: 1, expr: '$lineTotal', equals: '3.34' },
          { probe: 'line-total', hits: 3 },
        ],
      }),
      [{ stops: [stopAt(dir, 5, { evaluate: { $lineTotal: { result: '3.35', type: 'float' } } })] }],
    );
    expect(report.expectations.map((r) => r.pass)).toEqual([false, false]);
    expect(report.expectations[0].message).toContain('"3.35"');
    expect(report.expectations[1].actual).toBe(1);
  });

  it('counts hits past maxCaptures without inspecting them', async () => {
    const dir = workspace();
    const fake = new FakePhp();
    const stops = Array.from({ length: 5 }, () =>
      stopAt(dir, 5, { evaluate: { $lineTotal: { result: '1', type: 'int' } } }),
    );
    const { report } = await run(
      fake,
      dir,
      plan({
        probes: [
          { id: 'line-total', file: 'cart.php', line: 5, maxCaptures: 2, capture: { evaluate: ['$lineTotal'] } },
        ],
      }),
      [{ stops }],
    );
    expect(report.probes['line-total']).toEqual({ kind: 'line', hits: 5, captured: 2 });
    expect(report.stops.map((s) => s.captured)).toEqual([true, true, false, false, false]);
    expect(fake.commands().filter((c) => c === 'evaluate')).toHaveLength(2);
  });

  it('records an unmatched stop and continues by default', async () => {
    const dir = workspace();
    const fake = new FakePhp();
    const { report } = await run(fake, dir, plan(), [
      { stops: [stopAt(dir, 10, { function: '{main}' }), stopAt(dir, 5)] },
    ]);
    expect(report.outcome).toBe('completed');
    expect(report.unmatchedStops).toBe(1);
    expect(report.stops[0]).toMatchObject({ kind: 'unmatched', probe: null, location: { line: 10 } });
    expect(report.stops[0].frames?.[0]).toMatchObject({ line: 10, name: '{main}' });
    expect(report.probes['line-total'].hits).toBe(1);
  });

  it('drops an unmatched stop from the timeline with onUnmatchedStop "ignore"', async () => {
    const dir = workspace();
    const fake = new FakePhp();
    const { report } = await run(fake, dir, plan({ onUnmatchedStop: 'ignore' }), [
      { stops: [stopAt(dir, 10), stopAt(dir, 5)] },
    ]);
    expect(report.unmatchedStops).toBe(1);
    expect(report.stops.map((s) => s.kind)).toEqual(['line']);
  });

  it('aborts on an unmatched stop with onUnmatchedStop "abort", still tearing down', async () => {
    const dir = workspace();
    const fake = new FakePhp();
    const { report, session } = await run(fake, dir, plan({ onUnmatchedStop: 'abort' }), [
      { stops: [stopAt(dir, 10)] },
    ]);
    expect(report.outcome).toBe('failed');
    expect(report.errors.map((e) => e.code)).toContain('UNMATCHED_STOP');
    expect(session.state).toBe(SessionState.Terminated);
  });

  it('matches exception stops to the exception probe and records exception info', async () => {
    const dir = workspace();
    const fake = new FakePhp();
    const { report } = await run(
      fake,
      dir,
      plan({
        probes: undefined,
        exceptions: { filters: ['Exception'], capture: { evaluate: ['$e->getMessage()'] } },
      }),
      [
        {
          stops: [
            stopAt(dir, 4, {
              reason: 'exception',
              exception: { exceptionId: 'App\\PriceException', description: 'negative price' },
              evaluate: { '$e->getMessage()': { result: "'negative price'", type: 'string' } },
            }),
          ],
        },
      ],
    );
    expect(fake.commands()).toContain('setExceptionBreakpoints');
    expect(report.stops[0]).toMatchObject({
      kind: 'exception',
      probe: 'exception',
      exception: { exceptionId: 'App\\PriceException', description: 'negative price' },
    });
    expect(report.stops[0].evaluate?.['$e->getMessage()']?.value).toBe("'negative price'");
  });

  it('matches function probes by name, whatever the method separator', async () => {
    const dir = workspace();
    const fake = new FakePhp();
    const { report } = await run(
      fake,
      dir,
      plan({ probes: undefined, functions: [{ id: 'total', name: 'App\\Cart::total' }] }),
      [{ stops: [stopAt(dir, 3, { function: 'App\\Cart->total' })] }],
    );
    expect(fake.commands()).toContain('setFunctionBreakpoints');
    expect(report.stops[0]).toMatchObject({ kind: 'function', probe: 'total', hit: 1 });
  });

  it('matches a stop on the line the adapter resolved the breakpoint to', async () => {
    const dir = workspace();
    const fake = new FakePhp({ resolveLine: (_f, line) => (line === 4 ? 5 : line) });
    const { report } = await run(fake, dir, plan({ probes: [{ id: 'line-total', file: 'cart.php', line: 4 }] }), [
      { stops: [stopAt(dir, 5)] },
    ]);
    expect(report.stops[0]).toMatchObject({ kind: 'line', probe: 'line-total' });
  });

  it('handles several connections suspended at once', async () => {
    const dir = workspace();
    const fake = new FakePhp();
    const { report } = await run(fake, dir, plan(), [{ stops: [stopAt(dir, 5)] }, { stops: [stopAt(dir, 5)] }], {
      trigger: { parallel: true },
    });
    expect(report.outcome).toBe('completed');
    expect(report.probes['line-total'].hits).toBe(2);
    expect(new Set(report.stops.map((s) => s.threadId)).size).toBe(2);
  });

  it('ends with no_connection when PHP finishes without dialling in', async () => {
    const dir = workspace();
    const fake = new FakePhp();
    const { report } = await run(fake, dir, plan(), []);
    expect(report.outcome).toBe('no_connection');
    expect(report.outcomeDetail).toContain('Xdebug never connected');
  });

  it('ends with no_connection after connectTimeoutMs when nothing happens', async () => {
    const dir = workspace();
    const fake = new FakePhp();
    const started = Date.now();
    const { report } = await run(fake, dir, plan(), [], { trigger: { neverSettle: true } });
    expect(report.outcome).toBe('no_connection');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('ends with timeout when the trigger never finishes', async () => {
    const dir = workspace();
    const fake = new FakePhp();
    const { report, session } = await run(
      fake,
      dir,
      plan({ limits: { ...FAST_LIMITS, timeoutMs: 1000 } }),
      [{ stops: [stopAt(dir, 5)] }],
      { trigger: { neverSettle: true } },
    );
    expect(report.outcome).toBe('timeout');
    expect(report.probes['line-total'].hits).toBe(1);
    expect(session.state).toBe(SessionState.Terminated);
  });

  it('is cancellable, and still terminates the session', async () => {
    const dir = workspace();
    const fake = new FakePhp();
    const abort = new AbortController();
    const { report, session } = await run(
      fake,
      dir,
      plan(),
      [{ stops: [stopAt(dir, 5), stopAt(dir, 5), stopAt(dir, 5)] }],
      {
        trigger: { neverSettle: true },
        run: {
          signal: abort.signal,
          onProgress: (p) => {
            if (p.message.startsWith('stop 1')) abort.abort();
          },
        },
      },
    );
    expect(report.outcome).toBe('cancelled');
    expect(report.probes['line-total'].hits).toBe(1);
    expect(session.state).toBe(SessionState.Terminated);
  });

  it('never takes over a session that is already running', async () => {
    const dir = workspace();
    const fake = new FakePhp();
    const v = validatePlan(plan(), { baseDir: dir });
    const { session, invoker } = invokerFor(fake);
    await session.launch();
    const report = await runPlan(v.plan!, { invoker, startTrigger: fake.trigger([]) });
    expect(report.outcome).toBe('failed');
    expect(report.errors[0].code).toBe('SESSION_BUSY');
    // Left exactly as it was: not terminated.
    expect(session.state).toBe(SessionState.Listening);
  });

  it('refuses to trigger when a connection already exists (a config that launches a program)', async () => {
    const dir = workspace();
    const fake = new FakePhp({ connectDuringLaunch: true });
    const { report, session } = await run(fake, dir, plan(), [{ stops: [stopAt(dir, 5)] }]);
    expect(report.outcome).toBe('failed');
    expect(report.errors.map((e) => e.code)).toContain('NOT_LISTENING');
    expect(report.stops).toEqual([]);
    expect(session.state).toBe(SessionState.Terminated);
  });

  it('records a failing expression without losing the rest of the capture', async () => {
    const dir = workspace();
    const fake = new FakePhp();
    const { report } = await run(
      fake,
      dir,
      plan({
        probes: [{ id: 'line-total', file: 'cart.php', line: 5, capture: { evaluate: ['$missing', '$lineTotal'] } }],
      }),
      [{ stops: [stopAt(dir, 5, { evaluate: { $lineTotal: { result: '3.35', type: 'float' } } })] }],
    );
    expect(report.outcome).toBe('completed');
    expect(report.stops[0].evaluate?.['$missing']?.error?.code).toBe('DAP_ERROR');
    expect(report.stops[0].evaluate?.['$lineTotal']?.value).toBe('3.35');
  });

  it('redacts sensitive names and value-redacted scopes, and never evaluates a sensitive expression', async () => {
    const dir = workspace();
    const fake = new FakePhp();
    const { report } = await run(
      fake,
      dir,
      plan({
        probes: [
          {
            id: 'line-total',
            file: 'cart.php',
            line: 5,
            capture: { evaluate: ['$apiToken'], locals: { depth: 1, scopes: ['Locals', 'Superglobals'] } },
          },
        ],
      }),
      [
        {
          stops: [
            stopAt(dir, 5, {
              locals: [
                { name: '$password', value: "'hunter2'", type: 'string' },
                { name: '$qty', value: '3', type: 'int' },
                {
                  name: '$user',
                  value: 'App\\User',
                  type: 'object',
                  children: [{ name: 'passwordHash', value: "'x'", type: 'string' }],
                },
              ],
              superglobals: [{ name: '$_SERVER', value: 'array(40)', type: 'array' }],
            }),
          ],
        },
      ],
    );
    const locals = report.stops[0].locals!;
    expect(locals.Locals.variables['$password']).toMatchObject({ value: '[redacted]', redacted: true });
    expect(locals.Locals.variables['$qty'].value).toBe('3');
    expect(locals.Locals.variables['$user'].children?.passwordHash.value).toBe('[redacted]');
    expect(locals.Superglobals.variables['$_SERVER']).toMatchObject({ value: '[redacted]', type: 'array' });
    expect(report.stops[0].evaluate?.['$apiToken']).toMatchObject({ redacted: true });
    expect(fake.requests.some((r) => r.command === 'evaluate' && r.args.expression === '$apiToken')).toBe(false);
  });

  it('turns hypothesis predictions into verdicts', async () => {
    const dir = workspace();
    const fake = new FakePhp();
    const { report } = await run(
      fake,
      dir,
      plan({
        probes: [
          { id: 'line-total', file: 'cart.php', line: 5, tests: ['H1', 'H2'] },
          { id: 'echo', file: 'cart.php', line: 12, tests: ['H3'] },
        ],
        hypotheses: [
          {
            id: 'H1',
            basis: 'rounding',
            claim: 'rounds to 3.35',
            predicts: [{ probe: 'line-total', hit: 1, expr: '$lineTotal', equals: '3.35' }],
          },
          {
            id: 'H2',
            basis: 'rounding',
            claim: 'rounds to 3.34',
            predicts: [{ probe: 'line-total', hit: 1, expr: '$lineTotal', equals: '3.34' }],
          },
          {
            id: 'H3',
            basis: 'output',
            claim: 'echo shows 5.85',
            predicts: [{ probe: 'echo', expr: '$total', equals: '5.85' }],
          },
        ],
      }),
      [{ stops: [stopAt(dir, 5, { evaluate: { $lineTotal: { result: '3.35', type: 'float' } } })] }],
    );
    expect(report.predictions.map((p) => [p.hypothesis, p.verdict])).toEqual([
      ['H1', 'supported'],
      ['H2', 'refuted'],
      ['H3', 'untested'],
    ]);
  });

  it('retries a continue that did not take, then fails instead of spinning', async () => {
    const dir = workspace();
    const fake = new FakePhp();
    const { report } = await run(fake, dir, plan(), [{ stops: [stopAt(dir, 5)] }], {
      trigger: { neverSettle: true },
      wrap: (inner) => ({
        surface: inner.surface,
        tools: () => inner.tools(),
        invoke: async (name, args, ctx) =>
          name === 'debug_continue'
            ? { success: true, data: { resumed: false, state: 'paused' } }
            : inner.invoke(name, args, ctx),
      }),
    });
    expect(report.outcome).toBe('failed');
    expect(report.errors.map((e) => e.code)).toContain('NOT_RESUMED');
  });

  it('produces identical normalized reports across runs whose ids differ', async () => {
    const connections = (dir: string): FakeConnection[] => [
      {
        stops: [
          stopAt(dir, 5, {
            evaluate: { $lineTotal: { result: '3.35', type: 'float' } },
            callers: [{ file: join(dir, 'cart.php'), line: 10 }],
          }),
        ],
      },
    ];
    const dir = workspace();
    const planInput = plan({
      probes: [
        {
          id: 'line-total',
          file: 'cart.php',
          line: 5,
          capture: { stack: 2, evaluate: ['$lineTotal', { expr: 'microtime(true)', volatile: true }] },
        },
      ],
    });
    const first = await run(new FakePhp({ firstThreadId: 1 }), dir, planInput, connections(dir));
    const second = await run(new FakePhp({ firstThreadId: 9 }), dir, planInput, connections(dir));

    expect(first.report.stops[0].threadId).not.toBe(second.report.stops[0].threadId);
    const a = normalizeReport(first.report);
    const b = normalizeReport(second.report);
    expect(compareToGolden(b, a)).toEqual({ equal: true, planChanged: false, diffs: [] });
    const text = JSON.stringify(a);
    expect(text).toContain('${root}/cart.php');
    expect(text).not.toContain(dir);
    expect(text).not.toContain('microtime');
  });
});
