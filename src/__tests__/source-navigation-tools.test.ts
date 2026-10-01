import { describe, it, expect, vi } from 'vitest';
import { handleDebugSource } from '../tools/debug-source.js';
import { handleDebugThreads } from '../tools/debug-threads.js';
import { handleDebugExceptionInfo } from '../tools/debug-exception-info.js';
import { SessionManager, SessionState, type NotificationSender } from '../session.js';
import type { DAPClient } from '../dap-client.js';
import { PathMapper } from '../path-mapper.js';
import type { Config } from '../config.js';
import type { DebugProtocol } from '@vscode/debugprotocol';
import { ErrorCodes } from '../tools/types.js';

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

async function launchAndPause(client: DAPClient, fireEvent: (name: string, body: Record<string, unknown>) => void) {
  const session = new SessionManager(stubConfig(), client, new PathMapper([]), stubNotifier());
  await session.launch();
  fireEvent('thread', { threadId: 1, reason: 'started' });
  fireEvent('stopped', { reason: 'breakpoint', threadId: 1, allThreadsStopped: true });
  return session;
}

async function launchAndConnect(client: DAPClient, fireEvent: (name: string, body: Record<string, unknown>) => void) {
  const session = new SessionManager(stubConfig(), client, new PathMapper([]), stubNotifier());
  await session.launch();
  fireEvent('thread', { threadId: 1, reason: 'started' });
  return session;
}

// --- debug_source tests (Requirement 12.1) ---

describe('handleDebugSource', () => {
  it('sends source request and returns content', async () => {
    const { client, mockClient, fireEvent } = createMockDAPClient();
    mockClient.sendRequest.mockResolvedValueOnce({
      body: { content: '<?php echo "hello";', mimeType: 'text/x-php' },
    });
    const session = await launchAndPause(client, fireEvent);

    const result = await handleDebugSource(session, { sourceReference: 42 });

    expect(result.success).toBe(true);
    const callArgs = mockClient.sendRequest.mock.calls.find((c) => c[0] === 'source');
    expect(callArgs![1]).toMatchObject({ sourceReference: 42 });
    const data = result.data as any;
    expect(data.content).toBe('<?php echo "hello";');
    expect(data.mimeType).toBe('text/x-php');
  });

  it('rejects when session is not active', async () => {
    const { client } = createMockDAPClient();
    const session = new SessionManager(stubConfig(), client, new PathMapper([]), stubNotifier());

    const result = await handleDebugSource(session, { sourceReference: 1 });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ErrorCodes.SESSION_NOT_STARTED);
  });
});

// --- debug_threads tests (Requirement 12.2) ---

describe('handleDebugThreads', () => {
  it('sends threads request and returns thread list', async () => {
    const { client, mockClient, fireEvent } = createMockDAPClient();
    mockClient.sendRequest.mockResolvedValueOnce({
      body: {
        threads: [
          { id: 1, name: 'Thread 1' },
          { id: 2, name: 'Thread 2' },
        ],
      },
    });
    const session = await launchAndConnect(client, fireEvent);

    const result = await handleDebugThreads(session);

    expect(result.success).toBe(true);
    const callArgs = mockClient.sendRequest.mock.calls.find((c) => c[0] === 'threads');
    expect(callArgs).toBeDefined();
    const data = result.data as any;
    expect(data.threads).toHaveLength(2);
    expect(data.threads[0]).toEqual({ id: 1, name: 'Thread 1' });
    expect(data.threads[1]).toEqual({ id: 2, name: 'Thread 2' });
  });

  it('rejects when session is not active', async () => {
    const { client } = createMockDAPClient();
    const session = new SessionManager(stubConfig(), client, new PathMapper([]), stubNotifier());

    const result = await handleDebugThreads(session);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ErrorCodes.SESSION_NOT_STARTED);
  });
});

// --- debug_exception_info tests (Requirement 12.3) ---

describe('handleDebugExceptionInfo', () => {
  it('sends exceptionInfo request and returns exception details', async () => {
    const { client, mockClient, fireEvent } = createMockDAPClient();
    mockClient.sendRequest.mockResolvedValueOnce({
      body: {
        exceptionId: 'RuntimeException',
        description: 'Something went wrong',
        breakMode: 'always',
        details: { message: 'Detailed error info', typeName: 'RuntimeException' },
      },
    });
    const session = await launchAndPause(client, fireEvent);

    const result = await handleDebugExceptionInfo(session, { threadId: 1 });

    expect(result.success).toBe(true);
    const callArgs = mockClient.sendRequest.mock.calls.find((c) => c[0] === 'exceptionInfo');
    expect(callArgs![1]).toEqual({ threadId: 1 });
    const data = result.data as any;
    expect(data.exceptionId).toBe('RuntimeException');
    expect(data.description).toBe('Something went wrong');
    expect(data.breakMode).toBe('always');
    expect(data.details).toEqual({ message: 'Detailed error info', typeName: 'RuntimeException' });
  });

  it('rejects when session is not paused', async () => {
    const { client, fireEvent } = createMockDAPClient();
    const session = await launchAndConnect(client, fireEvent);

    const result = await handleDebugExceptionInfo(session, { threadId: 1 });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ErrorCodes.SESSION_NOT_PAUSED);
  });
});
