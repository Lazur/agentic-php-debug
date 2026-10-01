import type { SessionManager } from '../session.js';
import { SessionState } from '../session.js';
import { successResult, errorResult, ErrorCodes, type ToolResult } from './types.js';
import { toolError } from './errors.js';
import { ambiguousThreadNote, resolveStoppedThreadId } from './thread-resolution.js';

/** The four DAP requests that resume a suspended thread. */
export interface ContinuationSpec {
  command: 'continue' | 'next' | 'stepIn' | 'stepOut';
  /** How the result phrases what happened, e.g. "Stepped over". */
  pastTense: string;
}

/**
 * Shared body for debug_continue / debug_next / debug_step_in / debug_step_out.
 *
 * The important part is what happens AFTER the request succeeds: DAP makes the
 * client responsible for knowing the target is running again, because the
 * adapter is explicitly not expected to send a `continued` event in response to
 * a request that implies execution continues. Without `markResumed` the session
 * stayed in `paused` with the previous stop, and `debug_wait` answered
 * `already_paused` instantly while PHP was actually running.
 */
export async function runContinuation(
  session: SessionManager,
  spec: ContinuationSpec,
  explicitThreadId?: number,
): Promise<ToolResult> {
  try {
    session.assertState(SessionState.Paused);

    const resolved = resolveStoppedThreadId(session, explicitThreadId);
    if (!resolved) {
      return errorResult(
        'threadId is required — no thread is currently suspended. Call debug_status to see session state.',
        ErrorCodes.INVALID_PARAMS,
      );
    }
    const { threadId } = resolved;

    // Read BEFORE sending: if the target re-stops instantly, the response and
    // the new `stopped` arrive in one chunk and are dispatched synchronously,
    // so this is what lets markResumed tell "still running" from "stopped again".
    const observed = session.suspensionIdFor(threadId);
    await session.dapClient.sendRequest(spec.command, { threadId });
    const resumed = observed !== undefined && session.markResumed(threadId, observed);

    return successResult({
      ...(resolved.ambiguous ? { warning: ambiguousThreadNote(session, threadId) } : {}),
      threadId,
      resumed,
      state: session.state,
      message: `${spec.pastTense} on thread ${threadId}`,
      nextAction: 'Call debug_wait to wait for the next stop event.',
      ...(resumed ? {} : { note: notResumedNote(session, threadId, observed) }),
    });
  } catch (err: unknown) {
    return toolError(err, { stateCode: ErrorCodes.SESSION_NOT_PAUSED });
  }
}

/**
 * Explain why the session is not running even though the request succeeded.
 * Each case has a different remedy, so it is worth distinguishing them rather
 * than emitting one vague warning.
 */
function notResumedNote(
  session: SessionManager,
  threadId: number,
  observed: number | undefined,
): string {
  if (observed === undefined) {
    const suspended = session.status.stoppedThreads.map((t) => t.threadId);
    return (
      `Thread ${threadId} was not suspended, so nothing resumed. ` +
      (suspended.length > 0
        ? `Suspended thread ids: ${suspended.join(', ')}. Re-issue with one of those — ` +
          'debug_threads lists running connections too, not only stopped ones.'
        : 'No thread is currently suspended; call debug_status.')
    );
  }
  if (session.state === SessionState.Terminated) {
    return 'The target finished during this command; the session is over. Call debug_launch to start a new one.';
  }
  if (session.state === SessionState.Paused) {
    return (
      'The target re-stopped immediately, so the session is suspended again at a NEW location ' +
      '(not the one you resumed from). Call debug_stack_trace to see where.'
    );
  }
  return 'The session did not transition as expected; call debug_status.';
}
