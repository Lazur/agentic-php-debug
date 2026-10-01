import { z } from 'zod';
import type { SessionManager } from '../session.js';
import type { ToolResult } from './types.js';
import { runContinuation } from './continuation.js';

export const debugContinueSchema = z.object({
  threadId: z
    .number()
    .int()
    .optional()
    .describe('Thread ID to continue execution on. Defaults to the currently stopped thread.'),
});

export type DebugContinueInput = z.infer<typeof debugContinueSchema>;

export const debugContinueDescription = `Continue running until next breakpoint. Use after inspecting state at current breakpoint.

Requires the session to be in paused state. On success the session moves to "connected" (running) and the previous stack frame and variablesReference ids become invalid. Call debug_wait to block until the next stop.`;

export async function handleDebugContinue(
  session: SessionManager,
  args: z.infer<typeof debugContinueSchema>,
): Promise<ToolResult> {
  return runContinuation(session, { command: 'continue', pastTense: 'Continued execution' }, args.threadId);
}
