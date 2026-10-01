/**
 * Property-based tests for handleDebugStatus — allowedTools completeness.
 *
 * **Property 7: allowedTools completeness per state**
 * **Validates: Requirements 12.1**
 */
import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { handleDebugStatus, allowedToolsByState } from '../tools/debug-status.js';
import { SessionManager, SessionState, type NotificationSender } from '../session.js';
import type { Config } from '../config.js';
import type { PathMapper } from '../path-mapper.js';

// --- Shared helpers ---

function stubNotifier(): NotificationSender {
  return {
    sendProgress: vi.fn().mockResolvedValue(undefined),
    sendLog: vi.fn().mockResolvedValue(undefined),
    sendDebugEvent: vi.fn().mockResolvedValue(undefined),
  };
}

function stubConfig(): Config {
  return {
    adapterPath: '/fake/adapter.js',
    port: 9003,
    hostname: '127.0.0.1',
    stopOnEntry: false,
    pathMappings: {},
    runtimeExecutable: 'php',
    maxConnections: 0,
    log: false,
  } as Config;
}

function stubPathMapper(): PathMapper {
  return { toRemote: (p: string) => p, toLocal: (p: string) => p } as PathMapper;
}

function createMockBackend() {
  const eventHandlers = new Map<string, Array<(event: any) => void>>();

  const client = {
    onEvent: vi.fn((name: string, handler: (event: any) => void) => {
      const list = eventHandlers.get(name) ?? [];
      list.push(handler);
      eventHandlers.set(name, list);
    }),
    offEvent: vi.fn(),
    onAnyEvent: vi.fn(),
    initialize: vi.fn().mockResolvedValue({}),
    launch: vi.fn().mockResolvedValue({}),
    configurationDone: vi.fn().mockResolvedValue({}),
    sendRequest: vi.fn().mockResolvedValue({}),
    disconnect: vi.fn().mockResolvedValue(undefined),
    waitForEvent: vi.fn().mockResolvedValue({} as any),
    isAlive: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue({ alive: true, pid: 1234 }),
    getSeq: vi.fn().mockReturnValue(1),
    onTrace: null,
    onStderr: null,
  };

  return { client, eventHandlers };
}

// All valid tool names across the system
const ALL_VALID_TOOLS = [
  'debug_launch',
  'debug_status',
  'debug_terminate',
  'debug_wait',
  'debug_set_breakpoints',
  'debug_breakpoints_get',
  'debug_pause',
  'debug_threads',
  'debug_continue',
  'debug_next',
  'debug_step_in',
  'debug_step_out',
  'debug_stack_trace',
  'debug_scopes',
  'debug_variables',
  'debug_evaluate',
  'debug_snapshot',
];

// Tools that require Paused state
const PAUSED_ONLY_TOOLS = [
  'debug_continue',
  'debug_next',
  'debug_step_in',
  'debug_step_out',
  'debug_stack_trace',
  'debug_scopes',
  'debug_variables',
  'debug_evaluate',
  'debug_snapshot',
];

const ALL_STATES = Object.values(SessionState);

describe('Property 7: allowedTools completeness per state', () => {
  /**
   * **Validates: Requirements 12.1**
   *
   * For any SessionState value, calling handleDebugStatus should return a result
   * containing an allowedTools array that is non-empty and contains only valid
   * tool names. Furthermore, tools that require Paused state should not appear
   * in allowedTools when the state is Connected or Listening.
   */
  it('returns non-empty allowedTools with only valid tool names for every state', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ALL_STATES), (state) => {
        // For property testing, we verify the allowedToolsByState map directly
        // since handleDebugStatus just reads session.status.state and looks up the map.
        const tools = allowedToolsByState[state];

        // allowedTools must be non-empty
        expect(tools).toBeDefined();
        expect(tools.length).toBeGreaterThan(0);

        // Every tool in the list must be a valid tool name
        for (const tool of tools) {
          expect(ALL_VALID_TOOLS).toContain(tool);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('paused-only tools do not appear in Connected or Listening states', () => {
    fc.assert(
      fc.property(fc.constantFrom(SessionState.Connected, SessionState.Listening), (state) => {
        const tools = allowedToolsByState[state];

        for (const pausedTool of PAUSED_ONLY_TOOLS) {
          expect(tools).not.toContain(pausedTool);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('handleDebugStatus result includes allowedTools matching the map for any reachable state', async () => {
    // Test with actual handleDebugStatus calls for states we can reach
    // NotStarted is the initial state
    const { client } = createMockBackend();
    const session = new SessionManager(stubConfig(), client as any, stubPathMapper(), stubNotifier());

    const result = handleDebugStatus(session);
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.allowedTools).toEqual(allowedToolsByState[SessionState.NotStarted]);
  });
});
