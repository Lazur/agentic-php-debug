import { z } from 'zod';
import type { SessionManager } from '../session.js';
import { SessionState } from '../session.js';
import { successResult, ErrorCodes, type ToolResult } from './types.js';
import { toolError } from './errors.js';

export const debugThreadsSchema = z.object({});

export type DebugThreadsInput = z.infer<typeof debugThreadsSchema>;

export const debugThreadsDescription = `List all active threads in the debug session. Returns thread IDs and names. Use thread IDs with step/continue commands and debug_stack_trace.

Requires the session to be in connected or paused state.`;

export async function handleDebugThreads(
  session: SessionManager,
  _args?: DebugThreadsInput,
): Promise<ToolResult> {
  try {
    session.assertState(SessionState.Paused, SessionState.Connected);

    const response = await session.dapClient.sendRequest('threads');
    const body = (response as any).body;
    const threads = (body?.threads ?? []).map((t: any) => ({
      id: t.id,
      name: t.name,
    }));

    return successResult({ threads, nextAction: 'Call debug_stack_trace with a threadId to inspect a thread.' });
  } catch (err: unknown) {
    return toolError(err, { stateCode: ErrorCodes.SESSION_NOT_STARTED });
  }
}
