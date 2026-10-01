import { describe, it, expect, vi } from 'vitest';
import { handleDebugContinue } from '../tools/debug-continue.js';
import { handleDebugNext } from '../tools/debug-next.js';
import { handleDebugStepIn } from '../tools/debug-step-in.js';
import { handleDebugStepOut } from '../tools/debug-step-out.js';
import { handleDebugPause } from '../tools/debug-pause.js';
import { SessionManager, SessionState, type NotificationSender } from '../session.js';
import type { DAPClient } from '../dap-client.js';
import type { PathMapper } from '../path-mapper.js';
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

function stubPathMapper(): PathMapper {
  return { toRemote: (p: string) => p, toLocal: (p: string) => p } as PathMapper;
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

/** Helper: launch session and move to Paused state. */
async function launchAndPause(client: DAPClient, fireEvent: (name: string, body: Record<string, unknown>) => void) {
  const session = new SessionManager(stubConfig(), client, stubPathMapper(), stubNotifier());
  await session.launch();
  fireEvent('thread', { threadId: 1, reason: 'started' });
  fireEvent('stopped', { reason: 'breakpoint', threadId: 1, allThreadsStopped: true });
  return session;
}

/** Helper: launch session and move to Connected state. */
async function launchAndConnect(client: DAPClient, fireEvent: (name: string, body: Record<string, unknown>) => void) {
  const session = new SessionManager(stubConfig(), client, stubPathMapper(), stubNotifier());
  await session.launch();
  fireEvent('thread', { threadId: 1, reason: 'started' });
  return session;
}

// --- debug_continue tests (Requirement 5.1) ---

describe('handleDebugContinue', () => {
  it('sends DAP continue request with correct threadId', async () => {
    const { client, mockClient, fireEvent } = createMockDAPClient();
    const session = await launchAndPause(client, fireEvent);

    const result = await handleDebugContinue(session, { threadId: 1 });

    expect(result.success).toBe(true);
    expect(mockClient.sendRequest).toHaveBeenCalledWith('continue', { threadId: 1 });
    // DAP makes the client infer the resume; the adapter sends no `continued`.
    expect(session.state).toBe(SessionState.Connected);
  });

  it('rejects when session is not paused', async () => {
    const { client, fireEvent } = createMockDAPClient();
    const session = await launchAndConnect(client, fireEvent);

    const result = await handleDebugContinue(session, { threadId: 1 });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ErrorCodes.SESSION_NOT_PAUSED);
  });
});

// --- debug_next tests (Requirement 5.2) ---

describe('handleDebugNext', () => {
  it('sends DAP next request with correct threadId', async () => {
    const { client, mockClient, fireEvent } = createMockDAPClient();
    const session = await launchAndPause(client, fireEvent);

    const result = await handleDebugNext(session, { threadId: 1 });

    expect(result.success).toBe(true);
    expect(mockClient.sendRequest).toHaveBeenCalledWith('next', { threadId: 1 });
    // DAP makes the client infer the resume; the adapter sends no `continued`.
    expect(session.state).toBe(SessionState.Connected);
  });

  it('rejects when session is not paused', async () => {
    const { client, fireEvent } = createMockDAPClient();
    const session = await launchAndConnect(client, fireEvent);

    const result = await handleDebugNext(session, { threadId: 1 });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ErrorCodes.SESSION_NOT_PAUSED);
  });
});

// --- debug_step_in tests (Requirement 5.3) ---

describe('handleDebugStepIn', () => {
  it('sends DAP stepIn request with correct threadId', async () => {
    const { client, mockClient, fireEvent } = createMockDAPClient();
    const session = await launchAndPause(client, fireEvent);

    const result = await handleDebugStepIn(session, { threadId: 1 });

    expect(result.success).toBe(true);
    expect(mockClient.sendRequest).toHaveBeenCalledWith('stepIn', { threadId: 1 });
    // DAP makes the client infer the resume; the adapter sends no `continued`.
    expect(session.state).toBe(SessionState.Connected);
  });

  it('rejects when session is not paused', async () => {
    const { client, fireEvent } = createMockDAPClient();
    const session = await launchAndConnect(client, fireEvent);

    const result = await handleDebugStepIn(session, { threadId: 1 });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ErrorCodes.SESSION_NOT_PAUSED);
  });
});

// --- debug_step_out tests (Requirement 5.4) ---

describe('handleDebugStepOut', () => {
  it('sends DAP stepOut request with correct threadId', async () => {
    const { client, mockClient, fireEvent } = createMockDAPClient();
    const session = await launchAndPause(client, fireEvent);

    const result = await handleDebugStepOut(session, { threadId: 1 });

    expect(result.success).toBe(true);
    expect(mockClient.sendRequest).toHaveBeenCalledWith('stepOut', { threadId: 1 });
    // DAP makes the client infer the resume; the adapter sends no `continued`.
    expect(session.state).toBe(SessionState.Connected);
  });

  it('rejects when session is not paused', async () => {
    const { client, fireEvent } = createMockDAPClient();
    const session = await launchAndConnect(client, fireEvent);

    const result = await handleDebugStepOut(session, { threadId: 1 });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ErrorCodes.SESSION_NOT_PAUSED);
  });
});

// --- debug_pause tests (Requirement 5.5) ---

describe('handleDebugPause', () => {
  it('sends DAP pause request with correct threadId', async () => {
    const { client, mockClient, fireEvent } = createMockDAPClient();
    const session = await launchAndConnect(client, fireEvent);

    const result = await handleDebugPause(session, { threadId: 1 });

    expect(result.success).toBe(true);
    expect(mockClient.sendRequest).toHaveBeenCalledWith('pause', { threadId: 1 });
  });

  it('rejects when session is paused (not connected)', async () => {
    const { client, fireEvent } = createMockDAPClient();
    const session = await launchAndPause(client, fireEvent);

    const result = await handleDebugPause(session, { threadId: 1 });

    expect(result.success).toBe(false);
    // Was SESSION_NOT_PAUSED, which told the agent the exact opposite of the
    // truth: this handler requires Connected, and it is rejecting *because*
    // the session is paused.
    expect(result.error?.code).toBe(ErrorCodes.SESSION_NOT_RUNNING);
  });

  it('reports PAUSE_UNSUPPORTED with a workaround when Xdebug cannot pause', async () => {
    const { client, mockClient, fireEvent } = createMockDAPClient();
    const session = await launchAndConnect(client, fireEvent);
    mockClient.sendRequest.mockRejectedValueOnce(new Error('Pausing the execution is not supported by Xdebug'));

    const result = await handleDebugPause(session, { threadId: 1 });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ErrorCodes.PAUSE_UNSUPPORTED);
    expect(result.error?.message).toContain('debug_set_breakpoints');
  });
});
