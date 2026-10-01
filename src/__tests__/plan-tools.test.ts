import { describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakePhp, type FakeConnection } from './helpers/fake-php.js';
import { handleDebugPlanValidate } from '../tools/debug-plan-validate.js';
import { handleDebugPlanRun, type PlanRunContext } from '../tools/debug-plan-run.js';
import { handleDebugPlanReport } from '../tools/debug-plan-report.js';
import { InProcessInvoker } from '../plan/invoker.js';
import { RunStore } from '../plan/store.js';
import { coreToolDefinitions } from '../tools/registry.js';

const PHP = `<?php
function lineTotal($price, $qty) {
    $lineTotal = round($price * $qty, 2);
    return $lineTotal;
}
`;

function workspace(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'plan-tools-')));
  writeFileSync(join(dir, 'cart.php'), PHP);
  return dir;
}

function planFor(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    name: 'cart',
    trigger: { kind: 'command', argv: ['php', 'cart.php'] },
    probes: [{ id: 'line-total', file: 'cart.php', line: 4, capture: { evaluate: ['$lineTotal'] } }],
    limits: { idleMs: 20, waitMs: 200, connectTimeoutMs: 400, timeoutMs: 5000 },
    expect: [{ probe: 'line-total', hits: 2 }],
    ...overrides,
  };
}

function context(dir: string, fake: FakePhp, connections: FakeConnection[], store = new RunStore()): PlanRunContext {
  const session = fake.session();
  return {
    baseDir: dir,
    surface: 'mcp',
    allowCommandTrigger: true,
    invoker: new InProcessInvoker(session, coreToolDefinitions({ launchDeps: { isPortBound: async () => false } })),
    store,
    startTrigger: fake.trigger(connections),
  };
}

const twoHits = (dir: string): FakeConnection[] => [
  {
    stops: [
      { file: join(dir, 'cart.php'), line: 4, evaluate: { $lineTotal: { result: '3.35', type: 'float' } } },
      { file: join(dir, 'cart.php'), line: 4, evaluate: { $lineTotal: { result: '2.5', type: 'float' } } },
    ],
  },
];

describe('debug_plan_validate', () => {
  it('validates an inline plan and a plan file', () => {
    const dir = workspace();
    writeFileSync(join(dir, 'cart.debugplan.json'), JSON.stringify(planFor()));
    const ctx = { baseDir: dir, surface: 'mcp' as const, allowCommandTrigger: true };

    const inline = handleDebugPlanValidate({ plan: planFor() }, ctx);
    const file = handleDebugPlanValidate({ path: 'cart.debugplan.json' }, ctx);
    expect(inline.data).toMatchObject({ ok: true, errors: [] });
    expect((file.data as { planHash: string }).planHash).toBe((inline.data as { planHash: string }).planHash);
  });

  it('refuses both or neither input', () => {
    const ctx = { baseDir: '/', surface: 'mcp' as const, allowCommandTrigger: true };
    expect(handleDebugPlanValidate({ plan: {}, path: 'x' }, ctx).error?.code).toBe('INVALID_PARAMS');
    expect(handleDebugPlanValidate({}, ctx).error?.code).toBe('INVALID_PARAMS');
  });

  it('reports command triggers as disabled when the server has not allowed them', () => {
    const r = handleDebugPlanValidate(
      { plan: planFor() },
      { baseDir: workspace(), surface: 'mcp', allowCommandTrigger: false },
    );
    expect(r.data).toMatchObject({ ok: false });
    expect(JSON.stringify(r.data)).toContain('--allow-command-trigger');
  });
});

describe('debug_plan_run', () => {
  it('runs the plan, returns a summary, and stores the run for debug_plan_report', async () => {
    const dir = workspace();
    const fake = new FakePhp();
    const store = new RunStore(join(dir, 'runs'));
    const progress: string[] = [];
    const r = await handleDebugPlanRun(
      { plan: planFor() as never },
      { ...context(dir, fake, twoHits(dir), store), reportProgress: (m) => progress.push(m) },
    );

    expect(r.success).toBe(true);
    const d = r.data as {
      runId: string;
      outcome: string;
      probes: Record<string, { hits: number }>;
      stops: Array<{ values: Record<string, string> }>;
      expectations: { passed: number; failed: number };
      artifacts: string;
    };
    expect(d.outcome).toBe('completed');
    expect(d.probes['line-total'].hits).toBe(2);
    expect(d.stops[0].values['$lineTotal']).toBe('3.35 (float)');
    expect(d.expectations).toEqual({ passed: 1, failed: 0 });
    expect(existsSync(join(d.artifacts, 'report.json'))).toBe(true);
    expect(existsSync(join(d.artifacts, 'journal.jsonl'))).toBe(true);
    expect(progress.some((m) => m.startsWith('[execute] stop 1'))).toBe(true);

    const detail = handleDebugPlanReport({ runId: d.runId, stop: 2 }, { store });
    expect(
      (detail.data as { stop: { evaluate: Record<string, { value: string }> } }).stop.evaluate.$lineTotal.value,
    ).toBe('2.5');

    const journal = handleDebugPlanReport({ section: 'journal', limit: 3 }, { store });
    const page = journal.data as { items: Array<{ tool: string }>; total: number; nextOffset?: number };
    expect(page.items.map((e) => e.tool)).toEqual(['debug_status', 'debug_launch', 'debug_set_breakpoints']);
    expect(page.nextOffset).toBe(3);

    // A fresh store over the same directory still finds the run.
    const reopened = handleDebugPlanReport(
      { runId: d.runId, probe: 'line-total' },
      { store: new RunStore(join(dir, 'runs')) },
    );
    expect((reopened.data as { total: number }).total).toBe(2);
  });

  it('runs nothing for an invalid plan', async () => {
    const dir = workspace();
    const fake = new FakePhp();
    const r = await handleDebugPlanRun(
      { plan: planFor({ probes: [{ id: 'x', file: 'missing.php', line: 1 }] }) as never },
      context(dir, fake, []),
    );
    expect(r.error?.code).toBe('PLAN_INVALID');
    expect(r.error?.message).toContain('File not found');
    expect(fake.requests).toEqual([]);
  });

  it('refuses to take over a live session', async () => {
    const dir = workspace();
    const fake = new FakePhp();
    const ctx = context(dir, fake, twoHits(dir));
    await ctx.invoker.invoke('debug_launch', {});
    const r = await handleDebugPlanRun({ plan: planFor() as never }, ctx);
    expect(r.error?.code).toBe('SESSION_BUSY');
  });
});

describe('debug_plan_report', () => {
  it('explains when there is nothing to read', () => {
    expect(handleDebugPlanReport({}, { store: new RunStore() }).error?.code).toBe('RUN_NOT_FOUND');
    expect(handleDebugPlanReport({ runId: 'nope' }, { store: new RunStore() }).error?.message).toContain(
      'No run "nope"',
    );
  });
});
