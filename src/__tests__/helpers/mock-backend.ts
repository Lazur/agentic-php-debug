/**
 * Shared test doubles for SessionManager and the tool handlers.
 *
 * New tests use this. The ~7 older per-file copies of these stubs are migrated
 * opportunistically, not in bulk: they are NOT equivalent to each other (most
 * resolve `sendRequest` to `{}`, a few to `{ body: {} }`, several assert on the
 * `vi.fn()` spies directly), so a big-bang migration would mix semantic mock
 * changes into unrelated diffs.
 *
 * Not collected by vitest — `include` is `src/**\/*.test.ts`.
 */
import { vi } from 'vitest';
import type { DebugProtocol } from '@vscode/debugprotocol';
import { SessionManager, type NotificationSender } from '../../session.js';
import type { DebugBackend, EventHandler } from '../../debug-backend.js';
import type { PathMapper } from '../../path-mapper.js';
import type { Config } from '../../config.js';

export function stubNotifier(): NotificationSender {
  return {
    sendProgress: vi.fn().mockResolvedValue(undefined),
    sendLog: vi.fn().mockResolvedValue(undefined),
    sendDebugEvent: vi.fn().mockResolvedValue(undefined),
  };
}

export function stubConfig(overrides: Partial<Config> = {}): Config {
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

export function stubPathMapper(): PathMapper {
  return { toRemote: (p: string) => p, toLocal: (p: string) => p } as PathMapper;
}

export interface MockBackend {
  /** Typed as the interface, for injection into SessionManager. */
  client: DebugBackend;
  /** The same object, untyped, for spy assertions. */
  mockClient: any;
  /** Synchronously dispatch an event to every handler registered for it. */
  fireEvent(name: string, body?: Record<string, unknown>): void;
  /** How many handlers are currently registered for an event name. */
  handlerCount(name: string): number;
}

/**
 * A DebugBackend double implementing the FULL interface — including `offEvent`,
 * which most of the older hand-rolled copies omit, and which `debug_wait` calls
 * on every resolution path.
 */
export function createMockBackend(): MockBackend {
  const eventHandlers = new Map<string, EventHandler[]>();

  const client = {
    onEvent: vi.fn((name: string, handler: EventHandler) => {
      const list = eventHandlers.get(name) ?? [];
      list.push(handler);
      eventHandlers.set(name, list);
    }),
    offEvent: vi.fn((name: string, handler: EventHandler) => {
      const list = eventHandlers.get(name);
      if (!list) return;
      const i = list.indexOf(handler);
      if (i !== -1) list.splice(i, 1);
    }),
    onAnyEvent: vi.fn(),
    initialize: vi.fn().mockResolvedValue({}),
    launch: vi.fn().mockResolvedValue({}),
    configurationDone: vi.fn().mockResolvedValue({}),
    sendRequest: vi.fn().mockResolvedValue({ body: {} }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    waitForEvent: vi.fn().mockResolvedValue({} as DebugProtocol.Event),
    isAlive: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue({ alive: true, pid: 1234 }),
    getSeq: vi.fn().mockReturnValue(1),
    onTrace: null,
    onStderr: null,
  };

  function fireEvent(name: string, body: Record<string, unknown> = {}): void {
    const event: DebugProtocol.Event = { seq: 0, type: 'event', event: name, body };
    for (const h of [...(eventHandlers.get(name) ?? [])]) h(event);
  }

  return {
    client: client as unknown as DebugBackend,
    mockClient: client,
    fireEvent,
    handlerCount: (name) => (eventHandlers.get(name) ?? []).length,
  };
}

export function newSession(mock: MockBackend, config?: Partial<Config>): SessionManager {
  return new SessionManager(stubConfig(config), mock.client, stubPathMapper(), stubNotifier());
}

/** Launch, then drive to Connected with a `thread` event. */
export async function launchAndConnect(mock: MockBackend, config?: Partial<Config>): Promise<SessionManager> {
  const session = newSession(mock, config);
  await session.launch();
  mock.fireEvent('thread', { threadId: 1, reason: 'started' });
  return session;
}

/** Launch, connect, then drive to Paused with a `stopped` event. */
export async function launchAndPause(
  mock: MockBackend,
  threadId = 1,
  config?: Partial<Config>,
): Promise<SessionManager> {
  const session = await launchAndConnect(mock, config);
  mock.fireEvent('stopped', { reason: 'breakpoint', threadId, allThreadsStopped: false });
  return session;
}
