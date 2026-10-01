import { describe, it, expect, vi } from 'vitest';
import { handleDebugEvaluate } from '../tools/debug-evaluate.js';
import { handleDebugVariables } from '../tools/debug-variables.js';
import { handleDebugStackTrace } from '../tools/debug-stack-trace.js';
import { handleDebugScopes } from '../tools/debug-scopes.js';
import { handleDebugSetVariable } from '../tools/debug-set-variable.js';
import { SessionManager, type NotificationSender } from '../session.js';
import type { DAPClient } from '../dap-client.js';
import { PathMapper, type PathMapping } from '../path-mapper.js';
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

async function launchAndPause(
  client: DAPClient,
  fireEvent: (name: string, body: Record<string, unknown>) => void,
  mapper?: PathMapper,
) {
  const session = new SessionManager(stubConfig(), client, mapper ?? new PathMapper([]), stubNotifier());
  await session.launch();
  fireEvent('thread', { threadId: 1, reason: 'started' });
  fireEvent('stopped', { reason: 'breakpoint', threadId: 1, allThreadsStopped: true });
  return session;
}

// --- debug_evaluate tests (Requirement 7.1) ---

describe('handleDebugEvaluate', () => {
  it('sends evaluate request with expression and frameId', async () => {
    const { client, mockClient, fireEvent } = createMockDAPClient();
    mockClient.sendRequest.mockResolvedValueOnce({
      body: { result: '42', type: 'int', variablesReference: 0 },
    });
    const session = await launchAndPause(client, fireEvent);

    const result = await handleDebugEvaluate(session, { expression: 'count($items)', frameId: 5 });

    expect(result.success).toBe(true);
    const callArgs = mockClient.sendRequest.mock.calls.find((c) => c[0] === 'evaluate');
    expect(callArgs![1]).toMatchObject({ expression: 'count($items)', frameId: 5, context: 'repl' });
    const data = result.data as any;
    expect(data.result).toBe('42');
    expect(data.type).toBe('int');
    expect(data.variablesReference).toBe(0);
  });

  it('rejects when session is not paused', async () => {
    const { client, fireEvent } = createMockDAPClient();
    const session = new SessionManager(stubConfig(), client, new PathMapper([]), stubNotifier());
    await session.launch();
    fireEvent('thread', { threadId: 1, reason: 'started' });

    const result = await handleDebugEvaluate(session, { expression: '$x' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ErrorCodes.SESSION_NOT_PAUSED);
  });
});

// --- debug_variables tests (Requirement 7.2) ---

describe('handleDebugVariables', () => {
  it('sends variables request with variablesReference and returns variable list', async () => {
    const { client, mockClient, fireEvent } = createMockDAPClient();
    mockClient.sendRequest.mockResolvedValueOnce({
      body: {
        variables: [
          { name: '$user', value: 'object(User)', type: 'object', variablesReference: 10, namedVariables: 3 },
          { name: '$count', value: '5', type: 'int', variablesReference: 0 },
        ],
      },
    });
    const session = await launchAndPause(client, fireEvent);

    const result = await handleDebugVariables(session, { variablesReference: 1 });

    expect(result.success).toBe(true);
    const callArgs = mockClient.sendRequest.mock.calls.find((c) => c[0] === 'variables');
    expect(callArgs![1]).toMatchObject({ variablesReference: 1 });
    const data = result.data as any;
    expect(data.variables).toHaveLength(2);
    expect(data.variables[0].name).toBe('$user');
    expect(data.variables[0].variablesReference).toBe(10);
    expect(data.variables[1].variablesReference).toBe(0);
  });

  it('rejects when session is not paused', async () => {
    const { client, fireEvent } = createMockDAPClient();
    const session = new SessionManager(stubConfig(), client, new PathMapper([]), stubNotifier());
    await session.launch();
    fireEvent('thread', { threadId: 1, reason: 'started' });

    const result = await handleDebugVariables(session, { variablesReference: 1 });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ErrorCodes.SESSION_NOT_PAUSED);
  });
});

// --- debug_stack_trace tests (Requirement 7.3) ---

describe('handleDebugStackTrace', () => {
  it('path-maps source locations in response frames', async () => {
    const { client, mockClient, fireEvent } = createMockDAPClient();
    const mappings: PathMapping[] = [{ local: '/local/src', remote: '/remote/app' }];
    const mapper = new PathMapper(mappings);
    mockClient.sendRequest.mockResolvedValueOnce({
      body: {
        stackFrames: [
          { id: 1, name: 'main', source: { name: 'index.php', path: '/remote/app/index.php' }, line: 10, column: 1 },
          {
            id: 2,
            name: 'helper',
            source: { name: 'utils.php', path: '/remote/app/lib/utils.php' },
            line: 25,
            column: 5,
          },
        ],
        totalFrames: 2,
      },
    });
    const session = await launchAndPause(client, fireEvent, mapper);

    const result = await handleDebugStackTrace(session, { threadId: 1 });

    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.stackFrames[0].source.path).toBe('/local/src/index.php');
    expect(data.stackFrames[1].source.path).toBe('/local/src/lib/utils.php');
    expect(data.totalFrames).toBe(2);
  });

  it('rejects when session is not paused', async () => {
    const { client, fireEvent } = createMockDAPClient();
    const session = new SessionManager(stubConfig(), client, new PathMapper([]), stubNotifier());
    await session.launch();
    fireEvent('thread', { threadId: 1, reason: 'started' });

    const result = await handleDebugStackTrace(session, { threadId: 1 });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ErrorCodes.SESSION_NOT_PAUSED);
  });
});

// --- debug_scopes tests (Requirement 7.4) ---

describe('handleDebugScopes', () => {
  it('returns correct variablesReferences for each scope', async () => {
    const { client, mockClient, fireEvent } = createMockDAPClient();
    mockClient.sendRequest.mockResolvedValueOnce({
      body: {
        scopes: [
          { name: 'Locals', variablesReference: 100, namedVariables: 5, expensive: false },
          { name: 'Superglobals', variablesReference: 200, namedVariables: 9, expensive: true },
        ],
      },
    });
    const session = await launchAndPause(client, fireEvent);

    const result = await handleDebugScopes(session, { frameId: 1 });

    expect(result.success).toBe(true);
    const callArgs = mockClient.sendRequest.mock.calls.find((c) => c[0] === 'scopes');
    expect(callArgs![1]).toEqual({ frameId: 1 });
    const data = result.data as any;
    expect(data.scopes).toHaveLength(2);
    expect(data.scopes[0].variablesReference).toBe(100);
    expect(data.scopes[1].variablesReference).toBe(200);
    expect(data.scopes[1].expensive).toBe(true);
  });

  it('rejects when session is not paused', async () => {
    const { client, fireEvent } = createMockDAPClient();
    const session = new SessionManager(stubConfig(), client, new PathMapper([]), stubNotifier());
    await session.launch();
    fireEvent('thread', { threadId: 1, reason: 'started' });

    const result = await handleDebugScopes(session, { frameId: 1 });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ErrorCodes.SESSION_NOT_PAUSED);
  });
});

// --- debug_set_variable tests (Requirement 7.5) ---

describe('handleDebugSetVariable', () => {
  it('sends setVariable request and returns updated value', async () => {
    const { client, mockClient, fireEvent } = createMockDAPClient();
    mockClient.sendRequest.mockResolvedValueOnce({
      body: { value: '"new_value"', type: 'string', variablesReference: 0 },
    });
    const session = await launchAndPause(client, fireEvent);

    const result = await handleDebugSetVariable(session, {
      variablesReference: 100,
      name: '$myVar',
      value: '"new_value"',
    });

    expect(result.success).toBe(true);
    const callArgs = mockClient.sendRequest.mock.calls.find((c) => c[0] === 'setVariable');
    expect(callArgs![1]).toEqual({ variablesReference: 100, name: '$myVar', value: '"new_value"' });
    const data = result.data as any;
    expect(data.value).toBe('"new_value"');
    expect(data.type).toBe('string');
  });

  it('rejects when session is not paused', async () => {
    const { client, fireEvent } = createMockDAPClient();
    const session = new SessionManager(stubConfig(), client, new PathMapper([]), stubNotifier());
    await session.launch();
    fireEvent('thread', { threadId: 1, reason: 'started' });

    const result = await handleDebugSetVariable(session, {
      variablesReference: 100,
      name: '$x',
      value: '42',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ErrorCodes.SESSION_NOT_PAUSED);
  });
});
