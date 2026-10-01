import { z } from 'zod';
import type { SessionManager } from '../session.js';
import { SessionState } from '../session.js';
import { DAPTimeoutError } from '../dap-client.js';
import { successResult, errorResult, ErrorCodes, type ToolResult } from './types.js';
import { toolError } from './errors.js';
import { assertFreshFrameId } from './references.js';

export const debugEvaluateSchema = z.object({
  expression: z.string().describe('PHP expression to evaluate (e.g. "$user->getRoles()", "count($items)")'),
  frameId: z.number().int().optional().describe('Stack frame ID to evaluate in (defaults to top frame)'),
  context: z.enum(['watch', 'repl', 'hover']).optional().describe('DAP evaluation context'),
  timeout: z.number().int().min(1).optional().describe('Max milliseconds to wait for the result (default: 30000)'),
});

export type DebugEvaluateInput = z.infer<typeof debugEvaluateSchema>;

export const debugEvaluateDescription = `Evaluate PHP expression in paused context. Examples: '$user->getRoles()', 'count($items)', '$request->getMethod()'. Use to test hypotheses about bugs.

Requires the session to be in paused state. Use frameId from debug_stack_trace to evaluate in a specific stack frame's context. Returns the result value, type, and a variablesReference for drilling into objects/arrays.

For an expression that may be slow — anything reaching into a service container, a query, or the filesystem — pass an explicit "timeout" below your PHP-FPM/web-server read timeout. A DAP_TIMEOUT error then tells you the expression itself was too slow, rather than leaving it indistinguishable from the request being killed underneath you. Note the expression keeps running in the target after a timeout; call debug_status to check the session survived.`;

export async function handleDebugEvaluate(
  session: SessionManager,
  args: DebugEvaluateInput,
): Promise<ToolResult> {
  try {
    session.assertState(SessionState.Paused);

    // The adapter rejects an evaluate with no frameId ("Cannot evaluate code
    // without a connection"), so resolve the top frame when the caller omits it.
    // Only an explicitly-supplied frameId can be stale — one we resolve
    // ourselves is minted from the current stack a line below.
    if (args.frameId !== undefined) assertFreshFrameId(session, args.frameId);

    const frameId = args.frameId ?? (await resolveTopFrameId(session));
    if (frameId === undefined) {
      return errorResult(
        'No stack frame available to evaluate in. Call debug_stack_trace and pass an explicit frameId.',
        ErrorCodes.DAP_ERROR,
      );
    }

    const dapArgs: Record<string, unknown> = {
      expression: args.expression,
      context: args.context ?? 'repl',
      frameId,
    };

    const response = await session.dapClient.sendRequest('evaluate', dapArgs, args.timeout);
    const body = (response as any).body;
    session.noteIssuedVariablesReferences([body?.variablesReference]);

    // resolveTopFrameId() picks whichever thread stopInfo names, which is
    // arbitrary when several are suspended at once.
    const suspended = session.status.stoppedThreads;
    const ambiguousThread = args.frameId === undefined && suspended.length > 1;

    return successResult({
      ...(ambiguousThread
        ? {
            warning:
              `${suspended.length} threads are suspended (ids ${suspended.map((t) => t.threadId).join(', ')}) ` +
              `and no frameId was given, so this evaluated in thread ${session.stopInfo?.threadId} — ` +
              'the one that stopped most recently. Pass an explicit frameId from debug_stack_trace to choose.',
          }
        : {}),
      result: body?.result,
      type: body?.type,
      variablesReference: body?.variablesReference ?? 0,
      indexedVariables: body?.indexedVariables,
      namedVariables: body?.namedVariables,
      nextAction: 'Continue inspecting or call debug_continue to resume execution.',
    });
  } catch (err: unknown) {
    // Not delegated to toolError: the generic text says "executing", which is
    // wrong here. A timed-out evaluate leaves an expression running in the
    // target, and that distinction is what tells the agent whether to retry.
    if (err instanceof DAPTimeoutError) {
      return errorResult(
        `${err.message}. The expression was abandoned but the target may still be evaluating it, so the session state may be stale. ` +
        'Call debug_status to check the session survived. If the target itself is slow, retry with a larger timeout; ' +
        'if this timeout is already above your PHP-FPM read timeout, the request was likely killed underneath the debugger.',
        ErrorCodes.DAP_TIMEOUT,
      );
    }
    return toolError(err, { stateCode: ErrorCodes.SESSION_NOT_PAUSED });
  }
}

/** Fetch the id of the topmost stack frame of the stopped thread, if there is one. */
async function resolveTopFrameId(session: SessionManager): Promise<number | undefined> {
  const threadId = session.stopInfo?.threadId;
  if (threadId === undefined) return undefined;
  const response = await session.dapClient.sendRequest('stackTrace', { threadId, levels: 1 });
  const id = (response as any).body?.stackFrames?.[0]?.id;
  session.noteIssuedFrameIds([id]);
  return id;
}
