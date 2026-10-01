import { z } from 'zod';
import type { SessionManager } from '../session.js';
import { SessionState } from '../session.js';
import { successResult, ErrorCodes, type ToolResult } from './types.js';
import { toolError } from './errors.js';
import { assertFreshFrameId } from './references.js';
import type { DebugProtocol } from '@vscode/debugprotocol';

export const debugScopesSchema = z.object({
  frameId: z.number().int().describe('Stack frame ID to get scopes for (from debug_stack_trace)'),
});

export type DebugScopesInput = z.infer<typeof debugScopesSchema>;

export const debugScopesDescription = `Get variable scopes for a stack frame. Returns available scopes (locals, globals, superglobals) with their variablesReference values.

Requires the session to be in paused state. Use the frameId from debug_stack_trace. Then use the returned variablesReference with debug_variables to inspect variables in each scope.`;

export async function handleDebugScopes(
  session: SessionManager,
  args: z.infer<typeof debugScopesSchema>,
): Promise<ToolResult> {
  try {
    session.assertState(SessionState.Paused);

    assertFreshFrameId(session, args.frameId);

    const response = await session.dapClient.sendRequest<DebugProtocol.ScopesResponse>('scopes', {
      frameId: args.frameId,
    });
    const body = response.body;
    const scopes = (body?.scopes ?? []).map((scope) => ({
      name: scope.name,
      variablesReference: scope.variablesReference,
      namedVariables: scope.namedVariables,
      indexedVariables: scope.indexedVariables,
      expensive: scope.expensive,
    }));

    session.noteIssuedVariablesReferences(scopes.map((sc) => sc.variablesReference));

    return successResult({
      scopes,
      nextAction: 'Call debug_variables with a variablesReference to inspect scope contents.',
    });
  } catch (err: unknown) {
    return toolError(err, { stateCode: ErrorCodes.SESSION_NOT_PAUSED });
  }
}
