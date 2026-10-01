import { z } from 'zod';
import { createServer } from 'node:net';
import type { SessionManager } from '../session.js';
import { successResult, errorResult, ErrorCodes, type ToolResult } from './types.js';

export const debugLaunchSchema = z.object({
  stopOnEntry: z.boolean().optional().describe('Override config stopOnEntry setting'),
  port: z.number().int().min(1).max(65535).optional().describe('Override config Xdebug listen port'),
});

export type DebugLaunchInput = z.infer<typeof debugLaunchSchema>;

export const debugLaunchDescription = `Start a PHP debug session with the vscode-php-debug adapter. Call this FIRST before any other debug tools.

Workflow after launching:
1. Read the PHP source code you want to debug
2. Call debug_launch to start the session
3. Set breakpoints with debug_set_breakpoints at key locations
4. Trigger PHP execution (e.g. run the script or hit the endpoint)
5. Call debug_wait to wait for Xdebug to connect and hit a breakpoint
6. Inspect state with debug_stack_trace, debug_variables, debug_evaluate
7. Step through code with debug_next, debug_step_in, debug_step_out
8. Continue with debug_continue or terminate with debug_terminate

Breakpoints can be set at any time after launch. Optional overrides let you change stopOnEntry and port without editing the config file.`;

/** Injectable side effects, so callers under test need no real network. */
export interface LaunchDeps {
  isPortBound(port: number, hostname: string): Promise<boolean>;
}

export const defaultLaunchDeps: LaunchDeps = { isPortBound };

export async function handleDebugLaunch(
  session: SessionManager,
  args: DebugLaunchInput = {},
  progressToken?: string | number,
  deps: LaunchDeps = defaultLaunchDeps,
): Promise<ToolResult> {
  try {
    // A port held by a stale adapter is the common failure here, and the
    // adapter reports it only as a silent failure to listen.
    const port = args.port ?? session.sessionConfig.port;
    const hostname = session.sessionConfig.hostname;
    if (await deps.isPortBound(port, hostname)) {
      return errorResult(
        `Port ${port} on ${hostname} is already in use — most likely an adapter left over from a previous session. ` +
        `Free it (lsof -i :${port}) or launch with a different "port".`,
        ErrorCodes.DAP_ERROR,
      );
    }

    // Overrides are merged inside launch() so they reach the actual launch
    // arguments. The session's injected config object is not mutated.
    const status = await session.launch(progressToken, {
      stopOnEntry: args.stopOnEntry,
      port: args.port,
    });

    // Read back what the session is really running with, so the report cannot
    // drift from the adapter's actual configuration.
    const config = session.sessionConfig;

    return successResult({
      status: status.state,
      port: config.port,
      stopOnEntry: config.stopOnEntry,
      pathMappings: config.pathMappings,
      adapterPid: status.adapterPid,
      message: `Debug session launched, listening on port ${config.port}`,
      nextAction: 'Call debug_wait to wait for Xdebug connection.',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(message, ErrorCodes.DAP_ERROR);
  }
}

/**
 * Check whether something is already listening on the Xdebug port.
 *
 * Only EADDRINUSE counts as bound — any other error (a permission problem, an
 * unresolvable hostname) is not evidence of a conflict, so we let the launch
 * proceed and report the adapter's own failure instead.
 */
function isPortBound(port: number, hostname: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', (err: NodeJS.ErrnoException) => {
      resolve(err.code === 'EADDRINUSE');
    });
    probe.once('listening', () => {
      probe.close(() => resolve(false));
    });
    probe.listen(port, hostname);
  });
}
