/**
 * Property-based tests for handleDebugWait.
 * Feature: debug-wait
 */
import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { handleDebugWait } from '../tools/debug-wait.js';
import { SessionManager, SessionState, type NotificationSender } from '../session.js';
import type { DebugProtocol } from '@vscode/debugprotocol';
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
  const eventHandlers = new Map<string, Array<(event: DebugProtocol.Event) => void>>();

  const client = {
    onEvent: vi.fn((name: string, handler: (event: DebugProtocol.Event) => void) => {
      const list = eventHandlers.get(name) ?? [];
      list.push(handler);
      eventHandlers.set(name, list);
    }),
    offEvent: vi.fn((name: string, handler: (event: DebugProtocol.Event) => void) => {
      const list = eventHandlers.get(name);
      if (list) {
        const idx = list.indexOf(handler);
        if (idx !== -1) list.splice(idx, 1);
      }
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
    getSeq: vi.fn().mockReturnValue(1),
    onTrace: null,
    onStderr: null,
  };

  return { client, eventHandlers };
}

// --- Arbitrary generators ---

/** Generate a random StopInfo-like object. */
const arbStopInfo = fc.record({
  reason: fc.constantFrom('breakpoint', 'step', 'exception', 'pause', 'entry'),
  threadId: fc.integer({ min: 1, max: 100 }),
  description: fc.option(fc.string({ minLength: 0, maxLength: 30 }), { nil: undefined }),
  allThreadsStopped: fc.option(fc.boolean(), { nil: undefined }),
});

describe('Property 1: Already-paused immediate return', () => {
  /**
   * **Validates: Requirements 2.1, 2.2**
   *
   * For any SessionManager in Paused state with any valid StopInfo,
   * calling handleDebugWait SHALL return immediately with
   * reason: 'already_paused', event: null, body: null,
   * and a status reflecting the paused state.
   */
  it('returns immediately with already_paused for any paused session', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbStopInfo,
        fc.integer({ min: 1, max: 120_000 }),
        async (stopInfo, timeout) => {
          const { client } = createMockBackend();
          const session = new SessionManager(stubConfig(), client as any, stubPathMapper(), stubNotifier());

          // Launch to register event handlers, then simulate paused state
          await session.launch();
          // Fire stopped event to transition to Paused with the generated stopInfo
          const stoppedEvent: DebugProtocol.Event = {
            seq: 0,
            type: 'event',
            event: 'stopped',
            body: stopInfo,
          };
          const stoppedHandlers = (client.onEvent as any).mock.calls
            .filter((c: any[]) => c[0] === 'stopped')
            .map((c: any[]) => c[1]);
          for (const h of stoppedHandlers) h(stoppedEvent);

          // Verify session is paused
          expect(session.state).toBe(SessionState.Paused);

          const result = await handleDebugWait(session, { timeout });

          // Must be a success result
          expect(result.success).toBe(true);

          const data = result.data as any;
          // reason must be 'already_paused' (Req 2.2)
          expect(data.reason).toBe('already_paused');
          // event and body must be null (Req 2.1 — no event listeners registered)
          expect(data.event).toBeNull();
          expect(data.body).toBeNull();
          // status must reflect paused state
          expect(data.status.state).toBe(SessionState.Paused);
          expect(data.status.stopInfo).toBeDefined();
          expect(data.status.stopInfo.reason).toBe(stopInfo.reason);
          expect(data.status.stopInfo.threadId).toBe(stopInfo.threadId);

          // No event listeners should have been registered by handleDebugWait
          // (onEvent is called during launch, but not by handleDebugWait)
          const onEventCallsBeforeWait = client.onEvent.mock.calls.length;
          // handleDebugWait should not have added any new onEvent calls
          // We already called handleDebugWait above, so check offEvent was never called
          // (no listeners to clean up means offEvent shouldn't be called)
          expect(client.offEvent).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100 },
    );
  }, 30000);
});

describe('Property 2: Event resolution correctness', () => {
  /**
   * **Validates: Requirements 3.2, 7.2**
   *
   * For any event name in {stopped, thread, terminated, continued, exited}
   * and any event body, when that event fires on the DebugBackend during a wait,
   * handleDebugWait SHALL resolve with reason: 'event', event equal to the
   * fired event name, and body equal to the event body.
   */
  it('resolves with correct event name and body for any fired event', async () => {
    const WAIT_EVENTS = ['stopped', 'thread', 'terminated', 'continued', 'exited'] as const;

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...WAIT_EVENTS),
        fc.dictionary(
          fc.string({ minLength: 1, maxLength: 10 }).filter(s => /^[a-zA-Z_]/.test(s)),
          fc.oneof(fc.string({ maxLength: 20 }), fc.integer(), fc.boolean()),
          { minKeys: 0, maxKeys: 5 },
        ),
        async (eventName, bodyFields) => {
          const { client, eventHandlers } = createMockBackend();
          const session = new SessionManager(stubConfig(), client as any, stubPathMapper(), stubNotifier());

          // Launch to get into Listening state and register session event handlers
          await session.launch();
          expect(session.state).toBe(SessionState.Listening);

          // Start the wait (returns a promise that won't resolve until an event fires)
          const waitPromise = handleDebugWait(session, { timeout: 60_000 });

          // Build the DAP event with the generated body
          // For 'stopped' events, DAP requires reason + threadId in body
          // For 'thread' events, DAP requires reason + threadId in body
          // For 'exited' events, DAP requires exitCode in body
          let eventBody: Record<string, unknown>;
          if (eventName === 'stopped') {
            eventBody = { reason: 'breakpoint', threadId: 1, ...bodyFields };
          } else if (eventName === 'thread') {
            eventBody = { reason: 'started', threadId: 1, ...bodyFields };
          } else if (eventName === 'exited') {
            eventBody = { exitCode: 0, ...bodyFields };
          } else {
            eventBody = { ...bodyFields };
          }

          const dapEvent: DebugProtocol.Event = {
            seq: 0,
            type: 'event',
            event: eventName,
            body: eventBody,
          };

          // Fire the event — session handlers run first, then handleDebugWait's handler
          const handlers = eventHandlers.get(eventName) ?? [];
          for (const h of handlers) h(dapEvent);

          const result = await waitPromise;

          // Must be a success result
          expect(result.success).toBe(true);

          const data = result.data as any;
          // reason must be 'event' (Req 3.2)
          expect(data.reason).toBe('event');
          // event must match the fired event name (Req 7.2)
          expect(data.event).toBe(eventName);
          // body must equal the event body (Req 7.2)
          expect(data.body).toEqual(eventBody);
          // status must be present
          expect(data.status).toBeDefined();
          expect(data.status.state).toBeDefined();
        },
      ),
      { numRuns: 100 },
    );
  }, 30000);
});


describe('Property 3: First-event-wins', () => {
  /**
   * **Validates: Requirements 3.3**
   *
   * For any sequence of two or more events fired on the DebugBackend during a wait,
   * handleDebugWait SHALL resolve with the first event only, and the result SHALL
   * not contain any data from subsequent events.
   */
  it('resolves with the first event only when multiple events fire', async () => {
    const WAIT_EVENTS = ['stopped', 'thread', 'terminated', 'continued', 'exited'] as const;

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...WAIT_EVENTS),
        fc.constantFrom(...WAIT_EVENTS),
        fc.string({ minLength: 1, maxLength: 10 }),
        fc.string({ minLength: 1, maxLength: 10 }),
        async (firstEventName, secondEventName, firstMarker, secondMarker) => {
          const { client, eventHandlers } = createMockBackend();
          const session = new SessionManager(stubConfig(), client as any, stubPathMapper(), stubNotifier());

          await session.launch();
          expect(session.state).toBe(SessionState.Listening);

          const waitPromise = handleDebugWait(session, { timeout: 60_000 });

          // Build two distinct DAP events with unique marker values
          const buildBody = (eventName: string, marker: string): Record<string, unknown> => {
            if (eventName === 'stopped') return { reason: 'breakpoint', threadId: 1, marker };
            if (eventName === 'thread') return { reason: 'started', threadId: 1, marker };
            if (eventName === 'exited') return { exitCode: 0, marker };
            return { marker };
          };

          const firstBody = buildBody(firstEventName, firstMarker);
          const secondBody = buildBody(secondEventName, secondMarker);

          const firstDapEvent: DebugProtocol.Event = {
            seq: 0, type: 'event', event: firstEventName, body: firstBody,
          };
          const secondDapEvent: DebugProtocol.Event = {
            seq: 1, type: 'event', event: secondEventName, body: secondBody,
          };

          // Fire first event — all handlers for that event name
          const firstHandlers = [...(eventHandlers.get(firstEventName) ?? [])];
          for (const h of firstHandlers) h(firstDapEvent);

          // Fire second event — handlers may already be removed by cleanup
          const secondHandlers = [...(eventHandlers.get(secondEventName) ?? [])];
          for (const h of secondHandlers) h(secondDapEvent);

          const result = await waitPromise;

          expect(result.success).toBe(true);

          const data = result.data as any;
          // Must resolve with the first event (Req 3.3)
          expect(data.reason).toBe('event');
          expect(data.event).toBe(firstEventName);
          expect(data.body).toEqual(firstBody);

          // Must NOT contain data from the second event
          if (firstEventName !== secondEventName || firstMarker !== secondMarker) {
            // When events differ, the result must match the first, not the second
            if (firstEventName !== secondEventName) {
              expect(data.event).not.toBe(secondEventName);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  }, 30000);
});


describe('Property 4: Cleanup on all resolution paths', () => {
  /**
   * **Validates: Requirements 3.4, 4.4, 5.2, 8.1, 8.2, 8.3**
   *
   * For any resolution of handleDebugWait (via event, timeout, or cancellation),
   * all event listeners registered by the wait SHALL be removed from the DebugBackend,
   * and the timeout timer SHALL be cleared. The cleanup SHALL execute exactly once
   * regardless of which path resolves first.
   */

  const WAIT_EVENTS = ['stopped', 'thread', 'terminated', 'continued', 'exited'] as const;

  it('removes all listeners after event resolution', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...WAIT_EVENTS),
        async (eventName) => {
          const { client, eventHandlers } = createMockBackend();
          const session = new SessionManager(stubConfig(), client as any, stubPathMapper(), stubNotifier());

          await session.launch();

          // Count onEvent calls before handleDebugWait
          const onEventCallsBefore = client.onEvent.mock.calls.length;

          const waitPromise = handleDebugWait(session, { timeout: 60_000 });

          // handleDebugWait should have registered 5 listeners (one per WAIT_EVENT)
          const onEventCallsAfter = client.onEvent.mock.calls.length;
          const registeredCount = onEventCallsAfter - onEventCallsBefore;
          expect(registeredCount).toBe(5);

          // Fire the event
          const body = eventName === 'stopped'
            ? { reason: 'breakpoint', threadId: 1 }
            : eventName === 'thread'
              ? { reason: 'started', threadId: 1 }
              : eventName === 'exited'
                ? { exitCode: 0 }
                : {};

          const dapEvent: DebugProtocol.Event = {
            seq: 0, type: 'event', event: eventName, body,
          };

          const handlers = [...(eventHandlers.get(eventName) ?? [])];
          for (const h of handlers) h(dapEvent);

          await waitPromise;

          // offEvent must have been called exactly 5 times (once per WAIT_EVENT) (Req 8.1)
          expect(client.offEvent).toHaveBeenCalledTimes(5);

          // All 5 WAIT_EVENTS must have had their listener removed
          const removedEvents = client.offEvent.mock.calls.map((c: any[]) => c[0]);
          for (const ev of WAIT_EVENTS) {
            expect(removedEvents).toContain(ev);
          }

          // The handleDebugWait listeners should no longer be in the eventHandlers map
          // (only session's own handlers should remain)
          for (const ev of WAIT_EVENTS) {
            const remaining = eventHandlers.get(ev) ?? [];
            // Session registers its own handlers during launch; handleDebugWait's should be gone
            for (const call of client.offEvent.mock.calls) {
              if (call[0] === ev) {
                expect(remaining).not.toContain(call[1]);
              }
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  }, 30000);

  it('removes all listeners after timeout resolution', async () => {
    vi.useFakeTimers();
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 5000 }),
          async (timeout) => {
            const { client } = createMockBackend();
            const session = new SessionManager(stubConfig(), client as any, stubPathMapper(), stubNotifier());

            await session.launch();
            client.offEvent.mockClear();

            const waitPromise = handleDebugWait(session, { timeout });

            // Advance time past the timeout
            vi.advanceTimersByTime(timeout + 1);

            const result = await waitPromise;
            const data = result.data as any;
            expect(data.reason).toBe('timeout');

            // offEvent must have been called exactly 5 times (Req 4.4, 8.1)
            expect(client.offEvent).toHaveBeenCalledTimes(5);

            const removedEvents = client.offEvent.mock.calls.map((c: any[]) => c[0]);
            for (const ev of WAIT_EVENTS) {
              expect(removedEvents).toContain(ev);
            }
          },
        ),
        { numRuns: 100 },
      );
    } finally {
      vi.useRealTimers();
    }
  }, 30000);

  it('removes all listeners after cancellation resolution', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1000, max: 60_000 }),
        async (timeout) => {
          const { client } = createMockBackend();
          const session = new SessionManager(stubConfig(), client as any, stubPathMapper(), stubNotifier());

          await session.launch();
          client.offEvent.mockClear();

          let abortCb: (() => void) | undefined;
          const signal = {
            aborted: false,
            onAbort(cb: () => void) { abortCb = cb; },
          };

          const waitPromise = handleDebugWait(session, { timeout }, signal);

          // Trigger cancellation
          signal.aborted = true;
          abortCb!();

          const result = await waitPromise;
          const data = result.data as any;
          expect(data.reason).toBe('cancelled');

          // offEvent must have been called exactly 5 times (Req 5.2, 8.1)
          expect(client.offEvent).toHaveBeenCalledTimes(5);

          const removedEvents = client.offEvent.mock.calls.map((c: any[]) => c[0]);
          for (const ev of WAIT_EVENTS) {
            expect(removedEvents).toContain(ev);
          }
        },
      ),
      { numRuns: 100 },
    );
  }, 30000);

  it('cleanup executes exactly once when event and timeout race', async () => {
    vi.useFakeTimers();
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...WAIT_EVENTS),
          fc.integer({ min: 1, max: 100 }),
          async (eventName, timeout) => {
            const { client, eventHandlers } = createMockBackend();
            const session = new SessionManager(stubConfig(), client as any, stubPathMapper(), stubNotifier());

            await session.launch();
            client.offEvent.mockClear();

            const waitPromise = handleDebugWait(session, { timeout });

            // Fire event AND advance timer simultaneously
            const body = eventName === 'stopped'
              ? { reason: 'breakpoint', threadId: 1 }
              : eventName === 'thread'
                ? { reason: 'started', threadId: 1 }
                : eventName === 'exited'
                  ? { exitCode: 0 }
                  : {};

            const dapEvent: DebugProtocol.Event = {
              seq: 0, type: 'event', event: eventName, body,
            };

            const handlers = [...(eventHandlers.get(eventName) ?? [])];
            for (const h of handlers) h(dapEvent);

            // Also advance timer past timeout
            vi.advanceTimersByTime(timeout + 1);

            const result = await waitPromise;
            expect(result.success).toBe(true);

            // Cleanup must execute exactly once — offEvent called exactly 5 times (Req 8.3)
            expect(client.offEvent).toHaveBeenCalledTimes(5);
          },
        ),
        { numRuns: 100 },
      );
    } finally {
      vi.useRealTimers();
    }
  }, 30000);
});



describe('Property 5: Timeout resolution', () => {
  /**
   * **Validates: Requirements 4.3, 7.3**
   *
   * For any positive timeout value, if no event fires and no cancellation occurs
   * within that duration, handleDebugWait SHALL resolve with reason: 'timeout',
   * event: null, body: null, and the current session status.
   */
  it('resolves with timeout reason, null event/body, and valid status for any positive timeout', async () => {
    vi.useFakeTimers();
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 120_000 }),
          async (timeout) => {
            const { client } = createMockBackend();
            const session = new SessionManager(stubConfig(), client as any, stubPathMapper(), stubNotifier());

            await session.launch();
            expect(session.state).toBe(SessionState.Listening);

            const waitPromise = handleDebugWait(session, { timeout });

            // Advance time past the timeout — no events fired, no cancellation
            vi.advanceTimersByTime(timeout + 1);

            const result = await waitPromise;

            // Must be a success result
            expect(result.success).toBe(true);

            const data = result.data as any;
            // reason must be 'timeout' (Req 4.3)
            expect(data.reason).toBe('timeout');
            // event must be null (Req 7.3)
            expect(data.event).toBeNull();
            // body must be null (Req 7.3)
            expect(data.body).toBeNull();
            // status must be present and reflect current session state
            expect(data.status).toBeDefined();
            expect(data.status.state).toBe(SessionState.Listening);
          },
        ),
        { numRuns: 100 },
      );
    } finally {
      vi.useRealTimers();
    }
  }, 30000);
});


describe('Property 6: Cancellation resolution', () => {
  /**
   * **Validates: Requirements 5.1, 5.3, 7.3**
   *
   * For any cancellation signal received before an event fires or timeout elapses,
   * handleDebugWait SHALL resolve with reason: 'cancelled', event: null, body: null,
   * and the current session status.
   */

  it('resolves with cancelled reason when signal fires before any event or timeout', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1000, max: 120_000 }),
        async (timeout) => {
          const { client } = createMockBackend();
          const session = new SessionManager(stubConfig(), client as any, stubPathMapper(), stubNotifier());

          await session.launch();
          expect(session.state).toBe(SessionState.Listening);

          let abortCb: (() => void) | undefined;
          const signal = {
            aborted: false,
            onAbort(cb: () => void) { abortCb = cb; },
          };

          const waitPromise = handleDebugWait(session, { timeout }, signal);

          // Trigger cancellation before any event fires (Req 5.1)
          signal.aborted = true;
          abortCb!();

          const result = await waitPromise;

          expect(result.success).toBe(true);

          const data = result.data as any;
          // reason must be 'cancelled' (Req 5.1)
          expect(data.reason).toBe('cancelled');
          // event must be null (Req 7.3)
          expect(data.event).toBeNull();
          // body must be null (Req 7.3)
          expect(data.body).toBeNull();
          // status must be present and reflect current session state
          expect(data.status).toBeDefined();
          expect(data.status.state).toBeDefined();
        },
      ),
      { numRuns: 100 },
    );
  }, 30000);

  it('returns immediately with cancelled when signal is already aborted at invocation time', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 120_000 }),
        async (timeout) => {
          const { client } = createMockBackend();
          const session = new SessionManager(stubConfig(), client as any, stubPathMapper(), stubNotifier());

          await session.launch();
          expect(session.state).toBe(SessionState.Listening);

          // Signal already aborted before calling handleDebugWait (Req 5.3)
          const signal = {
            aborted: true,
            onAbort: vi.fn(),
          };

          const onEventCallsBefore = client.onEvent.mock.calls.length;

          const result = await handleDebugWait(session, { timeout }, signal);

          expect(result.success).toBe(true);

          const data = result.data as any;
          // reason must be 'cancelled' (Req 5.3)
          expect(data.reason).toBe('cancelled');
          // event must be null (Req 7.3)
          expect(data.event).toBeNull();
          // body must be null (Req 7.3)
          expect(data.body).toBeNull();
          // status must be present
          expect(data.status).toBeDefined();
          expect(data.status.state).toBeDefined();

          // No event listeners should have been registered (immediate return)
          const onEventCallsAfter = client.onEvent.mock.calls.length;
          expect(onEventCallsAfter).toBe(onEventCallsBefore);

          // onAbort should not have been called (no need to register abort handler)
          expect(signal.onAbort).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100 },
    );
  }, 30000);
});


describe('Property 8: Timeout guidance existence', () => {
  /**
   * **Validates: Requirements 13.1**
   *
   * For any session state, when handleDebugWait returns with reason 'timeout',
   * the result data should contain a non-empty guidance string.
   */
  it('timeout result includes non-empty guidance string for any session state', async () => {
    vi.useFakeTimers();
    try {
      // Test with Listening state (reachable via launch)
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 5000 }),
          async (timeout) => {
            const { client } = createMockBackend();
            const session = new SessionManager(stubConfig(), client as any, stubPathMapper(), stubNotifier());

            await session.launch();
            expect(session.state).toBe(SessionState.Listening);

            const waitPromise = handleDebugWait(session, { timeout });
            vi.advanceTimersByTime(timeout + 1);

            const result = await waitPromise;
            expect(result.success).toBe(true);

            const data = result.data as any;
            expect(data.reason).toBe('timeout');
            // guidance must be a non-empty string (Req 13.1)
            expect(typeof data.guidance).toBe('string');
            expect(data.guidance.length).toBeGreaterThan(0);
          },
        ),
        { numRuns: 100 },
      );
    } finally {
      vi.useRealTimers();
    }
  }, 30000);

  it('timeout guidance exists for Connected state', async () => {
    vi.useFakeTimers();
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 5000 }),
          async (timeout) => {
            const { client, eventHandlers } = createMockBackend();
            const session = new SessionManager(stubConfig(), client as any, stubPathMapper(), stubNotifier());

            await session.launch();
            // Fire a thread event to transition to Connected
            const threadHandlers = eventHandlers.get('thread') ?? [];
            const threadEvent = { seq: 0, type: 'event', event: 'thread', body: { reason: 'started', threadId: 1 } };
            for (const h of threadHandlers) h(threadEvent as any);
            expect(session.state).toBe(SessionState.Connected);

            // The thread event fired with no wait in flight, so the first wait
            // replays it from the buffer rather than blocking — that is the
            // whole point of the buffer. Drain it before testing the timeout.
            const replay = (await handleDebugWait(session, { timeout })).data as any;
            expect(replay.reason).toBe('event');
            expect(replay.event).toBe('thread');
            expect(replay.replayed).toBe(true);

            const waitPromise = handleDebugWait(session, { timeout });
            vi.advanceTimersByTime(timeout + 1);

            const result = await waitPromise;
            expect(result.success).toBe(true);

            const data = result.data as any;
            expect(data.reason).toBe('timeout');
            expect(typeof data.guidance).toBe('string');
            expect(data.guidance.length).toBeGreaterThan(0);
          },
        ),
        { numRuns: 100 },
      );
    } finally {
      vi.useRealTimers();
    }
  }, 30000);
});


describe('Property 9: Event replay for events fired between tool calls', () => {
  /**
   * debug_wait registers its listeners at call time, so an event that fires
   * while no wait is in flight has nobody to catch it. Buffering plus a drain
   * at the top of the wait is what stops it being lost — and stops the next
   * wait from blocking for its full timeout waiting for something that already
   * happened.
   */

  const WAIT_EVENTS = ['thread', 'terminated', 'continued', 'exited'] as const;

  function bodyFor(eventName: string): Record<string, unknown> {
    if (eventName === 'stopped') return { reason: 'breakpoint', threadId: 1 };
    if (eventName === 'thread') return { reason: 'started', threadId: 1 };
    if (eventName === 'exited') return { exitCode: 0 };
    return {};
  }

  function fire(eventHandlers: Map<string, any[]>, eventName: string, seq = 0) {
    const event = { seq, type: 'event', event: eventName, body: bodyFor(eventName) };
    for (const h of [...(eventHandlers.get(eventName) ?? [])]) h(event as any);
    return event;
  }

  it('replays any event that fired before the wait, without blocking', async () => {
    vi.useFakeTimers();
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...WAIT_EVENTS),
          fc.integer({ min: 1000, max: 120_000 }),
          async (eventName, timeout) => {
            const { client, eventHandlers } = createMockBackend();
            const session = new SessionManager(stubConfig(), client as any, stubPathMapper(), stubNotifier());
            await session.launch();

            const fired = fire(eventHandlers, eventName);

            // No timer is advanced. If the wait blocked, this would hang.
            const data = (await handleDebugWait(session, { timeout })).data as any;

            expect(data.reason).toBe('event');
            expect(data.event).toBe(eventName);
            expect(data.replayed).toBe(true);
            expect(data.body).toEqual(fired.body);
          },
        ),
        { numRuns: 50 },
      );
    } finally {
      vi.useRealTimers();
    }
  }, 30000);

  it('drains buffered events oldest-first, one per wait', async () => {
    vi.useFakeTimers();
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...WAIT_EVENTS),
          fc.constantFrom(...WAIT_EVENTS),
          async (first, second) => {
            const { client, eventHandlers } = createMockBackend();
            const session = new SessionManager(stubConfig(), client as any, stubPathMapper(), stubNotifier());
            await session.launch();

            fire(eventHandlers, first, 0);
            fire(eventHandlers, second, 1);

            const a = (await handleDebugWait(session, { timeout: 60_000 })).data as any;
            expect(a.event).toBe(first);
            expect(a.replayed).toBe(true);
            expect(a.remainingBufferedEvents).toBe(1);

            const b = (await handleDebugWait(session, { timeout: 60_000 })).data as any;
            expect(b.event).toBe(second);
            expect(b.replayed).toBe(true);
            expect(b.remainingBufferedEvents).toBe(0);
          },
        ),
        { numRuns: 50 },
      );
    } finally {
      vi.useRealTimers();
    }
  }, 30000);

  it('a buffered stopped is reported as already_paused, and not replayed twice', async () => {
    vi.useFakeTimers();
    try {
      const { client, eventHandlers } = createMockBackend();
      const session = new SessionManager(stubConfig(), client as any, stubPathMapper(), stubNotifier());
      await session.launch();

      fire(eventHandlers, 'stopped');
      expect(session.state).toBe(SessionState.Paused);

      // The paused early return already reports the stop, so it wins over the
      // replay and consumes the buffer rather than leaving it stale.
      const first = (await handleDebugWait(session, { timeout: 60_000 })).data as any;
      expect(first.reason).toBe('already_paused');
      expect(first.status.pendingEventCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns immediately once terminated with nothing buffered', async () => {
    vi.useFakeTimers();
    try {
      const { client, eventHandlers } = createMockBackend();
      const session = new SessionManager(stubConfig(), client as any, stubPathMapper(), stubNotifier());
      await session.launch();

      fire(eventHandlers, 'terminated');
      expect(session.state).toBe(SessionState.Terminated);

      // First wait drains the buffered terminated event...
      const replay = (await handleDebugWait(session, { timeout: 60_000 })).data as any;
      expect(replay.event).toBe('terminated');

      // ...and the next must not block 60s for an event that can never arrive.
      const after = (await handleDebugWait(session, { timeout: 60_000 })).data as any;
      expect(after.reason).toBe('timeout');
      expect(after.guidance).toContain('Session has ended');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not buffer breakpoint events — they must not resolve a wait', async () => {
    vi.useFakeTimers();
    try {
      const { client, eventHandlers } = createMockBackend();
      const session = new SessionManager(stubConfig(), client as any, stubPathMapper(), stubNotifier());
      await session.launch();

      const bpEvent = {
        seq: 0, type: 'event', event: 'breakpoint',
        body: { reason: 'changed', breakpoint: { id: 7, verified: true, line: 12 } },
      };
      for (const h of [...(eventHandlers.get('breakpoint') ?? [])]) h(bpEvent as any);

      // Recorded for later inspection...
      expect(session.getVerification(7)).toMatchObject({ verified: true, line: 12 });
      // ...but invisible to the wait loop.
      expect(session.status.pendingEventCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  /** Run one wait to completion, advancing fake time in case it blocks. */
  async function waitOnce(session: SessionManager, timeout: number) {
    const pending = handleDebugWait(session, { timeout });
    await vi.advanceTimersByTimeAsync(timeout);
    return (await pending).data as any;
  }

  it('an event caught live is not replayed by the next wait', async () => {
    // The session buffers every wait event in its own handler, which runs
    // before the wait's listener. Before the fix, the buffered copy survived
    // and the next debug_wait reported the same event a second time.
    vi.useFakeTimers();
    try {
      await fc.assert(
        fc.asyncProperty(fc.constantFrom(...WAIT_EVENTS), async (eventName) => {
          const { client, eventHandlers } = createMockBackend();
          const session = new SessionManager(stubConfig(), client as any, stubPathMapper(), stubNotifier());
          await session.launch();

          const live = handleDebugWait(session, { timeout: 60_000 });
          fire(eventHandlers, eventName);
          const a = (await live).data as any;
          expect(a.reason).toBe('event');
          expect(a.event).toBe(eventName);
          expect(a.replayed).toBeUndefined();
          expect(a.status.pendingEventCount).toBe(0);

          const b = await waitOnce(session, 10);
          expect(b.reason).toBe('timeout');
        }),
        { numRuns: 20 },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('a burst caught live reports its first event live and replays the rest once', async () => {
    // disposeConnection sends `continued` then `thread` exited in one go.
    vi.useFakeTimers();
    try {
      const { client, eventHandlers } = createMockBackend();
      const session = new SessionManager(stubConfig(), client as any, stubPathMapper(), stubNotifier());
      await session.launch();
      fire(eventHandlers, 'thread');
      expect((await waitOnce(session, 10)).replayed).toBe(true);

      const live = handleDebugWait(session, { timeout: 60_000 });
      const continued = { seq: 1, type: 'event', event: 'continued', body: { threadId: 1, allThreadsContinued: false } };
      const exited = { seq: 2, type: 'event', event: 'thread', body: { reason: 'exited', threadId: 1 } };
      for (const h of [...(eventHandlers.get('continued') ?? [])]) h(continued as any);
      for (const h of [...(eventHandlers.get('thread') ?? [])]) h(exited as any);

      const a = (await live).data as any;
      expect(a.event).toBe('continued');
      expect(a.replayed).toBeUndefined();

      const b = await waitOnce(session, 10);
      expect(b.event).toBe('thread');
      expect(b.body).toEqual({ reason: 'exited', threadId: 1 });
      expect(b.replayed).toBe(true);
      expect(b.remainingBufferedEvents).toBe(0);

      const c = await waitOnce(session, 10);
      expect(c.reason).toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });
});
