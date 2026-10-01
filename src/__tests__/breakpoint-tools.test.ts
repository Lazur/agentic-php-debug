import { describe, it, expect, vi } from 'vitest';
import { handleDebugSetBreakpoints } from '../tools/debug-set-breakpoints.js';
import { handleDebugSetFunctionBreakpoints } from '../tools/debug-set-function-breakpoints.js';
import { handleDebugSetExceptionBreakpoints } from '../tools/debug-set-exception-breakpoints.js';
import { SessionManager, type NotificationSender } from '../session.js';
import type { DAPClient } from '../dap-client.js';
import type { Config } from '../config.js';
import { PathMapper, type PathMapping } from '../path-mapper.js';
import type { DebugProtocol } from '@vscode/debugprotocol';
import { ErrorCodes } from '../tools/types.js';

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
    pathMappings: {},
    runtimeExecutable: 'php',
    maxConnections: 0,
    log: false,
    ...overrides,
  } as Config;
}

function createMockDAPClient() {
  const eventHandlers = new Map<string, Array<(event: DebugProtocol.Event) => void>>();

  const client = {
    onEvent: vi.fn((name: string, handler: (event: DebugProtocol.Event) => void) => {
      const list = eventHandlers.get(name) ?? [];
      list.push(handler);
      eventHandlers.set(name, list);
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

// --- debug_set_breakpoints tests (Requirements 6.1, 6.2, 6.5, 6.6) ---

describe('handleDebugSetBreakpoints', () => {
  it('sends setBreakpoints with path-mapped file path', async () => {
    const { client, mockClient, fireEvent } = createMockDAPClient();
    const mappings: PathMapping[] = [{ local: '/local/src', remote: '/remote/app' }];
    const mapper = new PathMapper(mappings);
    const session = new SessionManager(stubConfig(), client, mapper, stubNotifier());
    await session.launch();
    fireEvent('thread', { threadId: 1, reason: 'started' });

    mockClient.sendRequest.mockResolvedValueOnce({
      body: {
        breakpoints: [{ verified: true, line: 10, id: 1 }],
      },
    });

    const result = await handleDebugSetBreakpoints(session, {
      path: '/local/src/index.php',
      breakpoints: [{ line: 10 }],
    });

    expect(result.success).toBe(true);
    // Verify path was mapped to remote
    const callArgs = mockClient.sendRequest.mock.calls.find((c) => c[0] === 'setBreakpoints');
    expect(callArgs).toBeDefined();
    expect(callArgs![1]).toEqual({
      source: { path: '/remote/app/index.php' },
      breakpoints: [{ line: 10 }],
    });
  });

  it('replaces all breakpoints in a file (batch semantics)', async () => {
    const { client, mockClient, fireEvent } = createMockDAPClient();
    const mapper = new PathMapper([]);
    const session = new SessionManager(stubConfig(), client, mapper, stubNotifier());
    await session.launch();
    fireEvent('thread', { threadId: 1, reason: 'started' });

    mockClient.sendRequest.mockResolvedValueOnce({
      body: {
        breakpoints: [
          { verified: true, line: 5, id: 1 },
          { verified: true, line: 15, id: 2 },
          { verified: false, line: 20, id: 3, message: 'Invalid location' },
        ],
      },
    });

    const result = await handleDebugSetBreakpoints(session, {
      path: '/app/test.php',
      breakpoints: [{ line: 5 }, { line: 15 }, { line: 20 }],
    });

    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.breakpoints).toHaveLength(3);
    // Written while connected (PHP running). The adapter stages such writes in
    // its map and skips the network send, so none of these is active yet.
    expect(data.applied).toBe(false);
    expect(data.breakpoints[2].verification).toBe('staged_not_applied');
    expect(data.breakpoints[2].message).toBe('Invalid location');
  });

  it('sends breakpoints immediately when session is in listening state', async () => {
    const { client, mockClient } = createMockDAPClient();
    const mapper = new PathMapper([]);
    const session = new SessionManager(stubConfig(), client, mapper, stubNotifier());
    await session.launch(); // State is now Listening

    mockClient.sendRequest.mockResolvedValueOnce({
      body: { breakpoints: [{ verified: true, line: 10, id: 1 }] },
    });

    const result = await handleDebugSetBreakpoints(session, {
      path: '/app/test.php',
      breakpoints: [{ line: 10 }],
    });

    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.queued).toBe(false);
    // Breakpoints must reach the adapter BEFORE Xdebug connects — deferring
    // until the 'thread' event races the request being debugged.
    const bpCalls = mockClient.sendRequest.mock.calls.filter((c) => c[0] === 'setBreakpoints');
    expect(bpCalls).toHaveLength(1);
    expect(data.nextAction).toBe('Trigger PHP execution, then call debug_wait to wait for a breakpoint hit.');
  });

  it("does not pass the adapter's raw verified boolean through", async () => {
    const { client, mockClient, fireEvent } = createMockDAPClient();
    const mapper = new PathMapper([]);
    const session = new SessionManager(stubConfig(), client, mapper, stubNotifier());
    await session.launch();
    fireEvent('thread', { threadId: 1, reason: 'started' });

    mockClient.sendRequest.mockResolvedValueOnce({
      body: {
        breakpoints: [
          { verified: true, line: 10, id: 1 },
          { verified: false, line: 99, id: 2, message: 'Line not found' },
        ],
      },
    });

    const result = await handleDebugSetBreakpoints(session, {
      path: '/app/test.php',
      breakpoints: [{ line: 10 }, { line: 99 }],
    });

    expect(result.success).toBe(true);
    const data = result.data as any;
    // The raw boolean is `listeners('add').length === 0` — it means "no Xdebug
    // connection exists", which inverts the plain reading of the word and says
    // nothing about this breakpoint. It must not reach the model at all.
    expect(data.breakpoints[0]).not.toHaveProperty('verified');
    expect(data.breakpoints[1]).not.toHaveProperty('verified');
    // Status comes from session state, so both report the same thing despite
    // the mock returning opposite raw booleans.
    expect(data.breakpoints[0].verification).toBe('staged_not_applied');
    expect(data.breakpoints[1].verification).toBe('staged_not_applied');
    // The adapter's own message is still useful and is preserved.
    expect(data.breakpoints[1].message).toBe('Line not found');
  });

  it('rejects when session is not started', async () => {
    const { client } = createMockDAPClient();
    const mapper = new PathMapper([]);
    const session = new SessionManager(stubConfig(), client, mapper, stubNotifier());

    const result = await handleDebugSetBreakpoints(session, {
      path: '/app/test.php',
      breakpoints: [{ line: 10 }],
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ErrorCodes.SESSION_NOT_STARTED);
  });
});

// --- debug_set_function_breakpoints tests (Requirement 6.3) ---

describe('handleDebugSetFunctionBreakpoints', () => {
  it('sends setFunctionBreakpoints with function names', async () => {
    const { client, mockClient, fireEvent } = createMockDAPClient();
    const mapper = new PathMapper([]);
    const session = new SessionManager(stubConfig(), client, mapper, stubNotifier());
    await session.launch();
    fireEvent('thread', { threadId: 1, reason: 'started' });

    mockClient.sendRequest.mockResolvedValueOnce({
      body: {
        breakpoints: [{ verified: true, id: 1 }],
      },
    });

    const result = await handleDebugSetFunctionBreakpoints(session, {
      breakpoints: [{ name: 'myFunction' }],
    });

    expect(result.success).toBe(true);
    const callArgs = mockClient.sendRequest.mock.calls.find((c) => c[0] === 'setFunctionBreakpoints');
    expect(callArgs![1]).toEqual({
      breakpoints: [{ name: 'myFunction' }],
    });
  });

  it('sends function breakpoints immediately in listening state', async () => {
    const { client, mockClient } = createMockDAPClient();
    const mapper = new PathMapper([]);
    const session = new SessionManager(stubConfig(), client, mapper, stubNotifier());
    await session.launch();

    mockClient.sendRequest.mockResolvedValueOnce({ body: { breakpoints: [] } });

    const result = await handleDebugSetFunctionBreakpoints(session, {
      breakpoints: [{ name: 'foo' }],
    });

    expect(result.success).toBe(true);
    expect((result.data as any).queued).toBe(false);
    const bpCalls = mockClient.sendRequest.mock.calls.filter((c) => c[0] === 'setFunctionBreakpoints');
    expect(bpCalls).toHaveLength(1);
  });
});

// --- debug_set_exception_breakpoints tests (Requirement 6.4) ---

describe('handleDebugSetExceptionBreakpoints', () => {
  it('sends setExceptionBreakpoints with filter IDs', async () => {
    const { client, mockClient, fireEvent } = createMockDAPClient();
    const mapper = new PathMapper([]);
    const session = new SessionManager(stubConfig(), client, mapper, stubNotifier());
    await session.launch();
    fireEvent('thread', { threadId: 1, reason: 'started' });

    mockClient.sendRequest.mockResolvedValueOnce({
      body: { breakpoints: [] },
    });

    const result = await handleDebugSetExceptionBreakpoints(session, {
      filters: ['Notice', 'Warning', 'Exception'],
    });

    expect(result.success).toBe(true);
    const callArgs = mockClient.sendRequest.mock.calls.find((c) => c[0] === 'setExceptionBreakpoints');
    expect(callArgs![1]).toEqual({
      filters: ['Notice', 'Warning', 'Exception'],
    });
  });

  it('sends exception breakpoints immediately in listening state', async () => {
    const { client, mockClient } = createMockDAPClient();
    const mapper = new PathMapper([]);
    const session = new SessionManager(stubConfig(), client, mapper, stubNotifier());
    await session.launch();

    mockClient.sendRequest.mockResolvedValueOnce({ body: { breakpoints: [] } });

    const result = await handleDebugSetExceptionBreakpoints(session, {
      filters: ['*'],
    });

    expect(result.success).toBe(true);
    expect((result.data as any).queued).toBe(false);
    const bpCalls = mockClient.sendRequest.mock.calls.filter((c) => c[0] === 'setExceptionBreakpoints');
    expect(bpCalls).toHaveLength(1);
  });
});
