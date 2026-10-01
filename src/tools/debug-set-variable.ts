import { z } from 'zod';
import type { SessionManager } from '../session.js';
import { SessionState } from '../session.js';
import { successResult, ErrorCodes, type ToolResult } from './types.js';
import { toolError } from './errors.js';
import { assertFreshVariablesReference } from './references.js';
import type { DebugProtocol } from '@vscode/debugprotocol';

export const debugSetVariableSchema = z.object({
  variablesReference: z
    .number()
    .int()
    .describe('Variables reference of the container (scope or object) holding the variable'),
  name: z.string().describe('Name of the variable to set'),
  value: z.string().describe('New value for the variable (as a string expression)'),
});

export const debugSetVariableDescription = `Set a variable's value during debugging. Modify variables in the current scope or within objects/arrays.

Requires the session to be in paused state. The variablesReference identifies the container (from debug_scopes or debug_variables). Returns the updated value and type.`;

export async function handleDebugSetVariable(
  session: SessionManager,
  args: z.infer<typeof debugSetVariableSchema>,
): Promise<ToolResult> {
  try {
    session.assertState(SessionState.Paused);

    assertFreshVariablesReference(session, args.variablesReference);

    const response = await session.dapClient.sendRequest<DebugProtocol.SetVariableResponse>('setVariable', {
      variablesReference: args.variablesReference,
      name: args.name,
      value: args.value,
    });
    const body = response.body;
    session.noteIssuedVariablesReferences([body?.variablesReference]);

    return successResult({
      value: body?.value,
      type: body?.type,
      variablesReference: body?.variablesReference ?? 0,
      indexedVariables: body?.indexedVariables,
      namedVariables: body?.namedVariables,
    });
  } catch (err: unknown) {
    return toolError(err, { stateCode: ErrorCodes.SESSION_NOT_PAUSED });
  }
}
