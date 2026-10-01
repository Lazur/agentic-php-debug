import type { SessionManager } from '../session.js';
import { successResult, errorResult, ErrorCodes, type ToolResult } from './types.js';

export const debugTerminateDescription = `Terminate the current PHP debug session. Sends a DAP disconnect request and cleans up the adapter process.

Call this when you are done debugging or want to restart with a fresh session. After termination, you can call debug_launch again to start a new session.`;

export async function handleDebugTerminate(session: SessionManager): Promise<ToolResult> {
  try {
    await session.terminate();
    return successResult({
      status: 'terminated',
      message: 'Debug session terminated successfully',
      nextAction: 'Session ended. Call debug_launch to start a new session.',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(message, ErrorCodes.DAP_ERROR);
  }
}
