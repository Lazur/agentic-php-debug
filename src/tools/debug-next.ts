import { z } from 'zod';
import type { SessionManager } from '../session.js';
import type { ToolResult } from './types.js';
import { runContinuation } from './continuation.js';

export const debugNextSchema = z.object({
  threadId: z
    .number()
    .int()
    .optional()
    .describe('Thread ID to step over on. Defaults to the currently stopped thread.'),
});

export type DebugNextInput = z.infer<typeof debugNextSchema>;

export const debugNextDescription = `Step over — execute current line, pause at next. Use to trace line by line without entering functions.

Requires the session to be in paused state. On success the session moves to "connected" (running) and the previous stack frame and variablesReference ids become invalid. Call debug_wait to block until it pauses again, then re-fetch frames with debug_stack_trace.`;

export async function handleDebugNext(
  session: SessionManager,
  args: z.infer<typeof debugNextSchema>,
): Promise<ToolResult> {
  return runContinuation(session, { command: 'next', pastTense: 'Stepped over' }, args.threadId);
}
