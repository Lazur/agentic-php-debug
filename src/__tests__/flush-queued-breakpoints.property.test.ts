import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';
import { SessionManager, SessionState, type NotificationSender } from '../session.js';
import type { DAPClient } from '../dap-client.js';
import type { PathMapper } from '../path-mapper.js';
import type { Config } from '../config.js';
import type { DebugProtocol } from '@vscode/debugprotocol';

// --- Reusable stubs (same patterns as session.test.ts) ---

function stubNotifier(): NotificationSender {
  return {
    sendProgress: async () => {},
    sendLog: async () => {},
    sendDebugEvent: async () => {},
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
  const sendRequestCalls: Array<{ command: string; args?: object }> = [];

  const client = {
    onEvent(name: string, handler: (event: DebugProtocol.Event) => void) {
      const list = eventHandlers.get(name) ?? [];
      list.push(handler);
      eventHandlers.set(name, list);
    },
    onAnyEvent() {},
    async initialize() { return {} as any; },
    async launch() { return {} as any; },
    async configurationDone() { return {} as any; },
    async sendRequest(command: string, args?: object) {
      sendRequestCalls.push({ command, args });
      return {} as any;
    },
    async disconnect() {},
    waitForEvent() { return Promise.resolve({} as DebugProtocol.Event); },
    isAlive() { return true; },
    getStatus() { return { alive: true, pid: 1234 }; },
  } as unknown as DAPClient;

  function fireEvent(name: string, body: Record<string, unknown> = {}) {
    const event: DebugProtocol.Event = { seq: 0, type: 'event', event: name, body };
    const handlers = eventHandlers.get(name) ?? [];
    for (const h of handlers) h(event);
  }

  return { client, fireEvent, sendRequestCalls };
}

// --- Arbitrary: random queued breakpoint arrays ---

const queuedBreakpointArb = fc.record({
  command: fc.constant('setBreakpoints'),
  args: fc.record({
    source: fc.record({ path: fc.stringMatching(/^\/[a-z]{1,10}\/[a-z]{1,10}\.php$/) }),
    breakpoints: fc.array(
      fc.record({ line: fc.integer({ min: 1, max: 500 }) }),
      { minLength: 1, maxLength: 5 },
    ),
  }),
});

const queuedBreakpointsArb = fc.array(queuedBreakpointArb, { minLength: 1, maxLength: 10 });

// --- Bug Exploration Test ---

describe('Feature: fix-queued-breakpoints-flush, Bug Regression: queued breakpoints ARE flushed on thread event', () => {
  /**
   * Regression test — confirms the fix for the original bug where
   * breakpoints queued while in Listening state were never sent to
   * the DAP adapter when a thread event fired.
   *
   * After the fix, flushQueuedBreakpoints() is called (with .catch())
   * from the thread event handler, so all queued breakpoints are sent.
   *
   * Requirements: 1.1
   */
  it('queued breakpoints ARE flushed when thread event fires (regression)', async () => {
    await fc.assert(
      fc.asyncProperty(queuedBreakpointsArb, async (breakpoints) => {
        const { client, fireEvent, sendRequestCalls } = createMockDAPClient();
        const session = new SessionManager(
          stubConfig(),
          client,
          stubPathMapper(),
          stubNotifier(),
        );

        // Launch to reach Listening state
        await session.launch();
        expect(session.state).toBe(SessionState.Listening);

        // Clear any sendRequest calls from the launch sequence
        sendRequestCalls.length = 0;

        // Queue breakpoints while in Listening state
        for (const bp of breakpoints) {
          session.queueBreakpoint(bp.command, bp.args);
        }

        // Fire thread event (Listening → Connected)
        fireEvent('thread', { threadId: 1, reason: 'started' });
        expect(session.state).toBe(SessionState.Connected);

        // Allow async flushQueuedBreakpoints to settle
        await new Promise((resolve) => setTimeout(resolve, 10));

        // FIX CONFIRMED: all queued breakpoints are now sent
        expect(sendRequestCalls.length).toBe(breakpoints.length);
        for (let i = 0; i < breakpoints.length; i++) {
          expect(sendRequestCalls[i].command).toBe(breakpoints[i].command);
          expect(sendRequestCalls[i].args).toEqual(breakpoints[i].args);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// --- Property 1: Flush sends all queued breakpoints and clears queue ---

const queuedBreakpointsArbP1 = fc.array(queuedBreakpointArb, { minLength: 0, maxLength: 20 });

describe('Feature: fix-queued-breakpoints-flush, Property 1: Flush sends all queued breakpoints and clears queue', () => {
  /**
   * Property 1: For any list of breakpoint requests queued while in Listening
   * state, when a thread event fires, all queued breakpoints SHALL be sent to
   * the DAP adapter via sendRequest, and the queue SHALL be empty afterward.
   *
   * Validates: Requirements 1.1, 1.2, 1.3, 3.3
   */
  it('all queued breakpoints are sent via sendRequest and queue is cleared after thread event', async () => {
    await fc.assert(
      fc.asyncProperty(queuedBreakpointsArbP1, async (breakpoints) => {
        const { client, fireEvent, sendRequestCalls } = createMockDAPClient();
        const session = new SessionManager(
          stubConfig(),
          client,
          stubPathMapper(),
          stubNotifier(),
        );

        // Launch to reach Listening state
        await session.launch();
        expect(session.state).toBe(SessionState.Listening);

        // Clear any sendRequest calls from the launch sequence
        sendRequestCalls.length = 0;

        // Queue breakpoints while in Listening state
        for (const bp of breakpoints) {
          session.queueBreakpoint(bp.command, bp.args);
        }

        // Fire thread event (Listening → Connected)
        fireEvent('thread', { threadId: 1, reason: 'started' });
        expect(session.state).toBe(SessionState.Connected);

        // Allow async flushQueuedBreakpoints to settle
        // flushQueuedBreakpoints is async but mock sendRequest resolves immediately,
        // so a single microtask flush is sufficient
        await new Promise((resolve) => setTimeout(resolve, 0));

        // All queued breakpoints should have been sent
        expect(sendRequestCalls.length).toBe(breakpoints.length);
        for (let i = 0; i < breakpoints.length; i++) {
          expect(sendRequestCalls[i].command).toBe(breakpoints[i].command);
          expect(sendRequestCalls[i].args).toEqual(breakpoints[i].args);
        }

        // Queue should be cleared: a second thread event (while already Connected)
        // should not produce any additional sendRequest calls
        const countAfterFlush = sendRequestCalls.length;
        fireEvent('thread', { threadId: 2, reason: 'started' });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(sendRequestCalls.length).toBe(countAfterFlush);
      }),
      { numRuns: 100 },
    );
  }, 30000);
});


// --- Property 2: Flush error resilience ---

/**
 * Creates a mock DAP client where sendRequest fails for specific indices.
 * Tracks all attempted sendRequest calls (both successful and failed).
 */
function createFailingMockDAPClient(failureIndices: Set<number>) {
  const eventHandlers = new Map<string, Array<(event: DebugProtocol.Event) => void>>();
  const attemptedCalls: Array<{ command: string; args?: object }> = [];
  let callIndex = 0;

  const client = {
    onEvent(name: string, handler: (event: DebugProtocol.Event) => void) {
      const list = eventHandlers.get(name) ?? [];
      list.push(handler);
      eventHandlers.set(name, list);
    },
    onAnyEvent() {},
    async initialize() { return {} as any; },
    async launch() { return {} as any; },
    async configurationDone() { return {} as any; },
    async sendRequest(command: string, args?: object) {
      const idx = callIndex++;
      attemptedCalls.push({ command, args });
      if (failureIndices.has(idx)) {
        throw new Error(`Simulated failure at index ${idx}`);
      }
      return {} as any;
    },
    async disconnect() {},
    waitForEvent() { return Promise.resolve({} as DebugProtocol.Event); },
    isAlive() { return true; },
    getStatus() { return { alive: true, pid: 1234 }; },
  } as unknown as DAPClient;

  function fireEvent(name: string, body: Record<string, unknown> = {}) {
    const event: DebugProtocol.Event = { seq: 0, type: 'event', event: name, body };
    const handlers = eventHandlers.get(name) ?? [];
    for (const h of handlers) h(event);
  }

  return { client, fireEvent, attemptedCalls };
}

/**
 * Arbitrary: generates a list of breakpoints (1–20) paired with a random
 * subset of indices that should fail during flush.
 */
const breakpointsWithFailuresArb = queuedBreakpointArb
  .chain((bp) =>
    fc.tuple(
      fc.array(fc.constant(bp), { minLength: 1, maxLength: 20 }),
    ).map(([bps]) => bps),
  )
  // Generate a list of breakpoints, then pick random failure indices
  .chain((bps) =>
    fc.tuple(
      fc.constant(bps),
      fc.subarray(
        Array.from({ length: bps.length }, (_, i) => i),
        { minLength: 1 },
      ),
    ),
  );

describe('Feature: fix-queued-breakpoints-flush, Property 2: Flush error resilience', () => {
  /**
   * Property 2: For any list of queued breakpoints where some sendRequest
   * calls fail, the SessionManager SHALL attempt to send all breakpoints
   * (not stop at the first failure), log each error, and still clear the queue.
   *
   * Validates: Requirements 1.4
   */
  it('all breakpoints are attempted, errors are logged, and queue is cleared despite failures', async () => {
    await fc.assert(
      fc.asyncProperty(breakpointsWithFailuresArb, async ([breakpoints, failureIndices]) => {
        const sendLogCalls: Array<{ level: string; message: string }> = [];
        const notifier: NotificationSender = {
          sendProgress: async () => {},
          sendLog: async (level: string, message: string) => {
            sendLogCalls.push({ level, message });
          },
          sendDebugEvent: async () => {},
        };

        // failureIndices are relative to the breakpoints array, but sendRequest
        // is also called during launch(). We need to offset by the number of
        // launch-phase calls. launch() calls: initialize, launch, configurationDone
        // — but those use dedicated methods, not sendRequest. The queue is empty
        // at launch, so sendRequest call index starts at 0 for flush calls.
        const failureSet = new Set(failureIndices);
        const { client, fireEvent, attemptedCalls } = createFailingMockDAPClient(failureSet);

        const session = new SessionManager(
          stubConfig(),
          client,
          stubPathMapper(),
          notifier,
        );

        await session.launch();
        expect(session.state).toBe(SessionState.Listening);

        // Reset call index tracking — launch doesn't call sendRequest for
        // queued BPs (queue is empty), but the mock's callIndex may have
        // advanced from launch-phase sendRequest calls. We track only
        // flush-phase attempts via attemptedCalls length.
        const callsBeforeFlush = attemptedCalls.length;

        // Queue breakpoints while in Listening state
        for (const bp of breakpoints) {
          session.queueBreakpoint(bp.command, bp.args);
        }

        // Clear sendLog calls from launch phase
        sendLogCalls.length = 0;

        // Fire thread event (Listening → Connected)
        fireEvent('thread', { threadId: 1, reason: 'started' });
        expect(session.state).toBe(SessionState.Connected);

        // Allow async flush to settle
        await new Promise((resolve) => setTimeout(resolve, 10));

        // All breakpoints should have been attempted (not stopped at first failure)
        const flushAttempts = attemptedCalls.length - callsBeforeFlush;
        expect(flushAttempts).toBe(breakpoints.length);

        // Each failure should have produced an error log
        const errorLogs = sendLogCalls.filter(
          (c) => c.level === 'error' && c.message.startsWith('Failed to flush queued breakpoint:'),
        );
        expect(errorLogs.length).toBe(failureIndices.length);

        // Queue should be cleared regardless of failures
        // Verify by checking queuedBreakpointCount if available, or by
        // firing another thread event and confirming no additional attempts
        const callsAfterFlush = attemptedCalls.length;
        fireEvent('thread', { threadId: 2, reason: 'started' });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(attemptedCalls.length).toBe(callsAfterFlush);
      }),
      { numRuns: 100 },
    );
  }, 30000);
});


// --- Property 3: nextAction text matches session state ---

import { handleDebugSetBreakpoints } from '../tools/debug-set-breakpoints.js';

/**
 * Arbitrary: random breakpoint spec for the debug-set-breakpoints tool.
 */
const breakpointInputArb = fc.record({
  path: fc.stringMatching(/^\/[a-z]{1,10}\/[a-z]{1,10}\.php$/),
  breakpoints: fc.array(
    fc.record({ line: fc.integer({ min: 1, max: 500 }) }),
    { minLength: 1, maxLength: 5 },
  ),
});

const sessionStateArb = fc.constantFrom(
  SessionState.Listening,
  SessionState.Connected,
  SessionState.Paused,
);

describe('Feature: fix-queued-breakpoints-flush, Property 3: nextAction text matches session state', () => {
  /**
   * Property 3: For any valid breakpoint specification and any allowed session
   * state (Listening, Connected, Paused), the nextAction field in the tool result
   * SHALL be the queued message when in Listening state, and the continue message
   * when in Connected or Paused state.
   *
   * Validates: Requirements 2.1, 2.2
   */
  it('nextAction text is correct for each session state', async () => {
    await fc.assert(
      fc.asyncProperty(breakpointInputArb, sessionStateArb, async (input, targetState) => {
        const { client, fireEvent, sendRequestCalls } = createMockDAPClient();
        const session = new SessionManager(
          stubConfig(),
          client,
          stubPathMapper(),
          stubNotifier(),
        );

        // Launch to reach Listening state
        await session.launch();
        expect(session.state).toBe(SessionState.Listening);

        // Transition to the target state
        if (targetState === SessionState.Connected) {
          fireEvent('thread', { threadId: 1, reason: 'started' });
          await new Promise((resolve) => setTimeout(resolve, 0));
        } else if (targetState === SessionState.Paused) {
          fireEvent('thread', { threadId: 1, reason: 'started' });
          await new Promise((resolve) => setTimeout(resolve, 0));
          fireEvent('stopped', { reason: 'breakpoint', threadId: 1 });
        }

        expect(session.state).toBe(targetState);

        // Clear sendRequest calls from state transitions
        sendRequestCalls.length = 0;

        const result = await handleDebugSetBreakpoints(session, input);
        expect(result.success).toBe(true);

        const data = result.data as any;
        // Breakpoints are always sent straight through — the adapter stores
        // them independently of Xdebug connections, so they must be registered
        // before one arrives.
        expect(data.queued).toBe(false);
        if (targetState === SessionState.Listening) {
          // No connection yet, so the adapter stores these and replays them
          // onto the connection when it arrives — they will apply.
          expect(data.applied).toBe(true);
          expect(data.nextAction).toBe(
            'Trigger PHP execution, then call debug_wait to wait for a breakpoint hit.',
          );
        } else if (targetState === SessionState.Connected) {
          // PHP is running: the adapter stages the write and skips the network
          // send, so it has NOT reached Xdebug and the caller must be told.
          expect(data.applied).toBe(false);
          expect(data.nextAction).toContain('not active until then');
          expect(data.warning).toContain('NOT applied');
        } else {
          expect(data.applied).toBe(true);
          expect(data.nextAction).toBe(
            'Call debug_continue or trigger PHP execution to hit breakpoints.',
          );
        }
      }),
      { numRuns: 100 },
    );
  }, 30000);
});


// --- Property 4: queuedBreakpointCount reflects queue length ---

const queueSequenceArb = fc.array(queuedBreakpointArb, { minLength: 0, maxLength: 15 });

describe('Feature: fix-queued-breakpoints-flush, Property 4: queuedBreakpointCount reflects queue length', () => {
  /**
   * Property 4: For any sequence of queueBreakpoint calls, the
   * status.queuedBreakpointCount SHALL equal the number of breakpoints
   * queued since the last flush or launch.
   *
   * Validates: Requirements 3.2
   */
  it('queuedBreakpointCount matches count at each step', async () => {
    await fc.assert(
      fc.asyncProperty(queueSequenceArb, async (breakpoints) => {
        const { client, fireEvent } = createMockDAPClient();
        const session = new SessionManager(
          stubConfig(),
          client,
          stubPathMapper(),
          stubNotifier(),
        );

        // Launch clears the queue — count should be 0
        await session.launch();
        expect(session.state).toBe(SessionState.Listening);
        expect(session.status.queuedBreakpointCount).toBe(0);

        // Queue breakpoints one by one, verifying count at each step
        for (let i = 0; i < breakpoints.length; i++) {
          session.queueBreakpoint(breakpoints[i].command, breakpoints[i].args);
          expect(session.status.queuedBreakpointCount).toBe(i + 1);
        }

        // Fire thread event to flush — count should drop to 0
        fireEvent('thread', { threadId: 1, reason: 'started' });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(session.status.queuedBreakpointCount).toBe(0);
      }),
      { numRuns: 100 },
    );
  }, 30000);
});
