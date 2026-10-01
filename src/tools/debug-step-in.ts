import { z } from 'zod';
import type { SessionManager } from '../session.js';
import type { ToolResult } from './types.js';
import { runContinuation } from './continuation.js';

export const debugStepInSchema = z.object({
  threadId: z.number().int().optional().describe('Thread ID to step into on. Defaults to the currently stopped thread.'),
});

export type DebugStepInInput = z.infer<typeof debugStepInSchema>;

export const debugStepInDescription = `Step into — enter function call on current line. Use when you need to see inside a function.

Requires the session to be in paused state. On success the session moves to "connected" (running) and the previous stack frame and variablesReference ids become invalid. Call debug_wait to block until it pauses again, then re-fetch frames with debug_stack_trace.`;

export async function handleDebugStepIn(
  session: SessionManager,
  args: z.infer<typeof debugStepInSchema>,
): Promise<ToolResult> {
  return runContinuation(session, { command: 'stepIn', pastTense: 'Stepped into' }, args.threadId);
}
