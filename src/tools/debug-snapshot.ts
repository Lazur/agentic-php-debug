import { z } from 'zod';
import type { SessionManager } from '../session.js';
import { SessionState } from '../session.js';
import { captureStop, type CaptureError, type ExceptionRecord, type FrameRecord, type RawFrame, type ValueRecord } from '../plan/capture.js';
import type { ToolInvoker } from '../plan/invoker.js';
import { Redactor } from '../plan/redact.js';
import { PLAN_DEFAULTS } from '../plan/validate.js';
import { successResult, errorResult, ErrorCodes, type ToolResult } from './types.js';
import { toolError } from './errors.js';
import { ambiguousThreadNote, resolveStoppedThreadId } from './thread-resolution.js';
import { handleDebugStackTrace } from './debug-stack-trace.js';
import { handleDebugEvaluate } from './debug-evaluate.js';
import { handleDebugScopes } from './debug-scopes.js';
import { handleDebugVariables } from './debug-variables.js';
import { handleDebugExceptionInfo } from './debug-exception-info.js';

export const snapshotOptionsSchema = z.object({
  frames: z.number().int().min(1).max(50).optional().describe('Stack frames to include (default 3)'),
  watch: z
    .array(z.string().min(1))
    .max(20)
    .optional()
    .describe('Expressions to add to this session\'s watch list. Watches are evaluated in the top frame at every snapshot.'),
  unwatch: z.array(z.string().min(1)).max(20).optional().describe('Expressions to drop from the watch list'),
  locals: z
    .union([
      z.literal(false),
      z
        .object({
          depth: z.number().int().min(0).max(3).optional().describe('Expansion depth of arrays/objects (default 0: names and scalar values)'),
          maxItems: z.number().int().min(1).max(200).optional().describe('Variables kept per container (default 40)'),
        })
        .strict(),
    ])
    .optional()
    .describe('Locals of the top frame (default depth 0); false to skip'),
  diff: z.boolean().optional().describe('Include `delta` against this thread\'s previous snapshot (default true)'),
});

export const debugSnapshotSchema = snapshotOptionsSchema.extend({
  threadId: z.number().int().optional().describe('Suspended thread to observe. Defaults to the one that stopped most recently.'),
});

export type SnapshotOptions = z.infer<typeof snapshotOptionsSchema>;
export type DebugSnapshotInput = z.infer<typeof debugSnapshotSchema>;

export const debugSnapshotDescription = `Observe the paused frame in one call: where execution is, the top stack frames, your watch expressions, and the frame's locals — plus a "delta" against this thread's previous snapshot: where execution moved from and to, which locals changed, appeared or disappeared, and which watches changed.

This is the observation step of an interactive (ReAct) debugging loop: state what you expect, act (debug_next, debug_step_in, debug_step_out, debug_continue), then observe with debug_wait {"snapshot": true} — or this tool when already paused — and compare the delta with your expectation. It replaces the debug_stack_trace → debug_scopes → debug_variables → debug_evaluate round trips.

Watches are sticky for the session: add them with "watch", drop them with "unwatch". When the function changed (a step in or out), locals are not diffed — "frameChanged" says so. Values whose names look like secrets are redacted. Requires the session to be paused.`;

/** One observation of a suspended thread. */
export interface Snapshot {
  threadId: number;
  suspensionId?: number;
  reason?: string;
  location?: { file?: string; line?: number; function?: string };
  frames: FrameRecord[];
  totalFrames: number;
  watches?: Record<string, ValueRecord>;
  locals?: Record<string, ValueRecord>;
  exception?: ExceptionRecord;
  errors?: CaptureError[];
}

export interface SnapshotDelta {
  /** No earlier snapshot of this thread in this session. */
  first?: true;
  /** The same suspension was observed before: nothing ran in between. */
  sameStop?: true;
  moved?: { from: string; to: string };
  depth?: { from: number; to: number };
  /** The top function differs, so locals belong to a different frame and are not diffed. */
  frameChanged?: { from?: string; to?: string };
  changed?: Array<{ name: string; from?: string; to?: string }>;
  added?: string[];
  removed?: string[];
  watchChanged?: Array<{ expr: string; from?: string; to?: string }>;
}

interface SnapshotState {
  launch: number;
  watches: string[];
  last: Map<number, Snapshot>;
}

/**
 * Per-session watch list and last snapshot per thread. Held outside
 * SessionManager so the session stays unaware of it; the launch count tells a
 * relaunch apart, since a new adapter numbers its threads from 1 again.
 */
const states = new WeakMap<SessionManager, SnapshotState>();

function stateFor(session: SessionManager): SnapshotState {
  let state = states.get(session);
  if (!state || state.launch !== session.launchCount) {
    // A relaunch keeps the watches — they express intent — and drops frames.
    state = { launch: session.launchCount, watches: state?.watches ?? [], last: new Map() };
    states.set(session, state);
  }
  return state;
}

const redactor = new Redactor([...PLAN_DEFAULTS.redactNames], [...PLAN_DEFAULTS.redactScopes]);

/** The inspection handlers, called directly: a snapshot needs nothing else. */
function inspectionInvoker(session: SessionManager): ToolInvoker {
  return {
    surface: 'in-process',
    tools: async () => new Set(['debug_stack_trace', 'debug_evaluate', 'debug_scopes', 'debug_variables', 'debug_exception_info']),
    invoke: async (name, args) => {
      switch (name) {
        case 'debug_stack_trace':
          return handleDebugStackTrace(session, args as never);
        case 'debug_evaluate':
          return handleDebugEvaluate(session, args as never);
        case 'debug_scopes':
          return handleDebugScopes(session, args as never);
        case 'debug_variables':
          return handleDebugVariables(session, args as never);
        case 'debug_exception_info':
          return handleDebugExceptionInfo(session, args as never);
        default:
          return errorResult(`${name} is not used by debug_snapshot`, ErrorCodes.INVALID_PARAMS);
      }
    },
  };
}

export async function handleDebugSnapshot(session: SessionManager, args: DebugSnapshotInput): Promise<ToolResult> {
  try {
    session.assertState(SessionState.Paused);
    return await takeSnapshot(session, args);
  } catch (err: unknown) {
    return toolError(err, { stateCode: ErrorCodes.SESSION_NOT_PAUSED });
  }
}

/** Shared by debug_snapshot and debug_wait {snapshot}. Assumes the session is paused. */
export async function takeSnapshot(session: SessionManager, args: DebugSnapshotInput): Promise<ToolResult> {
  const resolved = resolveStoppedThreadId(session, args.threadId);
  if (!resolved) {
    return errorResult('No thread is suspended. Call debug_wait to reach a stop first.', ErrorCodes.SESSION_NOT_PAUSED);
  }
  const { threadId } = resolved;

  const state = stateFor(session);
  for (const expr of args.unwatch ?? []) state.watches = state.watches.filter((w) => w !== expr);
  for (const expr of args.watch ?? []) if (!state.watches.includes(expr)) state.watches.push(expr);

  const invoker = inspectionInvoker(session);
  const levels = args.frames ?? 3;
  const st = await invoker.invoke('debug_stack_trace', { threadId, levels });
  if (!st.success) return st;
  const stackData = st.data as { stackFrames?: RawFrame[]; totalFrames?: number };
  const rawFrames = stackData.stackFrames ?? [];

  const reason = session.status.stoppedThreads.find((t) => t.threadId === threadId)?.reason;
  const capture = await captureStop(
    invoker,
    { threadId, frames: rawFrames, ...(reason !== undefined ? { reason } : {}) },
    {
      stack: levels,
      evaluate: state.watches.map((expr) => ({ expr, frame: 0, volatile: false })),
      locals:
        args.locals === false
          ? false
          : { depth: args.locals?.depth ?? 0, maxItems: args.locals?.maxItems ?? 40, scopes: ['Locals'] },
      exception: reason === 'exception',
    },
    redactor,
  );

  const top = rawFrames[0];
  const suspensionId = session.suspensionIdFor(threadId);
  const snapshot: Snapshot = {
    threadId,
    ...(suspensionId !== undefined ? { suspensionId } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(top
      ? {
          location: {
            ...(top.source?.path !== undefined ? { file: top.source.path } : {}),
            ...(top.line !== undefined ? { line: top.line } : {}),
            ...(top.name !== undefined ? { function: top.name } : {}),
          },
        }
      : {}),
    frames: capture.frames,
    totalFrames: stackData.totalFrames ?? rawFrames.length,
    ...(capture.evaluate ? { watches: capture.evaluate } : {}),
    ...(capture.locals?.Locals ? { locals: capture.locals.Locals.variables } : {}),
    ...(capture.exception ? { exception: capture.exception } : {}),
    ...(capture.errors ? { errors: capture.errors } : {}),
  };

  const delta = args.diff === false ? undefined : diffSnapshots(state.last.get(threadId), snapshot);
  state.last.set(threadId, snapshot);

  return successResult({
    ...(resolved.ambiguous ? { warning: ambiguousThreadNote(session, threadId) } : {}),
    ...snapshot,
    ...(delta ? { delta } : {}),
    watchList: [...state.watches],
    nextAction:
      'Compare delta with what you expected. Then step (debug_next / debug_step_in / debug_step_out) or ' +
      'debug_continue, and observe again with debug_wait {"snapshot": true}.',
  });
}

/** What changed between two observations of the same thread. */
export function diffSnapshots(prev: Snapshot | undefined, next: Snapshot): SnapshotDelta {
  if (!prev) return { first: true };
  const delta: SnapshotDelta = {};
  if (prev.suspensionId !== undefined && prev.suspensionId === next.suspensionId) delta.sameStop = true;

  const where = (s: Snapshot) =>
    s.location ? `${s.location.function ?? '?'} @ ${s.location.file ?? '?'}:${s.location.line ?? '?'}` : 'unknown';
  if (where(prev) !== where(next)) delta.moved = { from: where(prev), to: where(next) };
  if (prev.totalFrames !== next.totalFrames) delta.depth = { from: prev.totalFrames, to: next.totalFrames };

  const sameFrame = prev.location?.function === next.location?.function && prev.totalFrames === next.totalFrames;
  if (!sameFrame) {
    delta.frameChanged = {
      ...(prev.location?.function !== undefined ? { from: prev.location.function } : {}),
      ...(next.location?.function !== undefined ? { to: next.location.function } : {}),
    };
  } else if (prev.locals && next.locals) {
    const changed: NonNullable<SnapshotDelta['changed']> = [];
    const added: string[] = [];
    for (const [name, v] of Object.entries(next.locals)) {
      const before = prev.locals[name];
      if (!before) added.push(`${name} = ${render(v)}`);
      else if (render(before) !== render(v)) changed.push({ name, from: render(before), to: render(v) });
    }
    const removed = Object.keys(prev.locals).filter((name) => !(name in next.locals!));
    if (changed.length) delta.changed = changed;
    if (added.length) delta.added = added;
    if (removed.length) delta.removed = removed;
  }

  const watchChanged: NonNullable<SnapshotDelta['watchChanged']> = [];
  for (const [expr, v] of Object.entries(next.watches ?? {})) {
    const before = prev.watches?.[expr];
    if (before && render(before) !== render(v)) watchChanged.push({ expr, from: render(before), to: render(v) });
  }
  if (watchChanged.length) delta.watchChanged = watchChanged;
  return delta;
}

function render(v: ValueRecord): string {
  if (v.error) return `!${v.error.code}`;
  return v.value ?? '';
}
