import { z } from 'zod';
import type { SessionManager } from '../session.js';
import type { ToolResult } from './types.js';
import { runContinuation } from './continuation.js';

export const debugStepOutSchema = z.object({
  threadId: z.number().int().optional().describe('Thread ID to step out on. Defaults to the currently stopped thread.'),
});

export type DebugStepOutInput = z.infer<typeof debugStepOutSchema>;

export const debugStepOutDescription = `Step out — run until current function returns. Use when done inspecting this function.

Requires the session to be in paused state. On success the session moves to "connected" (running) and the previous stack frame and variablesReference ids become invalid. Call debug_wait to block until it pauses in the calling function, then re-fetch frames with debug_stack_trace.`;

export async function handleDebugStepOut(
  session: SessionManager,
  args: z.infer<typeof debugStepOutSchema>,
): Promise<ToolResult> {
  return runContinuation(session, { command: 'stepOut', pastTense: 'Stepped out' }, args.threadId);
}
