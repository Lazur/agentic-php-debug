import { z } from 'zod';
import type { SessionManager } from '../session.js';
import { SessionState } from '../session.js';
import { successResult, errorResult, ErrorCodes, type ToolResult } from './types.js';
import { toolError } from './errors.js';
import { resolveRunningThreadId } from './thread-resolution.js';

export const debugPauseSchema = z.object({
  threadId: z.number().int().optional().describe('Thread ID to pause. Defaults to the sole live connection when exactly one is running.'),
});

export type DebugPauseInput = z.infer<typeof debugPauseSchema>;

export const debugPauseDescription = `Pause running execution — ONLY works on Linux or Windows with Xdebug >= 3.5.0.

Xdebug has no DBGp-level pause: the DBGp "break" command is optional and Xdebug does not implement it. The adapter instead uses Xdebug's out-of-band control socket, which requires Linux or Windows AND Xdebug >= 3.5.0. On macOS this ALWAYS fails, and DAP has no capability flag that would let this server detect it in advance.

If pausing is unavailable, get to a stop a different way: set a breakpoint with debug_set_breakpoints (optionally conditional), or break on throw with debug_set_exception_breakpoints, then call debug_wait.

Requires the session to be in connected (running) state. After pausing, use debug_stack_trace, debug_variables, debug_evaluate to inspect.`;

/**
 * The adapter's exact wording when the control socket is unavailable
 * (phpDebug.ts:1468). Matching it lets us return a code the agent can branch on
 * instead of a generic DAP_ERROR. If upstream rewords this, we degrade to
 * DAP_ERROR with the adapter's own text — never to a wrong answer.
 */
const PAUSE_UNSUPPORTED_MESSAGE = 'Pausing the execution is not supported by Xdebug';

export async function handleDebugPause(
  session: SessionManager,
  args: z.infer<typeof debugPauseSchema>,
): Promise<ToolResult> {
  try {
    session.assertState(SessionState.Connected);

    // Unlike every other thread-taking tool, this one runs while NOTHING is
    // suspended, so stopInfo cannot supply a default — only the live connection
    // list can, and only when it is unambiguous.
    const threadId = resolveRunningThreadId(session, args.threadId);
    if (threadId === undefined) {
      const live = session.status.liveThreadIds;
      return errorResult(
        live.length === 0
          ? 'threadId is required — no Xdebug connection is live. Call debug_status to see session state.'
          : `threadId is required — ${live.length} connections are live (${live.join(', ')}). ` +
            'Call debug_threads and pass one explicitly.',
        ErrorCodes.INVALID_PARAMS,
      );
    }

    await session.dapClient.sendRequest('pause', { threadId });
    return successResult({
      threadId,
      message: `Pause requested for thread ${threadId}`,
      nextAction: 'Call debug_stack_trace to inspect where execution stopped.',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes(PAUSE_UNSUPPORTED_MESSAGE)) {
      return errorResult(
        `${message}. Xdebug implements pause only through its control socket, which needs Linux or ` +
        'Windows with Xdebug >= 3.5.0 — on macOS it is never available. Reach a stop another way: ' +
        'set a breakpoint with debug_set_breakpoints, or break on throw with ' +
        'debug_set_exception_breakpoints, then call debug_wait.',
        ErrorCodes.PAUSE_UNSUPPORTED,
      );
    }
    // This handler requires Connected, not Paused — reporting SESSION_NOT_PAUSED
    // for "the session is paused" told the agent the opposite of the truth.
    return toolError(err, { stateCode: ErrorCodes.SESSION_NOT_RUNNING });
  }
}
