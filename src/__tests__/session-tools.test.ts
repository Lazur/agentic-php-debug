import { describe, it, expect, vi } from 'vitest';
import { handleDebugLaunch } from '../tools/debug-launch.js';
import { handleDebugTerminate } from '../tools/debug-terminate.js';
import { handleDebugStatus } from '../tools/debug-status.js';
import { SessionManager, SessionState, type NotificationSender } from '../session.js';
import type { DAPClient } from '../dap-client.js';
import type { PathMapper } from '../path-mapper.js';
import type { Config } from '../config.js';
import type { DebugProtocol } from '@vscode/debugprotocol';
import { ErrorCodes } from '../tools/types.js';

// --- Shared helpers ---

function stubNotifier(): NotificationSender {
  return {
    sendProgress: vi.fn().mockResolvedValue(undefined),
    sendLog: vi.fn().mockResolvedValue(undefined),
    sendDebugEvent: vi.fn().mockResolvedValue(undefined),
  };
}

function stubConfig(overrides: Partial<Config> = {}): Config {
  return {
    adapterPath: '/fake/adapter.js',
    port: 9003,
    hostname: '127.0.0.1',
    stopOnEntry: false,
    pathMappings: { '/remote': '/local' },
    runtimeExecutable: 'php',
    maxConnections: 0,
    log: false,
    ...overrides,
  } as Config;
}

function stubPathMapper(): PathMapper {
  return { toRemote: (p: string) => p, toLocal: (p: string) => p } as PathMapper;
}

/**
 * Port preflight stub. debug_launch checks the port is free before spawning the
 * adapter; tests must not depend on whether 9003 happens to be free locally.
 */
const neverBound = { isPortBound: async () => false };

function createMockDAPClient() {
  const eventHandlers = new Map<string, Array<(event: DebugProtocol.Event) => void>>();

  const client = {
    onEvent: vi.fn((name: string, handler: (event: DebugProtocol.Event) => void) => {
      const list = eventHandlers.get(name) ?? [];
      list.push(handler);
      eventHandlers.set(name, list);
    }),
    offEvent: vi.fn((name: string, handler: (event: DebugProtocol.Event) => void) => {
      const list = eventHandlers.get(name);
      if (!list) return;
      const i = list.indexOf(handler);
      if (i !== -1) list.splice(i, 1);
    }),
    onAnyEvent: vi.fn(),
    initialize: vi.fn().mockResolvedValue({}),
    launch: vi.fn().mockResolvedValue({}),
    configurationDone: vi.fn().mockResolvedValue({}),
    sendRequest: vi.fn().mockResolvedValue({}),
    disconnect: vi.fn().mockResolvedValue(undefined),
    waitForEvent: vi.fn().mockResolvedValue({} as DebugProtocol.Event),
    isAlive: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue({ alive: true, pid: 1234 }),
  };

  function fireEvent(name: string, body: Record<string, unknown> = {}) {
    const event: DebugProtocol.Event = { seq: 0, type: 'event', event: name, body };
    for (const h of eventHandlers.get(name) ?? []) h(event);
  }

  return { client: client as unknown as DAPClient, mockClient: client, fireEvent };
}

// --- debug_launch tests (Requirements 2.1, 2.2, 2.3) ---

describe('handleDebugLaunch', () => {
  it('calls initialize → launch → configurationDone in order', async () => {
    const { client, mockClient } = createMockDAPClient();
    const callOrder: string[] = [];
    mockClient.initialize.mockImplementation(async () => {
      callOrder.push('initialize');
      return {};
    });
    mockClient.launch.mockImplementation(async () => {
      callOrder.push('launch');
      return {};
    });
    mockClient.configurationDone.mockImplementation(async () => {
      callOrder.push('configurationDone');
      return {};
    });

    const session = new SessionManager(stubConfig(), client, stubPathMapper(), stubNotifier());
    const result = await handleDebugLaunch(session, undefined, undefined, neverBound);

    expect(result.success).toBe(true);
    expect(callOrder).toEqual(['initialize', 'launch', 'configurationDone']);
  });

  it('returns port and pathMappings in the success result', async () => {
    const { client } = createMockDAPClient();
    const config = stubConfig({ port: 9005, pathMappings: { '/app': '/src' } });
    const session = new SessionManager(config, client, stubPathMapper(), stubNotifier());

    const result = await handleDebugLaunch(session, undefined, undefined, neverBound);

    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.port).toBe(9005);
    expect(data.pathMappings).toEqual({ '/app': '/src' });
    expect(data.status).toBe(SessionState.Listening);
  });

  it('applies optional overrides for stopOnEntry and port', async () => {
    const { client, mockClient } = createMockDAPClient();
    const config = stubConfig({ port: 9003, stopOnEntry: false });
    const session = new SessionManager(config, client, stubPathMapper(), stubNotifier());

    const result = await handleDebugLaunch(session, { stopOnEntry: true, port: 9999 }, undefined, neverBound);

    // The result should reflect the overridden values
    const data = result.data as any;
    expect(data.port).toBe(9999);
    expect(data.stopOnEntry).toBe(true);

    // ...and so must the launch arguments actually sent to the adapter. Without
    // this the overrides can be echoed in the result while the adapter listens
    // on the un-overridden port.
    expect(mockClient.launch).toHaveBeenCalledWith(expect.objectContaining({ stopOnEntry: true, port: 9999 }));

    // The original config must NOT be mutated (Req 17.1, 17.2)
    expect(config.stopOnEntry).toBe(false);
    expect(config.port).toBe(9003);
  });

  it('returns error result when DAP client throws', async () => {
    const { client, mockClient } = createMockDAPClient();
    mockClient.initialize.mockRejectedValue(new Error('adapter not found'));

    const session = new SessionManager(stubConfig(), client, stubPathMapper(), stubNotifier());
    const result = await handleDebugLaunch(session, undefined, undefined, neverBound);

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('adapter not found');
    expect(result.error?.code).toBe(ErrorCodes.DAP_ERROR);
  });
});

// --- debug_terminate tests (Requirement 2.4) ---

describe('handleDebugTerminate', () => {
  it('terminates session and returns success', async () => {
    const { client, mockClient } = createMockDAPClient();
    const session = new SessionManager(stubConfig(), client, stubPathMapper(), stubNotifier());

    // Launch first so we have something to terminate
    await session.launch();
    const result = await handleDebugTerminate(session);

    expect(result.success).toBe(true);
    expect((result.data as any).status).toBe('terminated');
    expect(mockClient.disconnect).toHaveBeenCalled();
  });

  it('returns error result when disconnect throws', async () => {
    const { client, mockClient } = createMockDAPClient();
    mockClient.disconnect.mockRejectedValue(new Error('connection lost'));

    const session = new SessionManager(stubConfig(), client, stubPathMapper(), stubNotifier());
    await session.launch();
    const result = await handleDebugTerminate(session);

    // terminate() re-throws the disconnect error, tool handler catches it
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('connection lost');
    // Session still transitions to terminated via the finally block
    expect(session.state).toBe(SessionState.Terminated);
  });
});

// --- debug_status tests (Requirement 2.7) ---

describe('handleDebugStatus', () => {
  it('returns correct status in NotStarted state', () => {
    const { client, mockClient } = createMockDAPClient();
    mockClient.getStatus.mockReturnValue({ alive: false, pid: undefined });
    const session = new SessionManager(stubConfig(), client, stubPathMapper(), stubNotifier());

    const result = handleDebugStatus(session);

    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.state).toBe(SessionState.NotStarted);
    expect(data.guidance).toContain('debug_launch');
  });

  it('returns correct status in Listening state', async () => {
    const { client } = createMockDAPClient();
    const session = new SessionManager(stubConfig(), client, stubPathMapper(), stubNotifier());
    await session.launch();

    const result = handleDebugStatus(session);

    const data = result.data as any;
    expect(data.state).toBe(SessionState.Listening);
    expect(data.adapterAlive).toBe(true);
    expect(data.guidance).toContain('Trigger your PHP script');
  });

  it('returns correct status in Connected state', async () => {
    const { client, fireEvent } = createMockDAPClient();
    const session = new SessionManager(stubConfig(), client, stubPathMapper(), stubNotifier());
    await session.launch();
    fireEvent('thread', { threadId: 1, reason: 'started' });

    const result = handleDebugStatus(session);

    const data = result.data as any;
    expect(data.state).toBe(SessionState.Connected);
    // Was `toContain('debug_pause')`. That guidance was wrong: Xdebug can only
    // pause through its control socket (Linux/Windows + Xdebug >= 3.5.0), so on
    // macOS the tool always fails. The running state now points at debug_wait.
    expect(data.guidance).toContain('debug_wait');
    expect(data.allowedTools).not.toContain('debug_pause');
  });

  it('returns correct status in Paused state with stopInfo', async () => {
    const { client, fireEvent } = createMockDAPClient();
    const session = new SessionManager(stubConfig(), client, stubPathMapper(), stubNotifier());
    await session.launch();
    fireEvent('thread', { threadId: 1, reason: 'started' });
    fireEvent('stopped', { reason: 'breakpoint', threadId: 1, allThreadsStopped: true });

    const result = handleDebugStatus(session);

    const data = result.data as any;
    expect(data.state).toBe(SessionState.Paused);
    expect(data.stopInfo.reason).toBe('breakpoint');
    expect(data.stopInfo.threadId).toBe(1);
    expect(data.guidance).toContain('debug_stack_trace');
  });

  it('returns correct status in Terminated state', async () => {
    const { client, fireEvent } = createMockDAPClient();
    const session = new SessionManager(stubConfig(), client, stubPathMapper(), stubNotifier());
    await session.launch();
    fireEvent('terminated', {});

    const result = handleDebugStatus(session);

    const data = result.data as any;
    expect(data.state).toBe(SessionState.Terminated);
    expect(data.guidance).toContain('debug_launch');
  });
});
