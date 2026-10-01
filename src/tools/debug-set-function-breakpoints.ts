import { z } from 'zod';
import type { SessionManager } from '../session.js';
import { SessionState } from '../session.js';
import { describeBreakpoints, detectStateMismatch } from '../breakpoint-verification.js';
import { successResult, ErrorCodes, type ToolResult } from './types.js';
import { toolError } from './errors.js';
import type { DebugProtocol } from '@vscode/debugprotocol';

const functionBreakpointSchema = z.object({
  name: z.string().describe('Function name to break on'),
  condition: z.string().optional().describe('Optional condition expression'),
  hitCondition: z.string().optional().describe('Optional hit count expression'),
});

export const debugSetFunctionBreakpointsSchema = z.object({
  breakpoints: z.array(functionBreakpointSchema).describe('Array of function breakpoint specifications'),
});

export const debugSetFunctionBreakpointsDescription = `Set function breakpoints (replaces all existing function breakpoints). Break on entry to named functions regardless of file.

Each call replaces ALL function breakpoints. To clear, call with an empty array. Prefer listening or paused state: a write made while "connected" (PHP running) is staged by the adapter and not sent until execution next pauses. Read each breakpoint's "verification" status rather than assuming the write landed.`;

export async function handleDebugSetFunctionBreakpoints(
  session: SessionManager,
  args: z.infer<typeof debugSetFunctionBreakpointsSchema>,
): Promise<ToolResult> {
  try {
    session.assertState(SessionState.Listening, SessionState.Connected, SessionState.Paused);

    const dapArgs = {
      breakpoints: args.breakpoints.map((bp) => ({
        name: bp.name,
        ...(bp.condition !== undefined ? { condition: bp.condition } : {}),
        ...(bp.hitCondition !== undefined ? { hitCondition: bp.hitCondition } : {}),
      })),
    };

    const stateAtWrite = session.state;
    const response = await session.dapClient.sendRequest<DebugProtocol.SetFunctionBreakpointsResponse>(
      'setFunctionBreakpoints',
      dapArgs,
    );
    const body = response.body;
    const breakpoints = body?.breakpoints ?? [];

    const staged = stateAtWrite === SessionState.Connected;
    const mismatch = detectStateMismatch(breakpoints, stateAtWrite);

    return successResult({
      queued: false,
      applied: !staged,
      breakpoints: describeBreakpoints(breakpoints, session),
      message: `Set ${breakpoints.length} function breakpoint(s)`,
      ...(staged
        ? {
            nextAction: 'Call debug_wait to reach a pause — these are not active until then.',
            warning:
              'NOT applied. The adapter stages breakpoint writes while PHP is running and does not send them until execution next pauses.',
          }
        : {}),
      ...(mismatch ? { stateWarning: mismatch } : {}),
    });
  } catch (err: unknown) {
    return toolError(err, { stateCode: ErrorCodes.SESSION_NOT_STARTED });
  }
}
