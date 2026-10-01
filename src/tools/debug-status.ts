import type { SessionManager } from '../session.js';
import { SessionState } from '../session.js';
import { successResult, type ToolResult } from './types.js';

export const debugStatusDescription = `Get the current debug session state and pending events. Call AFTER triggering PHP execution to detect when Xdebug connects and hits a breakpoint.

State guide:
- not_started: No session active. Call debug_launch first.
- initializing: Session is starting up. Wait and check again.
- listening: Adapter is ready, waiting for Xdebug connection. Trigger your PHP script now.
- connected: Xdebug connected, execution is running. Set breakpoints, or call debug_wait to wait for the next stop. (debug_pause needs Xdebug's control socket — Linux/Windows with Xdebug >= 3.5.0 only, never macOS.)
- paused: Execution stopped at a breakpoint or step. Inspect with debug_stack_trace, debug_variables, debug_evaluate. Step with debug_next, debug_step_in, debug_step_out. Resume with debug_continue.
- terminated: Session ended. Call debug_launch to start a new session.

Also returns recentOutput: the tail of the adapter's output channel (PHP stdout/stderr, xdebug_notify, and the adapter's own messages). Both backends forward the adapter's DAP output events, so this reflects what the adapter actually reported.`;

export const allowedToolsByState: Record<string, string[]> = {
  [SessionState.NotStarted]: ['debug_launch'],
  [SessionState.Initializing]: ['debug_status', 'debug_terminate'],
  [SessionState.Listening]: ['debug_set_breakpoints', 'debug_breakpoints_get', 'debug_terminate', 'debug_wait', 'debug_status'],
  // debug_pause is deliberately absent: Xdebug can only honour it through its
  // control socket (Linux/Windows + Xdebug >= 3.5.0), so advertising it here
  // steered the agent into a call that always fails on macOS.
  [SessionState.Connected]: ['debug_threads', 'debug_set_breakpoints', 'debug_breakpoints_get', 'debug_terminate', 'debug_wait', 'debug_status'],
  [SessionState.Paused]: ['debug_continue', 'debug_next', 'debug_step_in', 'debug_step_out', 'debug_snapshot', 'debug_stack_trace', 'debug_scopes', 'debug_variables', 'debug_evaluate', 'debug_threads', 'debug_set_breakpoints', 'debug_breakpoints_get', 'debug_terminate', 'debug_wait', 'debug_status'],
  [SessionState.Terminated]: ['debug_launch'],
};

/**
 * Coupled to vscode-php-debug's exact wording (phpDebug.ts:1351/1379/1405/1431).
 * If upstream rewords it we degrade to silence — never to a false alarm.
 */
const CONTINUATION_FAILURE_RE = /(continue|next|stepIn|stepOut)Request thread ID \d+ error:/;

const stateGuidance: Record<string, string> = {
  [SessionState.NotStarted]: 'No active session. Call debug_launch to start debugging.',
  [SessionState.Initializing]: 'Session is initializing. Wait a moment and check status again.',
  [SessionState.Listening]: 'Adapter is listening for Xdebug connections. Trigger your PHP script to connect.',
  [SessionState.Connected]: 'Xdebug is connected and running. Set breakpoints, then call debug_wait to wait for the next stop. Pausing a running target needs Xdebug >= 3.5.0 on Linux or Windows and is unavailable on macOS.',
  [SessionState.Paused]: 'Execution is paused. Use debug_stack_trace, debug_variables, debug_evaluate to inspect. Use debug_next, debug_step_in, debug_step_out to step. Use debug_continue to resume.',
  [SessionState.Terminated]: 'Session has ended. Call debug_launch to start a new session.',
};

/** Which front end is asking, so allowedTools only names tools it registered. */
export interface DebugStatusOptions {
  /**
   * Include debug_breakpoints_get, which reads the BreakpointLedger. Only the
   * VS Code extension registers it — the MCP server never builds a ledger, so
   * advertising it there sends the agent after a tool that does not exist.
   */
  includeLedgerTools?: boolean;
  /**
   * Tools the front end actually registered. When given, allowedTools is
   * narrowed to them, and the plan-mode entry points are offered while no
   * session is running — so a server in `--mode plan` advertises the plan
   * tools, not step tools it never registered.
   */
  availableTools?: ReadonlySet<string>;
}

/** Plan-mode entry points: usable whenever no session is running. */
export const IDLE_PLAN_TOOLS = ['debug_plan_run', 'debug_plan_validate', 'debug_plan_report'];

export function handleDebugStatus(
  session: SessionManager,
  opts: DebugStatusOptions = {},
): ToolResult {
  const status = session.status;

  // Append the conditions the base guidance can't know about: breakpoint writes
  // the adapter is holding, and a request whose outcome we never learned.
  const notes: string[] = [stateGuidance[status.state] ?? 'Unknown state.'];
  if (status.stagedBreakpointIds.length > 0) {
    notes.push(
      `${status.stagedBreakpointIds.length} breakpoint write(s) are staged but NOT active — the adapter applies them when execution next pauses, and the previous breakpoints keep firing until then.`,
    );
  }
  if (status.stoppedThreads.length > 1) {
    const ids = status.stoppedThreads.map((t) => t.threadId).join(', ');
    notes.push(
      `${status.stoppedThreads.length} threads are suspended (ids ${ids}). vscode-php-debug maps one ` +
      'Xdebug connection to one "thread" and every stop carries allThreadsStopped:false, so resuming ' +
      'one does NOT resume the others. This server keeps a single session state, so "paused" here ' +
      'means at least one thread is suspended — pass an explicit threadId to every continue/step/stackTrace call.',
    );
  }
  if (status.liveThreadIds.length > 1) {
    notes.push(
      `${status.liveThreadIds.length} Xdebug connections are live. Parallel requests (AJAX, queue workers) ` +
      'each get their own connection; set maxConnections: 1 in the launch config to have the adapter ' +
      'reject the extras instead of interleaving them.',
    );
  }
  const continuationFailure = status.recentOutput.find((o) => CONTINUATION_FAILURE_RE.test(o.output));
  if (continuationFailure) {
    notes.push(
      `The adapter reported a FAILED continuation command on its output channel: ` +
      `"${continuationFailure.output.trim()}". vscode-php-debug sends the DAP response for ` +
      'continue/next/stepIn/stepOut before issuing the DBGp command, so the success you received ' +
      'did not mean the target resumed — it is most likely still suspended where it was. Call ' +
      'debug_wait (it returns immediately if so), re-issue the command, or debug_terminate and relaunch.',
    );
  }
  if (status.lastRequestTimeout) {
    notes.push(
      `A "${status.lastRequestTimeout.command}" request timed out after ${status.lastRequestTimeout.timeoutMs}ms and was abandoned; the target may still be executing it, so this state may be stale.`,
    );
  }

  return successResult({
    ...status,
    guidance: notes.join(' '),
    allowedTools: allowedToolsFor(status.state, opts),
  });
}

/**
 * The tool names a caller in this state should consider next, narrowed to the
 * ones the asking front end actually registered.
 */
export function allowedToolsFor(
  state: string,
  opts: DebugStatusOptions = {},
): string[] {
  let tools = [...(allowedToolsByState[state] ?? [])];
  if (opts.availableTools) {
    if (state === SessionState.NotStarted || state === SessionState.Terminated) tools.push(...IDLE_PLAN_TOOLS);
    tools = tools.filter((name) => opts.availableTools!.has(name));
  }
  if (opts.includeLedgerTools) return tools;
  return tools.filter((name) => !LEDGER_ONLY_TOOLS.has(name));
}

/** Tools backed by the BreakpointLedger, which only the VS Code extension owns. */
const LEDGER_ONLY_TOOLS = new Set(['debug_breakpoints_get']);
