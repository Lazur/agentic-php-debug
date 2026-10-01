import { z } from 'zod';
import type { SessionManager } from '../session.js';
import { SessionState } from '../session.js';
import { successResult, errorResult, ErrorCodes, type ToolResult } from './types.js';
import { toolError } from './errors.js';
import { ambiguousThreadNote, resolveStoppedThreadId } from './thread-resolution.js';

export const debugStackTraceSchema = z.object({
  threadId: z.number().int().optional().describe('Thread ID to get the stack trace for. Defaults to the currently stopped thread.'),
  startFrame: z.number().int().optional().describe('Start frame index for paged results'),
  levels: z.number().int().optional().describe('Maximum number of frames to return'),
});

export type DebugStackTraceInput = z.infer<typeof debugStackTraceSchema>;

export const debugStackTraceDescription = `Get call stack when paused. Shows the chain of calls to current location. Each frame has an ID — use with debug_scopes/debug_evaluate to inspect that frame's context.

Requires the session to be in paused state. Source file paths in the response are automatically mapped from remote to local paths.`;

export async function handleDebugStackTrace(
  session: SessionManager,
  args: z.infer<typeof debugStackTraceSchema>,
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

    const dapArgs: Record<string, unknown> = {
      threadId: resolved.threadId,
    };
    if (args.startFrame !== undefined) dapArgs.startFrame = args.startFrame;
    if (args.levels !== undefined) dapArgs.levels = args.levels;

    const response = await session.dapClient.sendRequest('stackTrace', dapArgs);
    const body = (response as any).body;
    const stackFrames = (body?.stackFrames ?? []).map((frame: any) => ({
      id: frame.id,
      name: frame.name,
      source: frame.source ? {
        name: frame.source.name,
        path: frame.source.path ? session.pathMapper.toLocal(frame.source.path) : undefined,
        sourceReference: frame.source.sourceReference,
      } : undefined,
      line: frame.line,
      column: frame.column,
      endLine: frame.endLine,
      endColumn: frame.endColumn,
    }));

    // DAP: object references live only for the current suspended state. Record
    // what we hand out so a later reuse can be rejected instead of silently
    // resolving against a different stack.
    session.noteIssuedFrameIds(stackFrames.map((f: any) => f.id));

    return successResult({
      ...(resolved.ambiguous ? { warning: ambiguousThreadNote(session, resolved.threadId) } : {}),
      threadId: resolved.threadId,
      stackFrames,
      totalFrames: body?.totalFrames,
      nextAction: 'Call debug_scopes with a frameId to inspect variables.',
    });
  } catch (err: unknown) {
    return toolError(err, { stateCode: ErrorCodes.SESSION_NOT_PAUSED });
  }
}
