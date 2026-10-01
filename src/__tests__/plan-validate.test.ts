import { describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashPlan, looksExecutable, looksMutating, requiredTools, validatePlan } from '../plan/validate.js';
import { DebugPlanSchema, planJsonSchema } from '../plan/schema.js';

const PHP = `<?php
// cart
function total(array $items): float
{
    $sum = 0;
    foreach ($items as $item) {
        $sum += $item;
    }
    return $sum;
}
`;

function workspace(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'plan-validate-')));
  writeFileSync(join(dir, 'cart.php'), PHP);
  return dir;
}

function plan(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    name: 'cart',
    trigger: { kind: 'command', argv: ['php', 'cart.php'] },
    probes: [{ id: 'sum', file: 'cart.php', line: 7 }],
    ...overrides,
  };
}

const messages = (issues: Array<{ path: string; message: string }>) => issues.map((i) => `${i.path}: ${i.message}`);

describe('validatePlan', () => {
  it('resolves a valid plan: absolute paths, defaults, frozen source, stable hash', () => {
    const dir = workspace();
    const r = validatePlan(plan(), { baseDir: dir });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    const p = r.plan!;
    expect(p.probes[0].file).toBe(join(dir, 'cart.php'));
    expect(p.probes[0].maxCaptures).toBe(10);
    expect(p.probes[0].capture).toEqual({ stack: 1, evaluate: [], locals: false, exception: false });
    expect(p.limits.timeoutMs).toBe(120_000);
    expect(p.trigger).toMatchObject({ kind: 'command', cwd: dir, xdebugEnv: true });
    expect(Object.isFrozen(p.source)).toBe(true);
    expect(r.planHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes independently of key order', () => {
    const a = DebugPlanSchema.parse(plan());
    const b = DebugPlanSchema.parse(JSON.parse(JSON.stringify({ probes: a.probes, trigger: a.trigger, name: a.name, version: 1 })));
    expect(hashPlan(a)).toBe(hashPlan(b));
  });

  it('follows symlinks so probes match the path PHP reports', () => {
    const dir = workspace();
    symlinkSync(join(dir, 'cart.php'), join(dir, 'link.php'));
    const r = validatePlan(plan({ probes: [{ id: 'sum', file: 'link.php', line: 7 }] }), { baseDir: dir });
    expect(r.plan!.probes[0].file).toBe(join(dir, 'cart.php'));
  });

  it('explains why "program" is not accepted', () => {
    const r = validatePlan(plan({ session: { program: 'cart.php' } }), { baseDir: workspace() });
    expect(r.ok).toBe(false);
    expect(r.errors[0].path).toBe('session.program');
    expect(r.errors[0].message).toContain('trigger');
  });

  it('reports schema errors with a path', () => {
    const r = validatePlan(plan({ probes: [{ id: 'sum', file: 'cart.php', line: 0 }] }), { baseDir: workspace() });
    expect(r.ok).toBe(false);
    expect(r.errors[0].path).toBe('probes[0].line');
  });

  it('rejects missing files, lines past the end, duplicates and dangling references', () => {
    const r = validatePlan(
      plan({
        probes: [
          { id: 'sum', file: 'cart.php', line: 7, tests: ['H9'] },
          { id: 'sum', file: 'cart.php', line: 99 },
          { id: 'again', file: 'cart.php', line: 7 },
          { id: 'gone', file: 'missing.php', line: 1 },
        ],
        expect: [{ probe: 'nope', hits: 1 }, { sequence: ['sum', 'ghost'] }, { probe: 'sum', expr: '$sum' }],
      }),
      { baseDir: workspace() },
    );
    const text = messages(r.errors).join('\n');
    expect(text).toContain('probes[0].tests[0]: Unknown hypothesis "H9"');
    expect(text).toContain('probes[1].id: Probe id "sum" is already used');
    expect(text).toContain('probes[1].line: Line 99 is past the end');
    expect(text).toContain('probes[2].line: cart.php:7 is already probed');
    expect(text).toContain('probes[3].file: File not found');
    expect(text).toContain('expect[0].probe: Unknown probe "nope"');
    expect(text).toContain('expect[1].sequence[1]: Unknown probe "ghost"');
    expect(text).toContain('expect[2]: A value expectation needs "equals", "matches" or "type"');
  });

  it('requires something to stop on', () => {
    const r = validatePlan(plan({ probes: [] }), { baseDir: workspace() });
    expect(messages(r.errors)).toContain('probes: The plan has nothing to stop on: add probes, functions or exceptions.');
  });

  it('warns about lines that verify but never hit, mutating captures, and untested hypotheses', () => {
    const r = validatePlan(
      plan({
        probes: [
          { id: 'brace', file: 'cart.php', line: 4, capture: { evaluate: ['$sum = 0', '$sum == 0', "strpos($s, '=')"] } },
          { id: 'comment', file: 'cart.php', line: 2 },
        ],
        hypotheses: [{ id: 'H1', basis: 'b', claim: 'c' }],
      }),
      { baseDir: workspace() },
    );
    expect(r.ok).toBe(true);
    const text = messages(r.warnings).join('\n');
    expect(text).toContain('probes[0].line: Line 4 of cart.php ("{") does not look executable');
    expect(text).toContain('probes[1].line: Line 2 of cart.php ("// cart")');
    expect(text).toContain('probes[0].capture.evaluate[0]: "$sum = 0" looks like it changes program state');
    expect(text).not.toContain('evaluate[1]');
    expect(text).not.toContain('evaluate[2]');
    expect(text).toContain('hypotheses[0]: Hypothesis "H1" has no prediction and no probe that tests it');
  });

  it('captures every expression an assertion reads', () => {
    const r = validatePlan(
      plan({
        expect: [{ probe: 'sum', hit: 1, expr: '$sum', equals: '0' }],
        hypotheses: [{ id: 'H1', basis: 'b', claim: 'c', predicts: [{ probe: 'sum', expr: '$item', type: 'int' }] }],
      }),
      { baseDir: workspace() },
    );
    expect(r.plan!.probes[0].capture.evaluate.map((e) => e.expr)).toEqual(['$sum', '$item']);
  });

  it('rejects asserting a hit beyond maxCaptures', () => {
    const r = validatePlan(
      plan({
        probes: [{ id: 'sum', file: 'cart.php', line: 7, maxCaptures: 2 }],
        expect: [{ probe: 'sum', hit: 3, expr: '$sum', equals: '1' }],
      }),
      { baseDir: workspace() },
    );
    expect(messages(r.errors)).toContain('expect[0].hit: Hit 3 is never captured: probe "sum" captures at most 2 hits.');
  });

  it('interpolates ${env:…} and ${root}, and reports unset variables', () => {
    const dir = workspace();
    const ok = validatePlan(
      plan({ trigger: { kind: 'http', url: '${env:APP_URL}/cart?root=${root}', headers: { 'X-Token': '${env:TOKEN}' } } }),
      { baseDir: dir, env: { APP_URL: 'http://localhost:8080', TOKEN: 't' } },
    );
    expect(ok.plan!.trigger).toMatchObject({ kind: 'http', url: `http://localhost:8080/cart?root=${dir}`, headers: { 'X-Token': 't' } });

    const missing = validatePlan(plan({ trigger: { kind: 'http', url: '${env:NOPE}/x' } }), { baseDir: dir, env: {} });
    expect(messages(missing.errors)).toContain('trigger.url: Environment variable "NOPE" is not set');
  });

  it('gates command triggers and flags per-run session fields on a running MCP server', () => {
    const dir = workspace();
    const gated = validatePlan(plan(), { baseDir: dir, allowCommandTrigger: false, surface: 'mcp' });
    expect(gated.errors[0].message).toContain('--allow-command-trigger');

    const mcp = validatePlan(plan({ session: { pathMappings: { '/var/www': '.' } } }), { baseDir: dir, surface: 'mcp' });
    expect(mcp.ok).toBe(true);
    expect(messages(mcp.warnings).join('\n')).toContain('session.pathMappings: Ignored by a running MCP server');
  });

  it('checks the plan against the tools the surface provides', () => {
    const dir = workspace();
    const r = validatePlan(plan({ functions: [{ id: 'f', name: 'total' }] }), {
      baseDir: dir,
      availableTools: new Set(['debug_status', 'debug_launch', 'debug_wait', 'debug_stack_trace', 'debug_continue', 'debug_terminate', 'debug_set_breakpoints']),
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toContain('debug_set_function_breakpoints');
  });

  it('lists exactly the tools a run needs', () => {
    const r = validatePlan(
      plan({
        probes: [{ id: 'sum', file: 'cart.php', line: 7, capture: { evaluate: ['$sum'], locals: { depth: 0 } } }],
        exceptions: { filters: ['Exception'] },
      }),
      { baseDir: workspace() },
    );
    expect(requiredTools(r.plan!).sort()).toEqual(
      [
        'debug_continue',
        'debug_evaluate',
        'debug_exception_info',
        'debug_launch',
        'debug_scopes',
        'debug_set_breakpoints',
        'debug_set_exception_breakpoints',
        'debug_stack_trace',
        'debug_status',
        'debug_terminate',
        'debug_variables',
        'debug_wait',
      ].sort(),
    );
  });

  it('warns that a manual trigger is not reproducible', () => {
    const r = validatePlan(plan({ trigger: { kind: 'manual', instructions: 'open /cart' } }), { baseDir: workspace() });
    expect(r.ok).toBe(true);
    expect(r.warnings[0].message).toContain('cannot be reproduced');
  });
});

describe('heuristics', () => {
  it.each([
    ['    $sum = 0;', true],
    ['return $sum;', true],
    ['', false],
    ['    }', false],
    ['{', false],
    ['// comment', false],
    ['# comment', false],
    ['#[Route("/cart")]', false],
    [' * docblock', false],
    ['<?php', false],
  ])('looksExecutable(%j) = %s', (line, expected) => {
    expect(looksExecutable(line)).toBe(expected);
  });

  it.each([
    ['$a = 1', true],
    ['$a += 1', true],
    ['$a .= "x"', true],
    ['$a ??= 1', true],
    ['$i++', true],
    ['--$i', true],
    ['$a == 1', false],
    ['$a === 1', false],
    ['$a != 1', false],
    ['$a !== null', false],
    ['$a <= 1', false],
    ['$a >= 1', false],
    ['$a <=> $b', false],
    ["['k' => 1]", false],
    ["strpos($s, '=')", false],
    ['fn($x) => $x * 2', false],
  ])('looksMutating(%j) = %s', (expr, expected) => {
    expect(looksMutating(expr)).toBe(expected);
  });
});

describe('plan JSON Schema', () => {
  it('is generated from the Zod schema and names every top-level field', () => {
    const schema = planJsonSchema() as { properties?: Record<string, unknown>; required?: string[] };
    expect(Object.keys(schema.properties ?? {})).toEqual(
      expect.arrayContaining(['version', 'name', 'trigger', 'probes', 'exceptions', 'functions', 'limits', 'expect', 'hypotheses']),
    );
    expect(schema.required).toEqual(expect.arrayContaining(['version', 'name', 'trigger']));
  });
});
