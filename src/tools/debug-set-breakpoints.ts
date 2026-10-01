import { z } from 'zod';
import type { SessionManager } from '../session.js';
import { SessionState } from '../session.js';
import { describeBreakpoints, detectStateMismatch } from '../breakpoint-verification.js';
import { successResult, ErrorCodes, type ToolResult } from './types.js';
import { toolError } from './errors.js';

const breakpointSpecSchema = z.object({
  line: z.number().int().describe('Line number for the breakpoint'),
  condition: z.string().optional().describe('Optional condition expression'),
  hitCondition: z.string().optional().describe('Optional hit count expression'),
  logMessage: z.string().optional().describe('Optional log message (logpoint)'),
});

export const debugSetBreakpointsSchema = z.object({
  path: z.string().describe('Source file path (local) to set breakpoints in'),
  breakpoints: z.array(breakpointSpecSchema).describe('Array of breakpoint specifications'),
});

export type DebugSetBreakpointsInput = z.infer<typeof debugSetBreakpointsSchema>;

export const debugSetBreakpointsDescription = `Set breakpoints in a file (replaces all existing breakpoints in that file). STRATEGY: Read source first to identify key locations — function entries, conditionals, error handlers. Set multiple across the call chain.

Each call replaces ALL breakpoints in the specified file. To clear breakpoints, call with an empty array. Supports conditional breakpoints and logpoints. File paths are automatically mapped to remote paths if path mappings are configured.

HIT COUNT CAVEAT: because each call replaces every breakpoint in the file, and the adapter implements that replacement as remove + set against Xdebug rather than a DBGp breakpoint_update, EVERY hit counter in the file resets to zero — including on breakpoints you re-send byte-identical. Do not re-send a file's breakpoints while relying on an accumulated hitCondition count.

WHEN TO CALL: prefer listening state (before triggering PHP) or paused state — writes made then take effect. A write made while the session is "connected" (PHP running) is staged by the adapter and NOT sent until execution next pauses; the file's previous breakpoints stay live until then. Each returned breakpoint carries a "verification" status saying which case applies — read it rather than assuming the write landed.`;

export async function handleDebugSetBreakpoints(
  session: SessionManager,
  args: z.infer<typeof debugSetBreakpointsSchema>,
): Promise<ToolResult> {
  try {
    session.assertState(
      SessionState.Listening,
      SessionState.Connected,
      SessionState.Paused,
    );

    const remotePath = session.pathMapper.toRemote(args.path);
    const dapArgs = {
      source: { path: remotePath },
      breakpoints: args.breakpoints.map((bp) => ({
        line: bp.line,
        ...(bp.condition !== undefined ? { condition: bp.condition } : {}),
        ...(bp.hitCondition !== undefined ? { hitCondition: bp.hitCondition } : {}),
        ...(bp.logMessage !== undefined ? { logMessage: bp.logMessage } : {}),
      })),
    };

    // Send immediately, including while listening. The adapter's breakpoint
    // manager stores breakpoints independently of Xdebug connections and
    // applies them to each new one, so they must be registered BEFORE a
    // connection arrives — deferring until the 'thread' event races the
    // request, which usually finishes before the deferred send round-trips.
    const stateAtWrite = session.state;
    const response = await session.dapClient.sendRequest('setBreakpoints', dapArgs);
    const body = (response as any).body;
    const breakpoints = body?.breakpoints ?? [];

    const staged = stateAtWrite === SessionState.Connected;
    const nextAction = staged
      ? 'Call debug_wait to reach a pause — these breakpoints are not active until then.'
      : stateAtWrite === SessionState.Listening
        ? 'Trigger PHP execution, then call debug_wait to wait for a breakpoint hit.'
        : 'Call debug_continue or trigger PHP execution to hit breakpoints.';

    const mismatch = detectStateMismatch(breakpoints, stateAtWrite);

    // The adapter replaces breakpoints via remove + set rather than DBGp
    // breakpoint_update, so Xdebug destroys and recreates each one and its
    // hit_count restarts at zero. Only worth saying when a hit count is in play.
    const usesHitCondition = args.breakpoints.some((bp) => bp.hitCondition !== undefined);

    return successResult({
      path: args.path,
      queued: false,
      applied: !staged,
      breakpoints: describeBreakpoints(breakpoints, session),
      message: `Set ${breakpoints.length} breakpoint(s) in ${args.path}`,
      nextAction,
      ...(staged
        ? {
            warning:
              'NOT applied. The adapter stages breakpoint writes while PHP is running and does not send them until execution next pauses. ' +
              `The previous breakpoints in ${args.path} are still live and will keep firing until then.`,
          }
        : {}),
      ...(mismatch ? { stateWarning: mismatch } : {}),
      ...(usesHitCondition
        ? {
            hitConditionWarning:
              'Hit counters for every breakpoint in this file just reset to zero. This call ' +
              'replaced them all, and the adapter applies a replacement as remove + set against ' +
              'Xdebug rather than a DBGp breakpoint_update, so no hit count survives — not even ' +
              'for breakpoints re-sent unchanged.',
          }
        : {}),
    });
  } catch (err: unknown) {
    return toolError(err, { stateCode: ErrorCodes.SESSION_NOT_STARTED });
  }
}
