import { z } from 'zod';
import type { SessionManager } from '../session.js';
import { SessionState } from '../session.js';
import { successResult, ErrorCodes, type ToolResult } from './types.js';
import { toolError } from './errors.js';

export const debugSourceSchema = z.object({
  sourceReference: z.number().int().describe('Source reference ID from a stack frame source object'),
  source: z.object({
    path: z.string().optional(),
    sourceReference: z.number().int().optional(),
  }).optional().describe('Optional source descriptor with path or sourceReference'),
});

export const debugSourceDescription = `Retrieve source code content by source reference. Use when a stack frame has a sourceReference instead of a file path (e.g., for dynamically evaluated code).

Requires the session to be in paused or connected state.`;

export async function handleDebugSource(
  session: SessionManager,
  args: z.infer<typeof debugSourceSchema>,
): Promise<ToolResult> {
  try {
    session.assertState(SessionState.Paused, SessionState.Connected);

    const dapArgs: Record<string, unknown> = {
      sourceReference: args.sourceReference,
    };
    if (args.source !== undefined) {
      dapArgs.source = args.source;
    }

    const response = await session.dapClient.sendRequest('source', dapArgs);
    const body = (response as any).body;

    return successResult({
      content: body?.content ?? '',
      mimeType: body?.mimeType,
    });
  } catch (err: unknown) {
    return toolError(err, { stateCode: ErrorCodes.SESSION_NOT_STARTED });
  }
}
