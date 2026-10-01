import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { z } from 'zod';
import {
  DebugPlanSchema,
  type CaptureSpec,
  type DebugPlan,
  type EvaluateItem,
  type Expectation,
  type Hypothesis,
  type Limits,
  type PlanSession,
  type Prediction,
} from './schema.js';

/** One problem found in a plan, located by a JSON-path-like string ("probes[0].line"). */
export interface PlanIssue {
  path: string;
  message: string;
}

export interface ResolvedEvaluate {
  expr: string;
  frame: number;
  volatile: boolean;
}

export interface ResolvedCapture {
  stack: number;
  evaluate: ResolvedEvaluate[];
  locals: false | { depth: number; maxItems: number; scopes: string[] };
  exception: boolean;
}

interface ResolvedProbeBase {
  id: string;
  tests: string[];
  capture: ResolvedCapture;
  maxCaptures: number;
}

export interface ResolvedLineProbe extends ResolvedProbeBase {
  kind: 'line';
  /** Absolute, symlink-free local path — what is sent to debug_set_breakpoints and matched against frames. */
  file: string;
  line: number;
  condition?: string;
  hitCondition?: string;
}

export interface ResolvedFunctionProbe extends ResolvedProbeBase {
  kind: 'function';
  name: string;
  condition?: string;
  hitCondition?: string;
}

export interface ResolvedExceptionProbe extends ResolvedProbeBase {
  kind: 'exception';
  filters: string[];
}

export type ResolvedProbe = ResolvedLineProbe | ResolvedFunctionProbe | ResolvedExceptionProbe;

export type ResolvedTrigger =
  | { kind: 'command'; argv: string[]; cwd: string; env: Record<string, string>; xdebugEnv: boolean }
  | {
      kind: 'http';
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
      xdebugCookie: boolean;
    }
  | { kind: 'manual'; instructions?: string };

/** A plan after validation: defaults applied, paths absolute, `${…}` interpolated. */
export interface ResolvedPlan {
  /** The plan exactly as written (deep-frozen). */
  source: Readonly<DebugPlan>;
  /** sha256 of the canonical JSON of `source`. */
  hash: string;
  name: string;
  goal?: string;
  root: string;
  session: PlanSession;
  trigger: ResolvedTrigger;
  probes: ResolvedLineProbe[];
  functions: ResolvedFunctionProbe[];
  exceptions?: ResolvedExceptionProbe;
  limits: Required<Limits>;
  onUnmatchedStop: 'record' | 'ignore' | 'abort';
  redact: { names: string[]; scopes: string[] };
  expect: Expectation[];
  hypotheses: Hypothesis[];
}

export interface ValidationResult {
  ok: boolean;
  errors: PlanIssue[];
  warnings: PlanIssue[];
  /** Present when `ok`. */
  plan?: ResolvedPlan;
  /** Present whenever the plan parsed, even with semantic errors. */
  planHash?: string;
}

export type PlanSurface = 'in-process' | 'mcp' | 'extension';

export interface ValidateOptions {
  /** Base for a relative `root` (default: the working directory). Pass the plan file's directory. */
  baseDir?: string;
  /** Source of `${env:NAME}` values (default: process.env). */
  env?: Record<string, string | undefined>;
  /** Tools the executing surface provides; omit to skip the check. */
  availableTools?: ReadonlySet<string>;
  /** Where the plan will run; only changes which fields are warned about. */
  surface?: PlanSurface;
  /** Whether `trigger.kind: "command"` may run (default true). The MCP server gates this behind a flag. */
  allowCommandTrigger?: boolean;
  /** Check that probe files exist and lines are in range (default true). */
  checkFiles?: boolean;
}

export const PLAN_DEFAULTS = {
  limits: {
    timeoutMs: 120_000,
    waitMs: 10_000,
    connectTimeoutMs: 30_000,
    idleMs: 1_500,
    maxStops: 200,
    evaluateTimeoutMs: 5_000,
  } satisfies Required<Limits>,
  stack: 1,
  maxCaptures: 10,
  localsDepth: 1,
  localsMaxItems: 40,
  localsScopes: ['Locals'],
  exceptionProbeId: 'exception',
  // Fragments that signal a secret without catching everyday names: "auth"
  // alone would redact every $author in a CMS.
  redactNames: [
    'password',
    'passwd',
    'pwd',
    'secret',
    'token',
    'apikey',
    'api_key',
    'app_key',
    'private_key',
    'authorization',
    'auth_pw',
    'cookie',
    'credential',
  ],
  redactScopes: ['Superglobals'],
} as const;

/** Session fields that only take effect where the session is built per run. */
const PER_RUN_SESSION_FIELDS = ['hostname', 'pathMappings', 'backendMode'] as const;

/** Read a plan file. Throws with a readable message on I/O or JSON errors. */
export function loadPlanFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new Error(`Cannot read plan file "${path}": ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Plan file "${path}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** JSON with object keys sorted at every level, so equal values serialize identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function hashPlan(plan: DebugPlan): string {
  return createHash('sha256').update(canonicalJson(plan)).digest('hex');
}

/**
 * Validate a plan and resolve it for execution.
 *
 * Runs before any debug session exists, so a plan that cannot work is rejected
 * without touching the adapter. Errors block the run; warnings are carried into
 * the run report.
 */
export function validatePlan(input: unknown, opts: ValidateOptions = {}): ValidationResult {
  const errors: PlanIssue[] = [];
  const warnings: PlanIssue[] = [];

  // A friendlier message than Zod's "unrecognized key" for the one field
  // people reach for first.
  const rawSession = (input as { session?: Record<string, unknown> } | undefined)?.session;
  if (rawSession && typeof rawSession === 'object' && 'program' in rawSession) {
    errors.push({
      path: 'session.program',
      message:
        'Plans do not use the adapter\'s "program" mode: it starts PHP before breakpoints can be set. ' +
        'Run the script with a trigger instead: { "kind": "command", "argv": ["php", "script.php"] }.',
    });
    return { ok: false, errors, warnings };
  }

  const parsed = DebugPlanSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: zodIssues(parsed.error), warnings };
  }
  const plan = parsed.data;
  const planHash = hashPlan(plan);

  const env = opts.env ?? process.env;
  const baseDir = opts.baseDir ?? process.cwd();
  const checkFiles = opts.checkFiles ?? true;

  // `${root}` inside `root` itself would be circular; only env applies there.
  const rootInterpolated = interpolate(plan.root ?? '.', env, baseDir, (name) =>
    errors.push({ path: 'root', message: `Environment variable "${name}" is not set` }),
  );
  const rootDir = resolve(baseDir, rootInterpolated);

  const interp = (value: string, path: string): string =>
    interpolate(value, env, rootDir, (name) =>
      errors.push({ path, message: `Environment variable "${name}" is not set` }),
    );

  // ── ids ────────────────────────────────────────────────────────────────────
  const probeIds = new Map<string, string>();
  const claimId = (id: string, path: string) => {
    const prior = probeIds.get(id);
    if (prior) errors.push({ path, message: `Probe id "${id}" is already used at ${prior}` });
    else probeIds.set(id, path);
  };
  (plan.probes ?? []).forEach((p, i) => claimId(p.id, `probes[${i}].id`));
  (plan.functions ?? []).forEach((f, i) => claimId(f.id, `functions[${i}].id`));
  if (plan.exceptions) claimId(plan.exceptions.id ?? PLAN_DEFAULTS.exceptionProbeId, 'exceptions.id');

  if (probeIds.size === 0) {
    errors.push({ path: 'probes', message: 'The plan has nothing to stop on: add probes, functions or exceptions.' });
  }

  const hypothesisIds = new Set<string>();
  (plan.hypotheses ?? []).forEach((h, i) => {
    if (hypothesisIds.has(h.id)) errors.push({ path: `hypotheses[${i}].id`, message: `Duplicate hypothesis id "${h.id}"` });
    hypothesisIds.add(h.id);
  });

  // ── line probes ────────────────────────────────────────────────────────────
  const fileCache = new Map<string, string[] | null>();
  const seenLocations = new Map<string, string>();
  const probes: ResolvedLineProbe[] = (plan.probes ?? []).map((p, i) => {
    const path = `probes[${i}]`;
    const declared = isAbsolute(p.file) ? p.file : resolve(rootDir, p.file);
    const file = realpathOr(declared);

    if (checkFiles) {
      const lines = readLines(file, fileCache);
      if (lines === null) {
        errors.push({ path: `${path}.file`, message: `File not found: ${declared}` });
      } else if (p.line > lines.length) {
        errors.push({ path: `${path}.line`, message: `Line ${p.line} is past the end of ${p.file} (${lines.length} lines)` });
      } else if (!looksExecutable(lines[p.line - 1])) {
        warnings.push({
          path: `${path}.line`,
          message:
            `Line ${p.line} of ${p.file} ("${lines[p.line - 1].trim().slice(0, 60)}") does not look executable — ` +
            'a breakpoint there is accepted and then never hits. Pick the first statement of the block.',
        });
      }
    }

    const location = `${file}:${p.line}`;
    const prior = seenLocations.get(location);
    if (prior) errors.push({ path: `${path}.line`, message: `${p.file}:${p.line} is already probed by ${prior}` });
    else seenLocations.set(location, path);

    checkTests(p.tests, path, hypothesisIds, errors);
    return {
      kind: 'line' as const,
      id: p.id,
      file,
      line: p.line,
      ...(p.condition !== undefined ? { condition: p.condition } : {}),
      ...(p.hitCondition !== undefined ? { hitCondition: p.hitCondition } : {}),
      tests: p.tests ?? [],
      capture: resolveCapture(p.capture, `${path}.capture`, warnings),
      maxCaptures: p.maxCaptures ?? PLAN_DEFAULTS.maxCaptures,
    };
  });

  const functions: ResolvedFunctionProbe[] = (plan.functions ?? []).map((f, i) => {
    checkTests(f.tests, `functions[${i}]`, hypothesisIds, errors);
    return {
      kind: 'function' as const,
      id: f.id,
      name: f.name,
      ...(f.condition !== undefined ? { condition: f.condition } : {}),
      ...(f.hitCondition !== undefined ? { hitCondition: f.hitCondition } : {}),
      tests: f.tests ?? [],
      capture: resolveCapture(f.capture, `functions[${i}].capture`, warnings),
      maxCaptures: f.maxCaptures ?? PLAN_DEFAULTS.maxCaptures,
    };
  });

  let exceptions: ResolvedExceptionProbe | undefined;
  if (plan.exceptions) {
    checkTests(plan.exceptions.tests, 'exceptions', hypothesisIds, errors);
    const capture = resolveCapture(plan.exceptions.capture, 'exceptions.capture', warnings);
    exceptions = {
      kind: 'exception',
      id: plan.exceptions.id ?? PLAN_DEFAULTS.exceptionProbeId,
      filters: plan.exceptions.filters,
      tests: plan.exceptions.tests ?? [],
      capture: { ...capture, exception: true },
      maxCaptures: plan.exceptions.maxCaptures ?? PLAN_DEFAULTS.maxCaptures,
    };
  }

  const allProbes = new Map<string, ResolvedProbe>();
  for (const p of [...probes, ...functions, ...(exceptions ? [exceptions] : [])]) allProbes.set(p.id, p);

  // ── expectations and predictions ──────────────────────────────────────────
  const expect = plan.expect ?? [];
  expect.forEach((e, i) => checkExpectation(e, `expect[${i}]`, allProbes, errors, warnings));
  const hypotheses = plan.hypotheses ?? [];
  hypotheses.forEach((h, hi) => {
    (h.predicts ?? []).forEach((p, pi) =>
      checkExpectation(p, `hypotheses[${hi}].predicts[${pi}]`, allProbes, errors, warnings),
    );
    const tested =
      (h.predicts?.length ?? 0) > 0 || [...allProbes.values()].some((p) => p.tests.includes(h.id));
    if (!tested) {
      warnings.push({
        path: `hypotheses[${hi}]`,
        message: `Hypothesis "${h.id}" has no prediction and no probe that tests it, so this run cannot confirm or refute it.`,
      });
    }
  });

  // ── trigger ────────────────────────────────────────────────────────────────
  const trigger = resolveTrigger(plan, rootDir, interp, opts, errors, warnings);

  // ── session ────────────────────────────────────────────────────────────────
  const session: PlanSession = {
    ...plan.session,
    ...(plan.session?.hostname !== undefined ? { hostname: interp(plan.session.hostname, 'session.hostname') } : {}),
    ...(plan.session?.pathMappings !== undefined
      ? {
          pathMappings: Object.fromEntries(
            Object.entries(plan.session.pathMappings).map(([remote, local]) => [
              interp(remote, 'session.pathMappings'),
              resolve(rootDir, interp(local, 'session.pathMappings')),
            ]),
          ),
        }
      : {}),
  };
  if (opts.surface === 'mcp') {
    for (const field of PER_RUN_SESSION_FIELDS) {
      if (plan.session?.[field] !== undefined) {
        warnings.push({
          path: `session.${field}`,
          message: `Ignored by a running MCP server, which fixed its ${field} at startup. Put it in the server config instead.`,
        });
      }
    }
  }

  const resolved: ResolvedPlan = {
    source: deepFreeze(structuredClone(plan)),
    hash: planHash,
    name: plan.name,
    ...(plan.goal !== undefined ? { goal: plan.goal } : {}),
    root: rootDir,
    session,
    trigger,
    probes,
    functions,
    ...(exceptions ? { exceptions } : {}),
    limits: { ...PLAN_DEFAULTS.limits, ...plan.limits },
    onUnmatchedStop: plan.onUnmatchedStop ?? 'record',
    redact: {
      names: plan.redact?.names ?? [...PLAN_DEFAULTS.redactNames],
      scopes: plan.redact?.scopes ?? [...PLAN_DEFAULTS.redactScopes],
    },
    expect,
    hypotheses,
  };

  // Expressions an assertion reads must be captured, or the assertion can
  // never pass. Adding them here keeps the plan author from repeating each one.
  const assertions: Array<Expectation | Prediction> = [...expect, ...hypotheses.flatMap((h) => h.predicts ?? [])];
  for (const a of assertions) {
    if (!('expr' in a)) continue;
    const probe = allProbes.get(a.probe);
    if (probe && !probe.capture.evaluate.some((e) => e.expr === a.expr && e.frame === 0)) {
      probe.capture.evaluate.push({ expr: a.expr, frame: 0, volatile: false });
    }
  }

  // ── surface ────────────────────────────────────────────────────────────────
  if (opts.availableTools) {
    const missing = requiredTools(resolved).filter((t) => !opts.availableTools!.has(t));
    if (missing.length > 0) {
      errors.push({
        path: '',
        message: `This surface does not provide ${missing.join(', ')}, which the plan needs.`,
      });
    }
  }

  const ok = errors.length === 0;
  return { ok, errors, warnings, planHash, ...(ok ? { plan: resolved } : {}) };
}

/** Every tool a run of this plan will call. */
export function requiredTools(plan: ResolvedPlan): string[] {
  const tools = new Set([
    'debug_status',
    'debug_launch',
    'debug_wait',
    'debug_stack_trace',
    'debug_continue',
    'debug_terminate',
  ]);
  if (plan.probes.length > 0) tools.add('debug_set_breakpoints');
  if (plan.functions.length > 0) tools.add('debug_set_function_breakpoints');
  if (plan.exceptions) {
    tools.add('debug_set_exception_breakpoints');
    tools.add('debug_exception_info');
  }
  const all: ResolvedProbe[] = [...plan.probes, ...plan.functions, ...(plan.exceptions ? [plan.exceptions] : [])];
  for (const p of all) {
    if (p.capture.evaluate.length > 0) tools.add('debug_evaluate');
    if (p.capture.locals) {
      tools.add('debug_scopes');
      tools.add('debug_variables');
    }
    if (p.capture.exception) tools.add('debug_exception_info');
  }
  return [...tools];
}

function resolveCapture(spec: CaptureSpec | undefined, path: string, warnings: PlanIssue[]): ResolvedCapture {
  const evaluate = (spec?.evaluate ?? []).map((item: EvaluateItem, i) => {
    const e: ResolvedEvaluate =
      typeof item === 'string'
        ? { expr: item, frame: 0, volatile: false }
        : { expr: item.expr, frame: item.frame ?? 0, volatile: item.volatile ?? false };
    if (looksMutating(e.expr)) {
      warnings.push({
        path: `${path}.evaluate[${i}]`,
        message: `"${e.expr}" looks like it changes program state. Captures run inside the live request; keep them side-effect free.`,
      });
    }
    return e;
  });
  const locals = spec?.locals
    ? {
        depth: spec.locals.depth ?? PLAN_DEFAULTS.localsDepth,
        maxItems: spec.locals.maxItems ?? PLAN_DEFAULTS.localsMaxItems,
        scopes: spec.locals.scopes ?? [...PLAN_DEFAULTS.localsScopes],
      }
    : (false as const);
  return {
    stack: spec?.stack ?? PLAN_DEFAULTS.stack,
    evaluate,
    locals,
    exception: spec?.exception ?? false,
  };
}

function resolveTrigger(
  plan: DebugPlan,
  rootDir: string,
  interp: (value: string, path: string) => string,
  opts: ValidateOptions,
  errors: PlanIssue[],
  warnings: PlanIssue[],
): ResolvedTrigger {
  const t = plan.trigger;
  switch (t.kind) {
    case 'command': {
      if (opts.allowCommandTrigger === false) {
        errors.push({
          path: 'trigger',
          message:
            'Command triggers are disabled on this server. Start it with --allow-command-trigger, ' +
            'or use an http trigger.',
        });
      }
      return {
        kind: 'command',
        argv: t.argv.map((a, i) => interp(a, `trigger.argv[${i}]`)),
        cwd: resolve(rootDir, interp(t.cwd ?? '.', 'trigger.cwd')),
        env: Object.fromEntries(Object.entries(t.env ?? {}).map(([k, v]) => [k, interp(v, `trigger.env.${k}`)])),
        xdebugEnv: t.xdebugEnv ?? true,
      };
    }
    case 'http': {
      const url = interp(t.url, 'trigger.url');
      try {
        new URL(url);
      } catch {
        errors.push({ path: 'trigger.url', message: `Not a valid URL: ${url}` });
      }
      return {
        kind: 'http',
        url,
        method: (t.method ?? 'GET').toUpperCase(),
        headers: Object.fromEntries(
          Object.entries(t.headers ?? {}).map(([k, v]) => [k, interp(v, `trigger.headers.${k}`)]),
        ),
        ...(t.body !== undefined ? { body: interp(t.body, 'trigger.body') } : {}),
        xdebugCookie: t.xdebugCookie ?? true,
      };
    }
    case 'manual':
      warnings.push({
        path: 'trigger',
        message: 'A manual trigger depends on a person, so this run cannot be reproduced or used as a regression test.',
      });
      return { kind: 'manual', ...(t.instructions !== undefined ? { instructions: t.instructions } : {}) };
  }
}

function checkTests(tests: string[] | undefined, path: string, hypothesisIds: Set<string>, errors: PlanIssue[]) {
  (tests ?? []).forEach((id, i) => {
    if (!hypothesisIds.has(id)) errors.push({ path: `${path}.tests[${i}]`, message: `Unknown hypothesis "${id}"` });
  });
}

function checkExpectation(
  e: Expectation | Prediction,
  path: string,
  probes: Map<string, ResolvedProbe>,
  errors: PlanIssue[],
  warnings: PlanIssue[],
): void {
  if ('probe' in e) {
    const probe = probes.get(e.probe);
    if (!probe) {
      errors.push({ path: `${path}.probe`, message: `Unknown probe "${e.probe}"` });
      return;
    }
    if ('expr' in e) {
      if (e.equals === undefined && e.matches === undefined && e.type === undefined) {
        errors.push({ path, message: 'A value expectation needs "equals", "matches" or "type"' });
      }
      if (e.matches !== undefined) {
        try {
          new RegExp(e.matches);
        } catch (err) {
          errors.push({ path: `${path}.matches`, message: `Invalid regular expression: ${(err as Error).message}` });
        }
      }
      if (probe.maxCaptures === 0) {
        warnings.push({ path, message: `Probe "${e.probe}" has maxCaptures 0, so no value is ever captured to check.` });
      } else if (e.hit !== undefined && e.hit > probe.maxCaptures) {
        errors.push({
          path: `${path}.hit`,
          message: `Hit ${e.hit} is never captured: probe "${e.probe}" captures at most ${probe.maxCaptures} hits.`,
        });
      }
    }
  } else if ('sequence' in e) {
    e.sequence.forEach((id, i) => {
      if (!probes.has(id)) errors.push({ path: `${path}.sequence[${i}]`, message: `Unknown probe "${id}"` });
    });
  }
}

/** Replace `${env:NAME}` and `${root}`; report each missing variable once per call. */
function interpolate(
  value: string,
  env: Record<string, string | undefined>,
  root: string,
  onMissing: (name: string) => void,
): string {
  return value.replace(/\$\{(env:([A-Za-z_][A-Za-z0-9_]*)|root)\}/g, (_m, _whole, envName: string | undefined) => {
    if (envName === undefined) return root;
    const v = env[envName];
    if (v === undefined) {
      onMissing(envName);
      return '';
    }
    return v;
  });
}

function realpathOr(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function readLines(file: string, cache: Map<string, string[] | null>): string[] | null {
  if (!cache.has(file)) {
    try {
      cache.set(file, readFileSync(file, 'utf-8').split(/\r?\n/));
    } catch {
      cache.set(file, null);
    }
  }
  return cache.get(file)!;
}

/**
 * A cheap guess at "Xdebug can stop here". Only used for warnings: it knows
 * nothing about multi-line statements, so it flags the obvious traps (blank
 * lines, comments, lone braces, open/close tags) and nothing else.
 */
export function looksExecutable(line: string): boolean {
  const t = line.trim();
  if (t === '') return false;
  // Comments, docblock lines, and #[Attribute] lines.
  if (/^(\/\/|#|\/\*|\*|\*\/)/.test(t)) return false;
  if (/^[{}()[\];,]+$/.test(t)) return false;
  if (/^(<\?php|<\?=?|\?>)$/.test(t)) return false;
  return true;
}

/**
 * Assignment (plain or compound) or increment/decrement. Comparisons (`==`,
 * `!=`, `<=`, `>=`, `<=>`) and `=>` are fine. String literals are blanked first
 * so `strpos($s, '=')` does not count.
 */
export function looksMutating(expr: string): boolean {
  const withoutStrings = expr.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, "''");
  return /(?<![=!<>])=(?![=>])|\+\+|--|<<=|>>=/.test(withoutStrings);
}

function zodIssues(error: z.ZodError): PlanIssue[] {
  return error.issues.map((issue) => ({
    path: formatPath(issue.path),
    message: issue.message,
  }));
}

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out === '' ? String(seg) : `.${String(seg)}`;
  }
  return out;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as object)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** Directory a plan file's relative paths resolve against. */
export function planBaseDir(planPath: string): string {
  return dirname(resolve(planPath));
}
