import type { ToolResult } from '../tools/types.js';
import type { ToolInvoker } from './invoker.js';
import { REDACTED, type Redactor } from './redact.js';
import type { ResolvedCapture } from './validate.js';

/** One stack frame as recorded in a capture. Ids are deliberately absent: they die on resume. */
export interface FrameRecord {
  index: number;
  name?: string;
  file?: string;
  line?: number;
}

/** A captured value: rendered text and type, or why there is none. */
export interface ValueRecord {
  value?: string;
  type?: string;
  error?: { code: string; message: string };
  redacted?: true;
  /** Excluded from golden comparison (plan marked the expression volatile). */
  volatile?: true;
  children?: Record<string, ValueRecord>;
  /** Set when only the first maxItems of this many children were kept. */
  truncatedFrom?: number;
}

export interface ScopeDump {
  variables: Record<string, ValueRecord>;
  truncatedFrom?: number;
}

export interface ExceptionRecord {
  exceptionId?: string;
  description?: string;
  breakMode?: string;
  details?: unknown;
}

export interface CaptureError {
  tool: string;
  code: string;
  message: string;
}

export interface Capture {
  frames: FrameRecord[];
  evaluate?: Record<string, ValueRecord>;
  locals?: Record<string, ScopeDump>;
  exception?: ExceptionRecord;
  errors?: CaptureError[];
}

/** A frame exactly as debug_stack_trace returns it — the id is needed for scopes and evaluate. */
export interface RawFrame {
  id: number;
  name?: string;
  source?: { path?: string; name?: string };
  line?: number;
}

export interface CaptureLimits {
  evaluateTimeoutMs: number;
  /** Longer rendered values are cut, so one huge string cannot flood the report. */
  maxValueChars: number;
  /** Upper bound on debug_variables calls per capture; deep dumps of big graphs stop here. */
  maxVariableRequests: number;
}

export const DEFAULT_CAPTURE_LIMITS: CaptureLimits = {
  evaluateTimeoutMs: 5_000,
  maxValueChars: 2_000,
  maxVariableRequests: 100,
};

/** How many frames a capture spec needs fetched: enough to record and to evaluate in. */
export function framesNeeded(spec: ResolvedCapture): number {
  return Math.max(1, spec.stack, ...spec.evaluate.map((e) => e.frame + 1));
}

export async function fetchStack(
  invoker: ToolInvoker,
  threadId: number,
  levels: number,
): Promise<{ frames: RawFrame[] } | { error: CaptureError }> {
  const r = await invoker.invoke('debug_stack_trace', { threadId, levels });
  if (!r.success) return { error: toCaptureError('debug_stack_trace', r) };
  const frames = ((r.data as { stackFrames?: RawFrame[] } | undefined)?.stackFrames ?? []).filter(
    (f) => typeof f.id === 'number',
  );
  return { frames };
}

export function toFrameRecords(frames: RawFrame[], count: number): FrameRecord[] {
  return frames.slice(0, count).map((f, index) => ({
    index,
    ...(f.name !== undefined ? { name: f.name } : {}),
    ...(f.source?.path !== undefined ? { file: f.source.path } : {}),
    ...(f.line !== undefined ? { line: f.line } : {}),
  }));
}

/**
 * Record everything a capture spec asks for at one stop, through tools only.
 *
 * Never throws and never aborts part-way: a failed evaluate becomes an `error`
 * on that value and the rest of the capture still runs. One broken expression
 * must not cost the whole hit.
 */
export async function captureStop(
  invoker: ToolInvoker,
  stop: { threadId: number; frames: RawFrame[]; reason?: string },
  spec: ResolvedCapture,
  redactor: Redactor,
  limits: CaptureLimits = DEFAULT_CAPTURE_LIMITS,
): Promise<Capture> {
  const errors: CaptureError[] = [];
  const out: Capture = { frames: toFrameRecords(stop.frames, spec.stack) };

  if (spec.exception || stop.reason === 'exception') {
    const r = await invoker.invoke('debug_exception_info', { threadId: stop.threadId });
    if (r.success) {
      const d = (r.data ?? {}) as ExceptionRecord;
      out.exception = {
        ...(d.exceptionId !== undefined ? { exceptionId: d.exceptionId } : {}),
        ...(d.description !== undefined ? { description: d.description } : {}),
        ...(d.breakMode !== undefined ? { breakMode: d.breakMode } : {}),
        ...(d.details !== undefined ? { details: d.details } : {}),
      };
    } else {
      errors.push(toCaptureError('debug_exception_info', r));
    }
  }

  if (spec.evaluate.length > 0) {
    out.evaluate = {};
    for (const e of spec.evaluate) {
      const key = evaluateKey(e.expr, e.frame);
      const frame = stop.frames[e.frame];
      if (!frame) {
        out.evaluate[key] = {
          error: { code: 'NO_FRAME', message: `Frame ${e.frame} does not exist (the stack has ${stop.frames.length})` },
        };
        continue;
      }
      if (redactor.isSensitiveExpression(e.expr)) {
        // Not even sent: evaluating it would put the value on the wire and in the journal.
        out.evaluate[key] = { value: REDACTED, redacted: true };
        continue;
      }
      // 'watch' makes the adapter try property_get before eval, so a plain
      // variable is read without executing any PHP (phpDebug.ts:1562).
      const r = await invoker.invoke('debug_evaluate', {
        expression: e.expr,
        frameId: frame.id,
        context: 'watch',
        timeout: limits.evaluateTimeoutMs,
      });
      const record: ValueRecord = r.success
        ? renderValue((r.data as { result?: string } | undefined)?.result, (r.data as { type?: string } | undefined)?.type, limits)
        : { error: { code: r.error?.code ?? 'DAP_ERROR', message: r.error?.message ?? 'evaluate failed' } };
      // Volatile applies to failures too: a clock read that errors today and
      // succeeds tomorrow must not break a golden comparison either way.
      if (e.volatile) record.volatile = true;
      out.evaluate[key] = record;
    }
  }

  if (spec.locals && stop.frames[0]) {
    const sr = await invoker.invoke('debug_scopes', { frameId: stop.frames[0].id });
    if (!sr.success) {
      errors.push(toCaptureError('debug_scopes', sr));
    } else {
      const scopes = ((sr.data as { scopes?: Array<{ name: string; variablesReference: number }> })?.scopes ?? []);
      const budget = { left: limits.maxVariableRequests };
      out.locals = {};
      for (const wanted of spec.locals.scopes) {
        // By name, not position: on an exception stop the adapter puts a scope
        // named after the exception class first (phpDebug.ts:1171).
        const scope = scopes.find((s) => s.name.toLowerCase() === wanted.toLowerCase());
        if (!scope) {
          errors.push({
            tool: 'debug_scopes',
            code: 'NO_SCOPE',
            message: `No scope named "${wanted}" (available: ${scopes.map((s) => s.name).join(', ') || 'none'})`,
          });
          continue;
        }
        out.locals[scope.name] = await dumpVariables(invoker, scope.variablesReference, {
          depth: spec.locals.depth,
          maxItems: spec.locals.maxItems,
          redactor,
          redactValues: redactor.isValueRedactedScope(scope.name),
          limits,
          budget,
          errors,
        });
      }
    }
  }

  if (errors.length > 0) out.errors = errors;
  return out;
}

/** Key under which an evaluate result is stored: the expression, prefixed with its frame when not the top one. */
export function evaluateKey(expr: string, frame: number): string {
  return frame === 0 ? expr : `#${frame} ${expr}`;
}

interface DumpOptions {
  depth: number;
  maxItems: number;
  redactor: Redactor;
  redactValues: boolean;
  limits: CaptureLimits;
  budget: { left: number };
  errors: CaptureError[];
}

async function dumpVariables(invoker: ToolInvoker, ref: number, opts: DumpOptions): Promise<ScopeDump> {
  if (opts.budget.left <= 0) {
    opts.errors.push({
      tool: 'debug_variables',
      code: 'CAPTURE_BUDGET',
      message: `Stopped expanding after ${opts.limits.maxVariableRequests} variable requests; lower locals.depth or maxItems.`,
    });
    return { variables: {} };
  }
  opts.budget.left--;

  const r = await invoker.invoke('debug_variables', { variablesReference: ref });
  if (!r.success) {
    opts.errors.push(toCaptureError('debug_variables', r));
    return { variables: {} };
  }
  const list = ((r.data as { variables?: Array<{ name: string; value?: string; type?: string; variablesReference?: number }> })
    ?.variables ?? []);
  const kept = list.slice(0, opts.maxItems);

  const variables: Record<string, ValueRecord> = {};
  for (const v of kept) {
    const name = uniqueKey(variables, v.name);
    if (opts.redactValues || opts.redactor.isSensitiveName(v.name)) {
      variables[name] = { ...(v.type !== undefined ? { type: v.type } : {}), value: REDACTED, redacted: true };
      continue;
    }
    const record = renderValue(v.value, v.type, opts.limits);
    if (opts.depth > 0 && (v.variablesReference ?? 0) > 0) {
      const child = await dumpVariables(invoker, v.variablesReference!, { ...opts, depth: opts.depth - 1 });
      record.children = child.variables;
      if (child.truncatedFrom !== undefined) record.truncatedFrom = child.truncatedFrom;
    }
    variables[name] = record;
  }
  return { variables, ...(list.length > kept.length ? { truncatedFrom: list.length } : {}) };
}

function uniqueKey(existing: Record<string, unknown>, name: string): string {
  if (!(name in existing)) return name;
  let i = 2;
  while (`${name} (${i})` in existing) i++;
  return `${name} (${i})`;
}

function renderValue(value: string | undefined, type: string | undefined, limits: CaptureLimits): ValueRecord {
  const record: ValueRecord = {};
  if (value !== undefined) {
    record.value = value.length > limits.maxValueChars ? `${value.slice(0, limits.maxValueChars)}…[truncated]` : value;
  }
  if (type !== undefined) record.type = type;
  return record;
}

export function toCaptureError(tool: string, r: ToolResult): CaptureError {
  return { tool, code: r.error?.code ?? 'DAP_ERROR', message: r.error?.message ?? `${tool} failed` };
}
