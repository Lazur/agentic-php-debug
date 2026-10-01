import { z } from 'zod';
import type { SessionManager } from '../session.js';
import { SessionState } from '../session.js';
import type { EventHandler } from '../debug-backend.js';
import { successResult, type ToolResult } from './types.js';
import { snapshotOptionsSchema, takeSnapshot } from './debug-snapshot.js';

export const debugWaitSchema = z.object({
  timeout: z.number().int().optional().describe('Maximum wait time in milliseconds (default: 30000)'),
  snapshot: z
    .union([z.boolean(), snapshotOptionsSchema])
    .optional()
    .describe(
      'When the wait ends with the session paused, attach a debug_snapshot of the stopped thread: true, or ' +
        'snapshot options such as {"watch": ["$total"]}',
    ),
});

export type DebugWaitInput = z.infer<typeof debugWaitSchema>;

export const debugWaitDescription = `Block until the debug session produces an event (stopped, thread, terminated, continued, exited) or the timeout elapses. Call this after triggering PHP execution — an HTTP request, a CLI script, a queue worker — to wait for Xdebug to connect and hit a breakpoint.

Events that fired between two tool calls are buffered and replayed, so nothing is missed by not being inside a wait at the time. A replayed result carries "replayed": true and a "remainingBufferedEvents" count — call debug_wait again to drain the rest before waiting for anything new.

Returns immediately with reason "already_paused" when the session is already stopped, and with reason "timeout" (plus guidance for the current state) when nothing happened in time. A timeout is not an error: retry debug_wait, or call debug_status to inspect the session.

Pass "snapshot": true to get the stopped frame in the same result — location, top frames, watches, locals and a delta against the previous stop — which makes step → debug_wait {"snapshot": true} a two-call observe loop.`;

/** Signal for cancellation support. */
export interface WaitSignal {
  aborted: boolean;
  onAbort: (cb: () => void) => void;
}

/** Result payload for debug_wait. */
export interface WaitResult {
  reason: 'event' | 'already_paused' | 'timeout' | 'cancelled';
  event: string | null;
  body: Record<string, unknown> | null;
  status: import('../session.js').SessionStatus;
  /** True when the event fired before this call and was replayed from the buffer. */
  replayed?: boolean;
  /** How many further buffered events remain; each takes one more debug_wait. */
  remainingBufferedEvents?: number;
}

const WAIT_EVENTS = ['stopped', 'thread', 'terminated', 'continued', 'exited'] as const;

const timeoutGuidance: Record<string, string> = {
  [SessionState.NotStarted]: 'No active session. Call debug_launch to start debugging.',
  [SessionState.Initializing]: 'Session is still initializing. Retry debug_wait shortly.',
  [SessionState.Listening]: 'Xdebug has not connected yet. Ensure PHP execution is triggered, then retry debug_wait.',
  [SessionState.Connected]: 'Execution has not hit a breakpoint. Verify breakpoint placement or retry debug_wait.',
  [SessionState.Paused]: 'Session is paused. Call debug_stack_trace to inspect where execution stopped.',
  [SessionState.Terminated]: 'Session has ended. Call debug_launch to start a new session.',
};

/**
 * Block until a debug event occurs, the timeout elapses, or cancellation is signalled.
 * Framework-agnostic — works with any DebugBackend implementation.
 *
 * With `snapshot`, a wait that ends paused also observes the stopped frame.
 */
export async function handleDebugWait(
  session: SessionManager,
  options: DebugWaitInput,
  signal?: WaitSignal,
): Promise<ToolResult> {
  const result = await waitForDebugEvent(session, options, signal);
  if (!options.snapshot || !result.success || session.state !== SessionState.Paused) return result;

  // Prefer the thread this event names, but only while it is still suspended:
  // a replayed stop can describe a thread that has since been resumed.
  const data = result.data as WaitResult & Record<string, unknown>;
  const eventThread = data.event === 'stopped' ? (data.body as { threadId?: unknown } | null)?.threadId : undefined;
  const threadId =
    typeof eventThread === 'number' && session.suspensionIdFor(eventThread) !== undefined ? eventThread : undefined;
  const snap = await takeSnapshot(session, {
    ...(options.snapshot === true ? {} : options.snapshot),
    ...(threadId !== undefined ? { threadId } : {}),
  });
  return successResult({
    ...data,
    snapshot: snap.success ? snap.data : { error: snap.error },
    nextAction: 'Compare snapshot.delta with what you expected, then act.',
  });
}

async function waitForDebugEvent(
  session: SessionManager,
  options: DebugWaitInput,
  signal?: WaitSignal,
): Promise<ToolResult> {
  const timeout = options.timeout ?? 30000;

  // 1. Already-paused early return. The buffer is cleared because this result
  // already reports the stop; replaying it on the next call would be stale.
  if (session.state === SessionState.Paused) {
    session.clearPendingEvents();
    return successResult({
      reason: 'already_paused',
      event: null,
      body: null,
      status: session.status,
      nextAction: 'Call debug_stack_trace to inspect where execution stopped.',
    });
  }

  // 2. Already-cancelled early return
  if (signal?.aborted) {
    return successResult({
      reason: 'cancelled',
      event: null,
      body: null,
      status: session.status,
      nextAction: 'Call debug_status to check session state.',
    });
  }

  // 3. Replay an event that fired before this call. Listeners are only
  // registered below, so without this an event landing between two tool calls
  // is lost and this wait blocks for its full timeout.
  const buffered = session.takePendingEvent();
  if (buffered) {
    const status = session.status;
    return successResult({
      reason: 'event',
      event: buffered.event,
      body: (buffered.body as Record<string, unknown>) ?? {},
      status,
      replayed: true,
      remainingBufferedEvents: status.pendingEventCount,
      nextAction: status.pendingEventCount > 0
        ? 'Call debug_wait again to drain the remaining buffered events.'
        : 'Call debug_stack_trace to inspect where execution stopped.',
    });
  }

  // 4. Nothing buffered and the session is over — no event can arrive, so
  // blocking for the full timeout would only waste it.
  if (session.state === SessionState.Terminated) {
    return successResult({
      reason: 'timeout',
      event: null,
      body: null,
      status: session.status,
      nextAction: 'Call debug_launch to start a new session.',
      guidance: timeoutGuidance[SessionState.Terminated],
    });
  }

  // 5. Create Promise that races event listeners, timeout, and cancellation
  return new Promise<ToolResult>((resolve) => {
    let settled = false;
    const handlers: Array<{ eventName: string; handler: EventHandler }> = [];
    let timer: ReturnType<typeof setTimeout>;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const { eventName, handler } of handlers) {
        backend.offEvent(eventName, handler);
      }
    };

    const backend = session.dapClient;

    // Register event listeners
    for (const eventName of WAIT_EVENTS) {
      const handler: EventHandler = (event) => {
        cleanup();
        // The session buffered this event too; this result reports it, so the
        // next debug_wait must not replay it.
        session.consumePendingEvent(event);
        resolve(successResult({
          reason: 'event',
          event: eventName,
          body: (event.body as Record<string, unknown>) ?? {},
          status: session.status,
          nextAction: 'Call debug_stack_trace to inspect where execution stopped.',
        }));
      };
      backend.onEvent(eventName, handler);
      handlers.push({ eventName, handler });
    }

    // Timeout
    timer = setTimeout(() => {
      cleanup();
      resolve(successResult({
        reason: 'timeout',
        event: null,
        body: null,
        status: session.status,
        nextAction: 'Retry debug_wait or call debug_status to check session state.',
        guidance: timeoutGuidance[session.state] ?? 'Check session state with debug_status.',
      }));
    }, timeout);

    // Cancellation
    signal?.onAbort(() => {
      cleanup();
      resolve(successResult({
        reason: 'cancelled',
        event: null,
        body: null,
        status: session.status,
        nextAction: 'Call debug_status to check session state.',
      }));
    });
  });
}
