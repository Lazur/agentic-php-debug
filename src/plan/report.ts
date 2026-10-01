import { sep } from 'node:path';
import type { CaptureError, ExceptionRecord, FrameRecord, ScopeDump, ValueRecord } from './capture.js';
import type { Expectation, Hypothesis, Prediction, RunOutcome } from './schema.js';
import type { TriggerResult } from './trigger.js';
import { canonicalJson, type PlanIssue } from './validate.js';

export const REPORT_VERSION = 1;

export type ProbeKind = 'line' | 'function' | 'exception';
export type StopKind = ProbeKind | 'entry' | 'unmatched';

/** One suspension the runner handled, in the order it happened. */
export interface StopRecord {
  seq: number;
  /** Matched probe id; null for entry and unmatched stops. */
  probe: string | null;
  kind: StopKind;
  /** 1-based hit number of that probe; 0 for entry and unmatched stops. */
  hit: number;
  /** False once the probe exceeded maxCaptures: counted, not inspected. */
  captured: boolean;
  /** DAP stop reason: breakpoint, exception, entry, step, ... */
  reason: string;
  threadId: number;
  location?: { file?: string; line?: number; function?: string };
  frames?: FrameRecord[];
  evaluate?: Record<string, ValueRecord>;
  locals?: Record<string, ScopeDump>;
  exception?: ExceptionRecord;
  errors?: CaptureError[];
  /** ms since the run started. */
  at: number;
}

/** A breakpoint as registered during initialize, with the adapter's verdict. */
export interface BreakpointRecord {
  probe: string;
  kind: ProbeKind;
  file?: string;
  line?: number;
  name?: string;
  filters?: string[];
  verification?: string;
  message?: string;
}

export interface ProbeSummary {
  kind: ProbeKind;
  hits: number;
  captured: number;
}

export interface ExpectationResult {
  expect: Expectation | Prediction;
  pass: boolean;
  /** False when nothing was captured to judge by (e.g. the probe never hit). */
  observed: boolean;
  actual?: unknown;
  message?: string;
}

export interface PredictionResult {
  hypothesis: string;
  claim: string;
  /** supported: every prediction held · refuted: an observed value contradicted one · untested: nothing observed to judge. */
  verdict: 'supported' | 'refuted' | 'untested';
  results: ExpectationResult[];
}

export interface RunError {
  phase: 'validate' | 'initialize' | 'execute' | 'teardown';
  tool?: string;
  code: string;
  message: string;
}

export interface PlanRunReport {
  reportVersion: typeof REPORT_VERSION;
  runId: string;
  plan: { name: string; version: number; hash: string; goal?: string; root: string };
  surface: string;
  backend?: string;
  env: { adapterVersion?: string; node: string; platform: string };
  startedAt: string;
  durationMs: number;
  outcome: RunOutcome;
  /** Why the run ended, in words — the outcome's explanation for the analysis phase. */
  outcomeDetail?: string;
  phases: Partial<Record<'initialize' | 'execute' | 'teardown', { ms: number }>>;
  breakpoints: BreakpointRecord[];
  stops: StopRecord[];
  probes: Record<string, ProbeSummary>;
  unmatchedStops: number;
  trigger?: TriggerResult;
  /** Tail of the adapter's output channel at the end of the run. */
  output?: { recent: Array<{ category: string; output: string }>; dropped: number };
  expectations: ExpectationResult[];
  predictions: PredictionResult[];
  errors: RunError[];
  warnings: PlanIssue[];
}

// ── expectations ─────────────────────────────────────────────────────────────

export function evaluateExpectations(
  report: Pick<PlanRunReport, 'stops' | 'probes' | 'outcome' | 'trigger'>,
  expectations: ReadonlyArray<Expectation | Prediction>,
): ExpectationResult[] {
  return expectations.map((e) => evaluateOne(report, e));
}

function evaluateOne(
  report: Pick<PlanRunReport, 'stops' | 'probes' | 'outcome' | 'trigger'>,
  e: Expectation | Prediction,
): ExpectationResult {
  if ('hits' in e) {
    const actual = report.probes[e.probe]?.hits ?? 0;
    return {
      expect: e,
      pass: actual === e.hits,
      observed: true,
      actual,
      ...(actual === e.hits ? {} : { message: `probe "${e.probe}" hit ${actual} time(s), expected ${e.hits}` }),
    };
  }

  if ('expr' in e) {
    const captured = report.stops
      .filter((s) => s.probe === e.probe && s.captured)
      .filter((s) => e.hit === undefined || s.hit === e.hit);
    if (captured.length === 0) {
      return {
        expect: e,
        pass: false,
        observed: false,
        message:
          e.hit === undefined
            ? `probe "${e.probe}" was never captured`
            : `hit ${e.hit} of probe "${e.probe}" was never captured`,
      };
    }
    const failures: string[] = [];
    const actual: Array<{ hit: number; value?: string; type?: string }> = [];
    let observed = false;
    for (const stop of captured) {
      const v = stop.evaluate?.[e.expr];
      if (!v || v.error || v.redacted) {
        failures.push(
          `hit ${stop.hit}: ${v?.error ? `${v.error.code} ${v.error.message}` : v?.redacted ? 'value redacted' : 'not evaluated'}`,
        );
        continue;
      }
      observed = true;
      actual.push({
        hit: stop.hit,
        ...(v.value !== undefined ? { value: v.value } : {}),
        ...(v.type !== undefined ? { type: v.type } : {}),
      });
      const problems: string[] = [];
      if (e.equals !== undefined && v.value !== e.equals)
        problems.push(`value ${JSON.stringify(v.value)} ≠ ${JSON.stringify(e.equals)}`);
      if (e.matches !== undefined && !new RegExp(e.matches).test(v.value ?? ''))
        problems.push(`value ${JSON.stringify(v.value)} does not match /${e.matches}/`);
      if (e.type !== undefined && v.type !== e.type)
        problems.push(`type ${JSON.stringify(v.type)} ≠ ${JSON.stringify(e.type)}`);
      if (problems.length > 0) failures.push(`hit ${stop.hit}: ${problems.join(', ')}`);
    }
    return {
      expect: e,
      pass: failures.length === 0,
      observed,
      actual: actual.length === 1 ? actual[0] : actual,
      ...(failures.length > 0 ? { message: `${e.expr} at "${e.probe}": ${failures.join('; ')}` } : {}),
    };
  }

  if ('sequence' in e) {
    const actual = report.stops.filter((s) => s.probe !== null).map((s) => s.probe);
    const pass = actual.length === e.sequence.length && actual.every((p, i) => p === e.sequence[i]);
    return {
      expect: e,
      pass,
      observed: true,
      actual,
      ...(pass ? {} : { message: `stops were [${actual.join(', ')}]` }),
    };
  }

  if ('outcome' in e) {
    const pass = report.outcome === e.outcome;
    return {
      expect: e,
      pass,
      observed: true,
      actual: report.outcome,
      ...(pass ? {} : { message: `outcome was "${report.outcome}"` }),
    };
  }

  // trigger
  const t = report.trigger;
  const problems: string[] = [];
  if (e.trigger.exitCode !== undefined && t?.exitCode !== e.trigger.exitCode) {
    problems.push(`exit code ${t?.exitCode ?? 'none'} ≠ ${e.trigger.exitCode}`);
  }
  if (e.trigger.status !== undefined && t?.status !== e.trigger.status) {
    problems.push(`HTTP status ${t?.status ?? 'none'} ≠ ${e.trigger.status}`);
  }
  return {
    expect: e,
    pass: problems.length === 0,
    observed: t !== undefined,
    actual: { exitCode: t?.exitCode, status: t?.status },
    ...(problems.length > 0 ? { message: problems.join(', ') } : {}),
  };
}

export function evaluatePredictions(
  report: Pick<PlanRunReport, 'stops' | 'probes' | 'outcome' | 'trigger'>,
  hypotheses: readonly Hypothesis[],
): PredictionResult[] {
  return hypotheses.map((h) => {
    const results = evaluateExpectations(report, h.predicts ?? []);
    let verdict: PredictionResult['verdict'];
    if (results.length === 0) verdict = 'untested';
    else if (results.every((r) => r.pass)) verdict = 'supported';
    else if (results.some((r) => !r.pass && r.observed)) verdict = 'refuted';
    else verdict = 'untested';
    return { hypothesis: h.id, claim: h.claim, verdict, results };
  });
}

// ── normalization and golden comparison ──────────────────────────────────────

/**
 * The run with everything that legitimately differs between two runs of the
 * same plan against the same code removed: ids, pids, timings, the surface it
 * ran on (and the validation warnings that depend on it), volatile
 * expressions, absolute paths under the plan root. Two
 * normalized reports that differ therefore describe different behaviour — of
 * PHP, of the adapter, or of the MCP layer.
 */
export function normalizeReport(report: PlanRunReport): unknown {
  const root = report.plan.root;
  const rel = (p: string | undefined): string | undefined => {
    if (p === undefined) return undefined;
    if (p === root) return '${root}';
    return p.startsWith(root + sep)
      ? `\${root}/${p
          .slice(root.length + 1)
          .split(sep)
          .join('/')}`
      : p;
  };
  const threads = new Map<number, string>();
  const thread = (id: number) => {
    if (!threads.has(id)) threads.set(id, `T${threads.size + 1}`);
    return threads.get(id)!;
  };

  const normalized = {
    reportVersion: report.reportVersion,
    plan: { name: report.plan.name, version: report.plan.version, hash: report.plan.hash },
    outcome: report.outcome,
    breakpoints: report.breakpoints.map((b) => ({ ...b, file: rel(b.file) })),
    stops: report.stops.map((s) => ({
      seq: s.seq,
      probe: s.probe,
      kind: s.kind,
      hit: s.hit,
      captured: s.captured,
      reason: s.reason,
      thread: thread(s.threadId),
      location: s.location ? { ...s.location, file: rel(s.location.file) } : undefined,
      frames: s.frames?.map((f) => ({ ...f, file: rel(f.file) })),
      evaluate: s.evaluate ? Object.fromEntries(Object.entries(s.evaluate).filter(([, v]) => !v.volatile)) : undefined,
      locals: s.locals,
      // `details` is the adapter's free text (its stack trace names server-side
      // paths); `frames` already carries the same information, normalized.
      exception: s.exception
        ? {
            exceptionId: s.exception.exceptionId,
            description: s.exception.description,
            breakMode: s.exception.breakMode,
          }
        : undefined,
      errors: s.errors?.map((e) => ({ tool: e.tool, code: e.code })),
    })),
    probes: report.probes,
    unmatchedStops: report.unmatchedStops,
    trigger: report.trigger
      ? {
          kind: report.trigger.kind,
          exitCode: report.trigger.exitCode,
          signal: report.trigger.signal,
          status: report.trigger.status,
          error: report.trigger.error,
        }
      : undefined,
    expectations: report.expectations.map((r) => ({ expect: r.expect, pass: r.pass })),
    predictions: report.predictions.map((p) => ({ hypothesis: p.hypothesis, verdict: p.verdict })),
    errors: report.errors.map((e) => ({ phase: e.phase, tool: e.tool, code: e.code })),
    // Validation warnings describe the plan document and the surface it was
    // checked for, not what the run did — and the hash already pins the plan.
  };
  // Round-trip through canonical JSON: sorted keys, undefined dropped.
  return JSON.parse(canonicalJson(normalized));
}

export interface GoldenComparison {
  equal: boolean;
  /** The golden was recorded from a different version of the plan. */
  planChanged: boolean;
  diffs: string[];
}

export function compareToGolden(normalized: unknown, golden: unknown, maxDiffs = 50): GoldenComparison {
  const diffs = diffJson(golden, normalized, '$', [], maxDiffs);
  const hashOf = (v: unknown) => (v as { plan?: { hash?: string } } | undefined)?.plan?.hash;
  return { equal: diffs.length === 0, planChanged: hashOf(golden) !== hashOf(normalized), diffs };
}

/** Structural difference, as "path: expected X, got Y" lines (expected = golden). */
export function diffJson(expected: unknown, actual: unknown, path = '$', out: string[] = [], max = 50): string[] {
  if (out.length >= max) return out;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length)
      out.push(`${path}: expected ${expected.length} item(s), got ${actual.length}`);
    for (let i = 0; i < Math.min(expected.length, actual.length); i++)
      diffJson(expected[i], actual[i], `${path}[${i}]`, out, max);
    return out;
  }
  if (isPlainObject(expected) && isPlainObject(actual)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of [...keys].sort()) {
      if (!(key in actual)) out.push(`${path}.${key}: missing (expected ${preview(expected[key])})`);
      else if (!(key in expected)) out.push(`${path}.${key}: unexpected ${preview(actual[key])}`);
      else diffJson(expected[key], actual[key], `${path}.${key}`, out, max);
      if (out.length >= max) break;
    }
    return out;
  }
  if (canonicalJson(expected) !== canonicalJson(actual)) {
    out.push(`${path}: expected ${preview(expected)}, got ${preview(actual)}`);
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function preview(v: unknown): string {
  const s = JSON.stringify(v) ?? 'undefined';
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

// ── summary for tool results ─────────────────────────────────────────────────

export interface SummaryOptions {
  maxStops?: number;
  maxValueChars?: number;
}

/**
 * The report cut down to what an agent needs to analyse the run in one tool
 * result: outcome, per-probe counts, the first stops with their values, and the
 * expectation/prediction verdicts. Everything else is one debug_plan_report away.
 */
export function summarizeReport(report: PlanRunReport, opts: SummaryOptions = {}): Record<string, unknown> {
  const maxStops = opts.maxStops ?? 20;
  const maxValue = opts.maxValueChars ?? 200;
  const root = report.plan.root;
  const where = (file?: string, line?: number) => {
    if (!file) return undefined;
    const shown = file.startsWith(root + sep) ? file.slice(root.length + 1) : file;
    return line !== undefined ? `${shown}:${line}` : shown;
  };
  const cut = (s: string) => (s.length > maxValue ? `${s.slice(0, maxValue)}…` : s);
  const renderValue = (v: ValueRecord): string =>
    v.error
      ? `!${v.error.code}: ${cut(v.error.message)}`
      : v.redacted
        ? '[redacted]'
        : cut(`${v.value ?? ''}${v.type ? ` (${v.type})` : ''}`);

  const failed = report.expectations.filter((r) => !r.pass);
  return {
    runId: report.runId,
    plan: report.plan.name,
    goal: report.plan.goal,
    outcome: report.outcome,
    ...(report.outcomeDetail ? { outcomeDetail: report.outcomeDetail } : {}),
    durationMs: report.durationMs,
    probes: report.probes,
    unmatchedStops: report.unmatchedStops,
    stops: report.stops.slice(0, maxStops).map((s) => ({
      seq: s.seq,
      probe: s.probe ?? s.kind,
      hit: s.hit,
      reason: s.reason,
      at: where(s.location?.file, s.location?.line),
      ...(s.location?.function ? { function: s.location.function } : {}),
      ...(s.evaluate
        ? { values: Object.fromEntries(Object.entries(s.evaluate).map(([k, v]) => [k, renderValue(v)])) }
        : {}),
      ...(s.exception?.description ? { exception: cut(s.exception.description) } : {}),
      ...(s.errors?.length ? { captureErrors: s.errors.length } : {}),
    })),
    ...(report.stops.length > maxStops ? { moreStops: report.stops.length - maxStops } : {}),
    expectations: {
      passed: report.expectations.length - failed.length,
      failed: failed.length,
      ...(failed.length > 0 ? { failures: failed.map((r) => ({ expect: r.expect, message: r.message })) } : {}),
    },
    ...(report.predictions.length > 0
      ? {
          predictions: report.predictions.map((p) => ({
            hypothesis: p.hypothesis,
            verdict: p.verdict,
            claim: p.claim,
          })),
        }
      : {}),
    ...(report.trigger
      ? {
          trigger: {
            kind: report.trigger.kind,
            ...(report.trigger.exitCode !== undefined ? { exitCode: report.trigger.exitCode } : {}),
            ...(report.trigger.status !== undefined ? { status: report.trigger.status } : {}),
            ...(report.trigger.error ? { error: report.trigger.error } : {}),
          },
        }
      : {}),
    ...(report.errors.length > 0 ? { errors: report.errors } : {}),
    ...(report.warnings.length > 0 ? { warnings: report.warnings.slice(0, 10) } : {}),
  };
}
