import { z } from 'zod';
import type { SessionManager } from '../session.js';
import { SessionState } from '../session.js';
import { successResult, errorResult, ErrorCodes, type ToolResult } from './types.js';
import { toolError } from './errors.js';
import { resolveStoppedThreadId } from './thread-resolution.js';
import type { DebugProtocol } from '@vscode/debugprotocol';

export const debugExceptionInfoSchema = z.object({
  threadId: z
    .number()
    .int()
    .optional()
    .describe('Thread ID to get exception info for. Defaults to the currently stopped thread.'),
});

export type DebugExceptionInfoInput = z.infer<typeof debugExceptionInfoSchema>;

export const debugExceptionInfoDescription = `Get exception details when stopped on an exception. Returns the exception ID, description, and break mode. Use after debug_status shows a stop reason of "exception".

Requires the session to be in paused state.`;

export async function handleDebugExceptionInfo(
  session: SessionManager,
  args: z.infer<typeof debugExceptionInfoSchema>,
): Promise<ToolResult> {
  try {
    session.assertState(SessionState.Paused);

    const resolved = resolveStoppedThreadId(session, args.threadId);
    if (!resolved) {
      return errorResult(
        'threadId is required — no thread is currently suspended. Call debug_status to see session state.',
        ErrorCodes.INVALID_PARAMS,
      );
    }

    const response = await session.dapClient.sendRequest<DebugProtocol.ExceptionInfoResponse>('exceptionInfo', {
      threadId: resolved.threadId,
    });
    const body = response.body;

    return successResult({
      exceptionId: body?.exceptionId,
      description: body?.description,
      breakMode: body?.breakMode,
      details: body?.details,
    });
  } catch (err: unknown) {
    return toolError(err, { stateCode: ErrorCodes.SESSION_NOT_PAUSED });
  }
}
