import { z } from 'zod';
import type { SessionManager } from '../session.js';
import { SessionState } from '../session.js';
import { describeBreakpoints, detectStateMismatch } from '../breakpoint-verification.js';
import { successResult, ErrorCodes, type ToolResult } from './types.js';
import { toolError } from './errors.js';

export const debugSetExceptionBreakpointsSchema = z.object({
  filters: z.array(z.string()).describe('Array of exception filter IDs (e.g. "Notice", "Warning", "Exception", "*")'),
});

export type DebugSetExceptionBreakpointsInput = z.infer<typeof debugSetExceptionBreakpointsSchema>;

export const debugSetExceptionBreakpointsDescription = `Set exception breakpoints by filter ID. Controls which exceptions cause the debugger to pause.

Common filters for PHP/Xdebug: "Notice", "Warning", "Exception", "*" (all exceptions). Each call replaces all exception breakpoints. Prefer listening or paused state: a write made while "connected" (PHP running) is staged by the adapter and not sent until execution next pauses. Read each breakpoint's "verification" status rather than assuming the write landed.`;

export async function handleDebugSetExceptionBreakpoints(
  session: SessionManager,
  args: z.infer<typeof debugSetExceptionBreakpointsSchema>,
): Promise<ToolResult> {
  try {
    session.assertState(
      SessionState.Listening,
      SessionState.Connected,
      SessionState.Paused,
    );

    const dapArgs = {
      filters: args.filters,
    };

    const stateAtWrite = session.state;
    const response = await session.dapClient.sendRequest('setExceptionBreakpoints', dapArgs);
    const body = (response as any).body;
    const breakpoints = body?.breakpoints ?? [];

    const staged = stateAtWrite === SessionState.Connected;
    const mismatch = detectStateMismatch(breakpoints, stateAtWrite);

    return successResult({
      queued: false,
      applied: !staged,
      filters: args.filters,
      breakpoints: describeBreakpoints(breakpoints, session),
      message: `Set exception breakpoints with ${args.filters.length} filter(s)`,
      ...(staged
        ? {
            nextAction: 'Call debug_wait to reach a pause — these are not active until then.',
            warning: 'NOT applied. The adapter stages breakpoint writes while PHP is running and does not send them until execution next pauses.',
          }
        : {}),
      ...(mismatch ? { stateWarning: mismatch } : {}),
    });
  } catch (err: unknown) {
    return toolError(err, { stateCode: ErrorCodes.SESSION_NOT_STARTED });
  }
}
