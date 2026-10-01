import type { ZodObject, ZodRawShape } from 'zod';
import type { SessionManager } from '../session.js';
import type { ToolResult } from './types.js';
import type { WaitSignal } from './debug-wait.js';
import { InProcessInvoker, type ToolInvoker } from '../plan/invoker.js';
import type { RunStore } from '../plan/store.js';
import type { PlanSurface } from '../plan/validate.js';

import { debugLaunchSchema, debugLaunchDescription, handleDebugLaunch, type LaunchDeps } from './debug-launch.js';
import { debugTerminateDescription, handleDebugTerminate } from './debug-terminate.js';
import { debugStatusDescription, handleDebugStatus } from './debug-status.js';
import { debugContinueSchema, debugContinueDescription, handleDebugContinue } from './debug-continue.js';
import { debugNextSchema, debugNextDescription, handleDebugNext } from './debug-next.js';
import { debugStepInSchema, debugStepInDescription, handleDebugStepIn } from './debug-step-in.js';
import { debugStepOutSchema, debugStepOutDescription, handleDebugStepOut } from './debug-step-out.js';
import { debugPauseSchema, debugPauseDescription, handleDebugPause } from './debug-pause.js';
import { debugSetBreakpointsSchema, debugSetBreakpointsDescription, handleDebugSetBreakpoints } from './debug-set-breakpoints.js';
import {
  debugSetFunctionBreakpointsSchema,
  debugSetFunctionBreakpointsDescription,
  handleDebugSetFunctionBreakpoints,
} from './debug-set-function-breakpoints.js';
import {
  debugSetExceptionBreakpointsSchema,
  debugSetExceptionBreakpointsDescription,
  handleDebugSetExceptionBreakpoints,
} from './debug-set-exception-breakpoints.js';
import { debugEvaluateSchema, debugEvaluateDescription, handleDebugEvaluate } from './debug-evaluate.js';
import { debugVariablesSchema, debugVariablesDescription, handleDebugVariables } from './debug-variables.js';
import { debugStackTraceSchema, debugStackTraceDescription, handleDebugStackTrace } from './debug-stack-trace.js';
import { debugScopesSchema, debugScopesDescription, handleDebugScopes } from './debug-scopes.js';
import { debugSetVariableSchema, debugSetVariableDescription, handleDebugSetVariable } from './debug-set-variable.js';
import { debugSourceSchema, debugSourceDescription, handleDebugSource } from './debug-source.js';
import { debugThreadsSchema, debugThreadsDescription, handleDebugThreads } from './debug-threads.js';
import { debugExceptionInfoSchema, debugExceptionInfoDescription, handleDebugExceptionInfo } from './debug-exception-info.js';
import {
  debugImportIdeBreakpointsSchema,
  debugImportIdeBreakpointsDescription,
  handleDebugImportIdeBreakpoints,
} from './debug-import-ide-breakpoints.js';
import { debugWaitSchema, debugWaitDescription, handleDebugWait } from './debug-wait.js';
import { debugSnapshotSchema, debugSnapshotDescription, handleDebugSnapshot } from './debug-snapshot.js';
import { debugPlanValidateSchema, debugPlanValidateDescription, handleDebugPlanValidate } from './debug-plan-validate.js';
import { debugPlanRunSchema, debugPlanRunDescription, handleDebugPlanRun } from './debug-plan-run.js';
import { debugPlanReportSchema, debugPlanReportDescription, handleDebugPlanReport } from './debug-plan-report.js';

/** Per-call context a front end can supply. */
export interface ToolContext {
  /** Cancels a blocking tool (debug_wait). */
  signal?: AbortSignal;
  /** MCP progress token, forwarded to tools that report progress (debug_launch). */
  progressToken?: string | number;
  /** Progress sink for long tools (debug_plan_run); absent when the caller asked for none. */
  reportProgress?: (message: string) => void;
}

/**
 * One debug tool: its name, the prose the model reads, its input schema and a
 * runner bound to nothing but a SessionManager.
 *
 * This table is the single list of what the core offers. The MCP server
 * registers it, and the plan runner's in-process invoker calls it — so a plan
 * exercises exactly the handlers an agent does, through the same schemas.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  /** Input schema; undefined for tools that take no arguments. */
  schema?: ZodObject<ZodRawShape>;
  run(session: SessionManager, args: any, ctx: ToolContext): Promise<ToolResult> | ToolResult;
}

export interface CoreToolOptions {
  /** debug_import_ide_breakpoints adds a deprecation notice when true. */
  isVsCodeBackendActive?: boolean;
  /** Passed to debug_status so allowedTools names only registered tools. */
  includeLedgerTools?: boolean;
  /** Test seam for debug_launch's port probe. */
  launchDeps?: LaunchDeps;
}

/** Adapt an AbortSignal to the WaitSignal shape debug_wait expects. */
export function toWaitSignal(signal: AbortSignal | undefined): WaitSignal | undefined {
  if (!signal) return undefined;
  return {
    get aborted() {
      return signal.aborted;
    },
    onAbort: (cb) => signal.addEventListener('abort', cb, { once: true }),
  };
}

/** The 21 core debug tools, in registration order. */
export function coreToolDefinitions(opts: CoreToolOptions = {}): ToolDefinition[] {
  return [
    {
      name: 'debug_launch',
      description: debugLaunchDescription,
      schema: debugLaunchSchema,
      run: (s, a, c) => handleDebugLaunch(s, a, c.progressToken, opts.launchDeps),
    },
    { name: 'debug_terminate', description: debugTerminateDescription, run: (s) => handleDebugTerminate(s) },
    {
      name: 'debug_status',
      description: debugStatusDescription,
      run: (s) => handleDebugStatus(s, { includeLedgerTools: opts.includeLedgerTools }),
    },
    { name: 'debug_continue', description: debugContinueDescription, schema: debugContinueSchema, run: (s, a) => handleDebugContinue(s, a) },
    { name: 'debug_next', description: debugNextDescription, schema: debugNextSchema, run: (s, a) => handleDebugNext(s, a) },
    { name: 'debug_step_in', description: debugStepInDescription, schema: debugStepInSchema, run: (s, a) => handleDebugStepIn(s, a) },
    { name: 'debug_step_out', description: debugStepOutDescription, schema: debugStepOutSchema, run: (s, a) => handleDebugStepOut(s, a) },
    { name: 'debug_pause', description: debugPauseDescription, schema: debugPauseSchema, run: (s, a) => handleDebugPause(s, a) },
    {
      name: 'debug_set_breakpoints',
      description: debugSetBreakpointsDescription,
      schema: debugSetBreakpointsSchema,
      run: (s, a) => handleDebugSetBreakpoints(s, a),
    },
    {
      name: 'debug_set_function_breakpoints',
      description: debugSetFunctionBreakpointsDescription,
      schema: debugSetFunctionBreakpointsSchema,
      run: (s, a) => handleDebugSetFunctionBreakpoints(s, a),
    },
    {
      name: 'debug_set_exception_breakpoints',
      description: debugSetExceptionBreakpointsDescription,
      schema: debugSetExceptionBreakpointsSchema,
      run: (s, a) => handleDebugSetExceptionBreakpoints(s, a),
    },
    { name: 'debug_evaluate', description: debugEvaluateDescription, schema: debugEvaluateSchema, run: (s, a) => handleDebugEvaluate(s, a) },
    { name: 'debug_variables', description: debugVariablesDescription, schema: debugVariablesSchema, run: (s, a) => handleDebugVariables(s, a) },
    {
      name: 'debug_stack_trace',
      description: debugStackTraceDescription,
      schema: debugStackTraceSchema,
      run: (s, a) => handleDebugStackTrace(s, a),
    },
    { name: 'debug_scopes', description: debugScopesDescription, schema: debugScopesSchema, run: (s, a) => handleDebugScopes(s, a) },
    {
      name: 'debug_set_variable',
      description: debugSetVariableDescription,
      schema: debugSetVariableSchema,
      run: (s, a) => handleDebugSetVariable(s, a),
    },
    { name: 'debug_source', description: debugSourceDescription, schema: debugSourceSchema, run: (s, a) => handleDebugSource(s, a) },
    { name: 'debug_threads', description: debugThreadsDescription, schema: debugThreadsSchema, run: (s) => handleDebugThreads(s) },
    {
      name: 'debug_exception_info',
      description: debugExceptionInfoDescription,
      schema: debugExceptionInfoSchema,
      run: (s, a) => handleDebugExceptionInfo(s, a),
    },
    {
      name: 'debug_import_ide_breakpoints',
      description: debugImportIdeBreakpointsDescription,
      schema: debugImportIdeBreakpointsSchema,
      run: (s, a) => handleDebugImportIdeBreakpoints(s, a, opts.isVsCodeBackendActive ?? false),
    },
    {
      name: 'debug_wait',
      description: debugWaitDescription,
      schema: debugWaitSchema,
      run: (s, a, c) => handleDebugWait(s, a, toWaitSignal(c.signal)),
    },
  ];
}

/** The ReAct observation tool: one call for location, frames, watches, locals and a delta. */
export const snapshotToolDefinition: ToolDefinition = {
  name: 'debug_snapshot',
  description: debugSnapshotDescription,
  schema: debugSnapshotSchema,
  run: (s, a) => handleDebugSnapshot(s, a),
};

export interface PlanToolOptions {
  /** Where finished runs are kept for debug_plan_report. */
  store: RunStore;
  /** Base for relative plan paths and for relative probe files of inline plans. */
  baseDir: string;
  /** Whether plans may spawn processes. The MCP server gates this behind a flag. */
  allowCommandTrigger: boolean;
  /** Surface the plan is validated for (default "mcp"). */
  surface?: PlanSurface;
  adapterVersion?: string;
  backend?: string;
  /** What a run executes through; default: the core handlers on the session. */
  invokerFor?: (session: SessionManager) => ToolInvoker;
}

/** debug_plan_validate, debug_plan_run and debug_plan_report. */
export function planToolDefinitions(opts: PlanToolOptions): ToolDefinition[] {
  const invokerFor = opts.invokerFor ?? ((session: SessionManager) => new InProcessInvoker(session));
  const base = { baseDir: opts.baseDir, surface: opts.surface ?? ('mcp' as const), allowCommandTrigger: opts.allowCommandTrigger };
  // What a run can call is what validation must check against.
  const runnableTools = new Set(coreToolDefinitions().map((d) => d.name));
  return [
    {
      name: 'debug_plan_validate',
      description: debugPlanValidateDescription,
      schema: debugPlanValidateSchema,
      run: (_s, a) => handleDebugPlanValidate(a, { ...base, availableTools: runnableTools }),
    },
    {
      name: 'debug_plan_run',
      description: debugPlanRunDescription,
      schema: debugPlanRunSchema,
      run: (s, a, c) =>
        handleDebugPlanRun(a, {
          ...base,
          invoker: invokerFor(s),
          store: opts.store,
          ...(c.signal ? { signal: c.signal } : {}),
          ...(c.reportProgress ? { reportProgress: c.reportProgress } : {}),
          ...(opts.adapterVersion !== undefined ? { adapterVersion: opts.adapterVersion } : {}),
          ...(opts.backend !== undefined ? { backend: opts.backend } : {}),
        }),
    },
    {
      name: 'debug_plan_report',
      description: debugPlanReportDescription,
      schema: debugPlanReportSchema,
      run: (_s, a) => handleDebugPlanReport(a, { store: opts.store }),
    },
  ];
}
