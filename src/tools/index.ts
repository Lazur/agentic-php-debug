import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionManager } from '../session.js';
import type { ToolResult } from './types.js';
import { RunStore } from '../plan/store.js';
import { handleDebugStatus } from './debug-status.js';
import {
  coreToolDefinitions,
  planToolDefinitions,
  snapshotToolDefinition,
  type PlanToolOptions,
  type ToolContext,
  type ToolDefinition,
} from './registry.js';

/**
 * How the server lets an agent debug.
 *
 * - `react` (default): the interactive tools — the agent decides every next step
 *   from the last observation — plus debug_snapshot, and debug_plan_validate so a
 *   finding can be frozen into a plan file.
 * - `plan`: only debug_status and the plan tools. The agent writes a plan up
 *   front and runs it whole; with no step tools registered it cannot revise the
 *   plan mid-run — the mode is enforced by the tool surface, not by a prompt.
 * - `all`: both, for development and for driving plans over MCP tool by tool.
 */
export type ServerMode = 'react' | 'plan' | 'all';
export const SERVER_MODES: readonly ServerMode[] = ['react', 'plan', 'all'];

const PLAN_MODE_TOOLS = new Set(['debug_status', 'debug_plan_validate', 'debug_plan_run', 'debug_plan_report']);
const PLAN_EXECUTION_TOOLS = new Set(['debug_plan_run', 'debug_plan_report']);

export interface RegisterToolsOptions {
  mode?: ServerMode;
  /** debug_import_ide_breakpoints adds a deprecation notice when true (Requirements 3.5, 10.4). */
  isVsCodeBackendActive?: boolean;
  plan?: Partial<PlanToolOptions>;
}

/** Helper to wrap a ToolResult into MCP CallToolResult format. */
function toCallToolResult(result: ToolResult) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    isError: !result.success,
  };
}

/** The tools a server in `mode` exposes, in registration order. */
export function toolDefinitionsForMode(
  mode: ServerMode,
  opts: { isVsCodeBackendActive?: boolean; plan: PlanToolOptions },
): ToolDefinition[] {
  const all = [
    ...coreToolDefinitions({ isVsCodeBackendActive: opts.isVsCodeBackendActive }),
    snapshotToolDefinition,
    ...planToolDefinitions(opts.plan),
  ];
  switch (mode) {
    case 'plan':
      return all.filter((d) => PLAN_MODE_TOOLS.has(d.name));
    case 'react':
      return all.filter((d) => !PLAN_EXECUTION_TOOLS.has(d.name));
    case 'all':
      return all;
  }
}

/**
 * Register the debug tools for a server mode, each wired to the shared
 * SessionManager. Returns the registered names.
 *
 * The third argument used to be the bare isVsCodeBackendActive flag; a boolean
 * is still accepted.
 */
export function registerAllTools(
  server: McpServer,
  session: SessionManager,
  options: boolean | RegisterToolsOptions = {},
): string[] {
  const opts: RegisterToolsOptions = typeof options === 'boolean' ? { isVsCodeBackendActive: options } : options;
  const plan: PlanToolOptions = {
    ...opts.plan,
    store: opts.plan?.store ?? new RunStore(),
    baseDir: opts.plan?.baseDir ?? process.cwd(),
    allowCommandTrigger: opts.plan?.allowCommandTrigger ?? false,
  };
  const defs = toolDefinitionsForMode(opts.mode ?? 'react', {
    isVsCodeBackendActive: opts.isVsCodeBackendActive,
    plan,
  });
  const names = new Set(defs.map((d) => d.name));

  for (const def of defs) {
    // debug_status advises the next tools; it may only name ones registered here.
    const run: ToolDefinition['run'] =
      def.name === 'debug_status' ? (s) => handleDebugStatus(s, { availableTools: names }) : def.run;
    const handler = async (args: Record<string, unknown>, extra: unknown) =>
      toCallToolResult(await run(session, args ?? {}, contextFrom(extra)));

    if (def.schema) server.tool(def.name, def.description, def.schema.shape, handler);
    else server.tool(def.name, def.description, (extra: unknown) => handler({}, extra));
  }
  return [...names];
}

/** Map the MCP SDK's per-request `extra` onto a ToolContext. */
function contextFrom(extra: unknown): ToolContext {
  const e = extra as
    | {
        signal?: AbortSignal;
        _meta?: { progressToken?: string | number };
        sendNotification?: (n: { method: string; params: Record<string, unknown> }) => Promise<void>;
      }
    | undefined;
  const progressToken = e?._meta?.progressToken;
  let progress = 0;
  return {
    ...(e?.signal ? { signal: e.signal } : {}),
    ...(progressToken !== undefined
      ? {
          progressToken,
          reportProgress: (message: string) => {
            if (!e?.sendNotification) return;
            Promise.resolve(
              e.sendNotification({
                method: 'notifications/progress',
                params: { progressToken, progress: ++progress, message },
              }),
            ).catch(() => {});
          },
        }
      : {}),
  };
}
