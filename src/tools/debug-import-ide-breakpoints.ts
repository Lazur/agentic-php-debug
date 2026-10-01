import { z } from 'zod';
import type { SessionManager } from '../session.js';
import { successResult, type ToolResult } from './types.js';

const breakpointInputSchema = z.object({
  file: z.string().describe('Source file path (local)'),
  line: z.number().int().describe('Line number'),
  condition: z.string().optional().describe('Optional condition expression'),
});

export const debugImportIdeBreakpointsSchema = z.object({
  breakpoints: z.array(breakpointInputSchema).describe('Array of IDE breakpoints to import'),
});

export const debugImportIdeBreakpointsDescription =
  `Import breakpoints from the IDE into the debug session. ` +
  `Use this to capture breakpoints the user has set in their editor ` +
  `so the agent is aware of them.`;

/**
 * Handle debug_import_ide_breakpoints tool call.
 *
 * When isVsCodeBackendActive is true, the tool still functions but
 * includes a deprecation notice that automatic sync is active.
 *
 * Requirements: 3.5, 10.4
 */
export async function handleDebugImportIdeBreakpoints(
  session: SessionManager,
  args: z.infer<typeof debugImportIdeBreakpointsSchema>,
  isVsCodeBackendActive: boolean,
): Promise<ToolResult> {
  const imported = args.breakpoints.map((bp) => ({
    file: bp.file,
    line: bp.line,
    condition: bp.condition,
  }));

  const notice = isVsCodeBackendActive
    ? 'Note: VS Code Debug Bridge is active — IDE breakpoints are automatically synchronized. This tool is no longer required.'
    : undefined;

  return successResult({
    imported: imported.length,
    breakpoints: imported,
    ...(notice ? { notice } : {}),
  });
}
