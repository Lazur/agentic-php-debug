import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { DAPClient, type ProcessSpawner, type ChildProcessLike } from '../dap-client.js';
import { frameMessage } from '../dap-framing.js';
import { SessionManager, SessionState, type NotificationSender } from '../session.js';
import type { Config } from '../config.js';
import type { PathMapper } from '../path-mapper.js';
import type { DebugProtocol } from '@vscode/debugprotocol';
import { handleDebugLaunch } from '../tools/debug-launch.js';

// --- Shared helpers ---

function stubNotifier(): NotificationSender {
  return {
    sendProgress: async () => {},
    sendLog: async () => {},
    sendDebugEvent: async () => {},
  };
}

function stubConfig(overrides: Partial<Config> = {}): Config {
  return {
    adapterPath: '/fake/adapter.js',
    port: 9003,
    hostname: '127.0.0.1',
    stopOnEntry: false,
    pathMappings: { '/server': '/local' },
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
 * Creates a mock process that never responds to requests (for timeout testing).
 * Only responds to 'initialize' so the client can be set up.
 */
function createSilentMockProcess() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();

  // Only respond to initialize, ignore everything else
  let buffer = Buffer.alloc(0);
  let contentLength = -1;

  stdin.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      if (contentLength === -1) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const header = buffer.subarray(0, headerEnd).toString('ascii');
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        if (!match) return;
        contentLength = parseInt(match[1], 10);
        buffer = buffer.subarray(headerEnd + 4);
      }
      if (buffer.length < contentLength) return;
      const body = buffer.subarray(0, contentLength).toString('utf-8');
      buffer = buffer.subarray(contentLength);
      contentLength = -1;

      const request = JSON.parse(body);
      if (request.command === 'initialize') {
        stdout.write(frameMessage({
          seq: 0, type: 'response', request_seq: request.seq,
          command: 'initialize', success: true,
          body: { supportsConfigurationDoneRequest: true },
        }));
      }
      // All other requests: no response (triggers timeout)
    }
  });

  const process: ChildProcessLike = {
    stdin, stdout, stderr,
    pid: 99999,
    on(event: 'exit', listener: (code: number | null) => void) {
      emitter.on(event, listener);
      return process;
    },
    kill() { emitter.emit('exit', 0); return true; },
  };

  return { process, emitter };
}

function createMockDAPClient() {
  const eventHandlers = new Map<string, Array<(event: DebugProtocol.Event) => void>>();

  const mockClient = {
    onEvent(name: string, handler: (event: DebugProtocol.Event) => void) {
      const list = eventHandlers.get(name) ?? [];
      list.push(handler);
      eventHandlers.set(name, list);
    },
    offEvent(name: string, handler: (event: DebugProtocol.Event) => void) {
      const list = eventHandlers.get(name);
      if (!list) return;
      const i = list.indexOf(handler);
      if (i !== -1) list.splice(i, 1);
    },
    onAnyEvent() {},
    async initialize() { return {} as any; },
    launch: vi.fn(async () => ({}) as any),
    async configurationDone() { return {} as any; },
    async sendRequest() { return {} as any; },
    async disconnect() {},
    waitForEvent() { return Promise.resolve({} as DebugProtocol.Event); },
    isAlive() { return true; },
    getStatus() { return { alive: true, pid: 1234 }; },
    getSeq() { return 1; },
    onTrace: null,
    onStderr: null,
  };
  const client = mockClient as unknown as import('../dap-client.js').DAPClient;

  function getHandlerCount(eventName: string): number {
    return eventHandlers.get(eventName)?.length ?? 0;
  }

  return { client, mockClient, eventHandlers, getHandlerCount };
}

/**
 * Port preflight stub. Tests must not bind real sockets: the property below
 * draws random ports, and any one of them could genuinely be in use.
 */
const neverBound = { isPortBound: async () => false };

// --- Property 9: DAPClient request timeout with correct error ---

describe('Property 9: DAPClient request timeout with correct error', () => {
  /**
   * Property 9: DAPClient request timeout with correct error
   *
   * For any DAP command name and any positive timeout duration, if the adapter
   * does not respond within the timeout, sendRequest should reject with an error
   * whose message contains both the command name and the timeout duration.
   *
   * Validates: Requirements 16.1, 16.4
   */
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sendRequest rejects with error containing command name and timeout duration', async () => {
    // Suppress expected unhandled rejections from fake timer side effects
    const suppressedErrors: Error[] = [];
    const handler = (err: unknown) => { suppressedErrors.push(err as Error); };
    process.on('unhandledRejection', handler);

    try {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 20 }).filter(s => /^[a-zA-Z_]+$/.test(s)),
          fc.integer({ min: 100, max: 60000 }),
          async (command, timeout) => {
            vi.useFakeTimers();

            const { process: mockProc } = createSilentMockProcess();
            const spawner: ProcessSpawner = { spawn: () => mockProc };
            const client = new DAPClient('/fake/adapter.js', spawner);

            const initPromise = client.initialize();
            await vi.advanceTimersByTimeAsync(100);
            await initPromise;

            // Send a request that will never get a response
            const requestPromise = client.sendRequest(command, {}, timeout);

            // Advance time past the timeout
            await vi.advanceTimersByTimeAsync(timeout + 1);

            try {
              await requestPromise;
              expect.unreachable('sendRequest should have timed out');
            } catch (err: unknown) {
              expect(err).toBeInstanceOf(Error);
              const message = (err as Error).message;
              expect(message).toContain(command);
              expect(message).toContain(String(timeout));
            }

            vi.useRealTimers();
          },
        ),
        { numRuns: 50 },
      );
    } finally {
      process.removeListener('unhandledRejection', handler);
    }
  });

  it('default timeout is 30 seconds', () => {
    const client = new DAPClient('/fake/adapter.js');
    expect(client.defaultTimeout).toBe(30_000);
  });
});

// --- Property 10: Config immutability across handleDebugLaunch ---

describe('Property 10: Config immutability across handleDebugLaunch', () => {
  /**
   * Property 10: Config immutability across handleDebugLaunch
   *
   * For any Config object and any combination of stopOnEntry and port overrides,
   * the caller's Config OBJECT must never be mutated — while the overrides must
   * still reach the actual launch arguments. The original form of this property
   * asserted immutability through session.sessionConfig, which the overrides are
   * supposed to change; that reading let the overrides be silently inert.
   *
   * Validates: Requirements 17.1, 17.2
   */
  it('never mutates the injected config, and still applies the overrides', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          stopOnEntry: fc.option(fc.boolean(), { nil: undefined }),
          port: fc.option(fc.integer({ min: 1024, max: 65535 }), { nil: undefined }),
        }),
        fc.integer({ min: 1024, max: 65535 }),
        fc.boolean(),
        async (overrides, originalPort, originalStopOnEntry) => {
          const config = stubConfig({ port: originalPort, stopOnEntry: originalStopOnEntry });
          const { client, mockClient } = createMockDAPClient();

          const session = new SessionManager(config, client, stubPathMapper(), stubNotifier());

          // Snapshot the injected object itself, not the session's view of it.
          const injectedBefore = JSON.parse(JSON.stringify(config));

          const args: Record<string, unknown> = {};
          if (overrides.stopOnEntry !== undefined) args.stopOnEntry = overrides.stopOnEntry;
          if (overrides.port !== undefined) args.port = overrides.port;

          await handleDebugLaunch(session, args as any, undefined, neverBound);

          // Req 17.1/17.2: the caller's object is untouched.
          expect(config).toEqual(injectedBefore);

          // ...and the overrides actually took effect. Both the reported config
          // and the launch arguments sent to the adapter must agree, or the tool
          // is reporting a port it is not listening on.
          const expectedPort = overrides.port ?? originalPort;
          const expectedStopOnEntry = overrides.stopOnEntry ?? originalStopOnEntry;

          expect(session.sessionConfig.port).toBe(expectedPort);
          expect(session.sessionConfig.stopOnEntry).toBe(expectedStopOnEntry);

          expect(mockClient.launch).toHaveBeenCalledWith(
            expect.objectContaining({ port: expectedPort, stopOnEntry: expectedStopOnEntry }),
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});

// --- Property 11: Idempotent event handler registration ---

describe('Property 11: Idempotent event handler registration', () => {
  /**
   * Property 11: Idempotent event handler registration
   *
   * For any sequence of launch() and terminate() calls on a SessionManager,
   * the number of event handlers registered on the backend should never exceed
   * the count from a single registration. Calling registerEventHandlers()
   * multiple times without an intervening terminate() should not increase
   * the handler count.
   *
   * Validates: Requirements 18.1, 18.2, 18.3
   */
  it('consecutive launches without terminate do not stack duplicate handlers', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 10 }),
        async (launchCount) => {
          const { client, getHandlerCount } = createMockDAPClient();
          const session = new SessionManager(
            stubConfig(), client, stubPathMapper(), stubNotifier(),
          );

          const trackedEvents = ['stopped', 'continued', 'terminated', 'exited', 'thread'];

          // First launch establishes the baseline
          await session.launch();
          const baselineCount = trackedEvents.reduce(
            (sum, evt) => sum + getHandlerCount(evt), 0,
          );
          expect(baselineCount).toBeGreaterThan(0);

          // Additional launches without terminate should NOT add more handlers
          for (let i = 1; i < launchCount; i++) {
            // Reset state to allow re-launch (simulate re-launch without terminate)
            // We need to set state back to allow launch() to proceed
            // In practice, launch() sets state to Initializing first
            await session.launch();
            const currentCount = trackedEvents.reduce(
              (sum, evt) => sum + getHandlerCount(evt), 0,
            );
            expect(currentCount).toBe(baselineCount);
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it('terminate unregisters handlers so the next launch registers exactly one set', async () => {
    const { client, getHandlerCount } = createMockDAPClient();
    const session = new SessionManager(
      stubConfig(), client, stubPathMapper(), stubNotifier(),
    );

    const trackedEvents = ['stopped', 'continued', 'terminated', 'exited', 'thread'];

    await session.launch();
    const firstCount = trackedEvents.reduce(
      (sum, evt) => sum + getHandlerCount(evt), 0,
    );

    await session.terminate();
    expect(trackedEvents.reduce((sum, evt) => sum + getHandlerCount(evt), 0)).toBe(0);

    await session.launch();

    // The backend outlives terminate() — DAPClient keeps its handler map and a
    // relaunch respawns into the same client — so anything above one set here
    // means every event is processed twice.
    const secondCount = trackedEvents.reduce(
      (sum, evt) => sum + getHandlerCount(evt), 0,
    );
    expect(secondCount).toBe(firstCount);
  });

  it('after terminate + relaunch, one stop is processed exactly once', async () => {
    const { client, eventHandlers } = createMockDAPClient();
    const session = new SessionManager(
      stubConfig(), client, stubPathMapper(), stubNotifier(),
    );

    await session.launch();
    await session.terminate();
    await session.launch();

    const before = session.suspensionId;
    const stopped: DebugProtocol.StoppedEvent = {
      seq: 0, type: 'event', event: 'stopped',
      body: { reason: 'breakpoint', threadId: 1, allThreadsStopped: false },
    };
    for (const handler of [...(eventHandlers.get('stopped') ?? [])]) handler(stopped);

    expect(session.suspensionId).toBe(before + 1);
    expect(session.status.pendingEventCount).toBe(1);
    expect(session.state).toBe(SessionState.Paused);
  });
});
