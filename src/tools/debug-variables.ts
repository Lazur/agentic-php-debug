import { z } from 'zod';
import type { SessionManager } from '../session.js';
import { SessionState } from '../session.js';
import { successResult, ErrorCodes, type ToolResult } from './types.js';
import { toolError } from './errors.js';
import { assertFreshVariablesReference } from './references.js';
import type { DebugProtocol } from '@vscode/debugprotocol';

export const debugVariablesSchema = z.object({
  variablesReference: z
    .number()
    .int()
    .describe('Variables reference ID (from scopes, evaluate, or another variables response)'),
  filter: z.enum(['indexed', 'named']).optional().describe('Filter to return only indexed or named variables'),
  start: z.number().int().optional().describe('Start index for paged results'),
  count: z.number().int().optional().describe('Number of variables to return for paged results'),
});

export type DebugVariablesInput = z.infer<typeof debugVariablesSchema>;

export const debugVariablesDescription = `Get variables for a scope or object. Returns locals, parameters, superglobals. Use variablesReference to drill into objects/arrays.

Requires the session to be in paused state. The variablesReference comes from debug_scopes (for top-level scopes), debug_evaluate (for expression results), or a previous debug_variables call (for nested objects/arrays).`;

export async function handleDebugVariables(
  session: SessionManager,
  args: z.infer<typeof debugVariablesSchema>,
): Promise<ToolResult> {
  try {
    session.assertState(SessionState.Paused);

    const dapArgs: Record<string, unknown> = {
      variablesReference: args.variablesReference,
    };
    if (args.filter !== undefined) dapArgs.filter = args.filter;
    if (args.start !== undefined) dapArgs.start = args.start;
    if (args.count !== undefined) dapArgs.count = args.count;

    assertFreshVariablesReference(session, args.variablesReference);

    const response = await session.dapClient.sendRequest<DebugProtocol.VariablesResponse>('variables', dapArgs);
    const body = response.body;
    const variables = (body?.variables ?? []).map((v) => ({
      name: v.name,
      value: v.value,
      type: v.type,
      variablesReference: v.variablesReference ?? 0,
      indexedVariables: v.indexedVariables,
      namedVariables: v.namedVariables,
    }));

    session.noteIssuedVariablesReferences(variables.map((v) => v.variablesReference));

    return successResult({
      variables,
      nextAction: 'Drill into nested objects with debug_variables, or call debug_evaluate to test expressions.',
    });
  } catch (err: unknown) {
    return toolError(err, { stateCode: ErrorCodes.SESSION_NOT_PAUSED });
  }
}
