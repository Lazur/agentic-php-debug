import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { SessionManager, SessionState, type NotificationSender } from '../session.js';
import type { DAPClient } from '../dap-client.js';
import type { PathMapper } from '../path-mapper.js';
import type { Config } from '../config.js';
import type { DebugProtocol } from '@vscode/debugprotocol';

// --- Minimal mocks / stubs ---

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

/**
 * Creates a mock DAPClient that records event handlers and allows
 * simulating DAP events. The launch sequence (initialize → launch →
 * waitForEvent → configurationDone) resolves immediately.
 */
function createMockDAPClient() {
  const eventHandlers = new Map<string, Array<(event: DebugProtocol.Event) => void>>();

  const client = {
    onEvent(name: string, handler: (event: DebugProtocol.Event) => void) {
      const list = eventHandlers.get(name) ?? [];
      list.push(handler);
      eventHandlers.set(name, list);
    },
    onAnyEvent() {},
    async initialize() {
      return {} as any;
    },
    async launch() {
      return {} as any;
    },
    async configurationDone() {
      return {} as any;
    },
    async sendRequest() {
      return {} as any;
    },
    async disconnect() {},
    waitForEvent(_name: string) {
      return Promise.resolve({} as DebugProtocol.Event);
    },
    isAlive() {
      return true;
    },
    getStatus() {
      return { alive: true, pid: 1234 };
    },
  } as unknown as DAPClient;

  /** Fire a DAP event to all registered handlers for that event name. */
  function fireEvent(name: string, body: Record<string, unknown> = {}) {
    const event: DebugProtocol.Event = {
      seq: 0,
      type: 'event',
      event: name,
      body,
    };
    const handlers = eventHandlers.get(name) ?? [];
    for (const h of handlers) h(event);
  }

  return { client, fireEvent };
}

// --- State machine definitions ---

/**
 * Valid transitions as implemented by the SessionManager event handlers.
 *
 * The design diagram shows the *intended* happy-path transitions, but the
 * implementation's event handlers can fire from any post-launch state
 * (since DAP events may arrive in any order). This table captures the
 * transitions the implementation actually permits once event handlers
 * are registered (i.e., after launch() has been called).
 *
 * NotStarted and Initializing are not reachable post-launch, so they
 * only have the launch-driven transitions.
 */
const VALID_TRANSITIONS: Record<SessionState, SessionState[]> = {
  [SessionState.NotStarted]: [SessionState.Initializing],
  [SessionState.Initializing]: [SessionState.Listening],
  [SessionState.Listening]: [SessionState.Connected, SessionState.Paused, SessionState.Terminated],
  [SessionState.Connected]: [SessionState.Paused, SessionState.Terminated],
  [SessionState.Paused]: [SessionState.Connected, SessionState.Paused, SessionState.Terminated],
  // Terminated is now sticky: recomputeSuspension() and markResumed() both
  // refuse to leave it, so the last two are unreachable in practice. Left in
  // the permitted set because this table asserts "no transition outside this
  // list" — being stricter than it allows still passes.
  [SessionState.Terminated]: [SessionState.Initializing, SessionState.Paused, SessionState.Connected],
};

/**
 * DAP events that can cause state transitions, along with the states
 * from which they are meaningful and the resulting state.
 */
type DAPEventSpec = {
  name: string;
  body: Record<string, unknown>;
  /** States from which this event causes a transition. */
  fromStates: SessionState[];
  /** The resulting state after the event fires. */
  toState: SessionState;
};

const DAP_EVENTS: DAPEventSpec[] = [
  {
    name: 'thread',
    body: { threadId: 1, reason: 'started' },
    fromStates: [SessionState.Listening],
    toState: SessionState.Connected,
  },
  {
    name: 'stopped',
    body: { reason: 'breakpoint', threadId: 1, allThreadsStopped: true },
    fromStates: [SessionState.Connected, SessionState.Paused],
    toState: SessionState.Paused,
  },
  {
    // NOTE: this event is NOT how a continue/step reaches Connected. Per DAP a
    // debug adapter "is not expected to send this event in response to a
    // request that implies that execution continues", and vscode-php-debug only
    // emits it from disposeConnection. The continuation tools call
    // SessionManager.markResumed() instead — see resume-state.test.ts. This
    // entry covers the connection-teardown case and the VS Code backend's
    // synthesized poll event.
    name: 'continued',
    body: { threadId: 1 },
    fromStates: [SessionState.Paused],
    toState: SessionState.Connected,
  },
  {
    name: 'terminated',
    body: {},
    fromStates: [SessionState.Listening, SessionState.Connected, SessionState.Paused],
    toState: SessionState.Terminated,
  },
  {
    name: 'exited',
    body: { exitCode: 0 },
    fromStates: [SessionState.Listening, SessionState.Connected, SessionState.Paused],
    toState: SessionState.Terminated,
  },
];

/**
 * Arbitrary: generates a random sequence of DAP event names (from the
 * events that the session manager handles).
 */
const dapEventSequenceArb = fc.array(fc.constantFrom(...DAP_EVENTS.map((e) => e.name)), {
  minLength: 1,
  maxLength: 30,
});

// --- Property 7: Session state machine validity ---

describe('Property 7: Session state machine validity', () => {
  /**
   * Property 7: Session state machine validity
   *
   * For any sequence of DAP events applied to a session starting in
   * `listening` state (post-launch), the session shall only transition
   * through valid states as defined by the state machine.
   *
   * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 5.6
   */
  it('only valid state transitions occur for any sequence of DAP events', async () => {
    await fc.assert(
      fc.asyncProperty(dapEventSequenceArb, async (eventNames) => {
        const { client, fireEvent } = createMockDAPClient();
        const session = new SessionManager(stubConfig(), client, stubPathMapper(), stubNotifier());

        // Launch to get into Listening state (registers event handlers)
        await session.launch();
        expect(session.state).toBe(SessionState.Listening);

        let previousState = session.state;

        for (const eventName of eventNames) {
          const spec = DAP_EVENTS.find((e) => e.name === eventName)!;
          fireEvent(eventName, spec.body);

          const currentState = session.state;

          if (currentState !== previousState) {
            // A transition occurred — verify it's valid
            const allowed = VALID_TRANSITIONS[previousState];
            expect(
              allowed,
              `Transition from ${previousState} to ${currentState} triggered by "${eventName}" is not in valid transitions`,
            ).toContain(currentState);
          }

          previousState = currentState;
        }
      }),
      { numRuns: 100 },
    );
  });
});

// --- Property 8: Session state guards ---

describe('Property 8: Session state guards', () => {
  /**
   * Property 8: Session state guards
   *
   * For any tool that requires a specific session state and for any
   * session state that does not satisfy that requirement, invoking
   * assertState shall throw an error and the session state shall
   * remain unchanged.
   *
   * Validates: Requirements 3.5, 3.6
   */

  /**
   * Reachable stable states — excludes Initializing which is transient
   * (launch() passes through it synchronously in our mock).
   */
  const reachableStates = [
    SessionState.NotStarted,
    SessionState.Listening,
    SessionState.Connected,
    SessionState.Paused,
    SessionState.Terminated,
  ];

  const allStates = Object.values(SessionState) as SessionState[];

  /**
   * Arbitrary: generates a non-empty subset of SessionState values
   * (the "allowed" states for an assertState call) and a reachable state
   * that is NOT in that subset.
   */
  const stateGuardArb = fc
    .tuple(
      fc.subarray(allStates, { minLength: 1, maxLength: allStates.length - 1 }),
      fc.constantFrom(...reachableStates),
    )
    .filter(([allowed, actual]) => !allowed.includes(actual));

  it('assertState throws for any disallowed state and leaves state unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(stateGuardArb, async ([allowedStates, actualState]) => {
        const { client, fireEvent } = createMockDAPClient();
        const session = new SessionManager(stubConfig(), client, stubPathMapper(), stubNotifier());

        // Drive the session to the desired actualState
        await driveToState(session, actualState, fireEvent);
        expect(session.state).toBe(actualState);

        // assertState should throw because actualState is not in allowedStates
        expect(() => session.assertState(...allowedStates)).toThrow(/Invalid session state/);

        // State must remain unchanged after the failed assertion
        expect(session.state).toBe(actualState);
      }),
      { numRuns: 100 },
    );
  });

  it('assertState does NOT throw when state is in the allowed set', async () => {
    const stateGuardPassArb = fc
      .tuple(fc.subarray(allStates, { minLength: 1, maxLength: allStates.length }), fc.constantFrom(...reachableStates))
      .filter(([allowed, actual]) => allowed.includes(actual));

    await fc.assert(
      fc.asyncProperty(stateGuardPassArb, async ([allowedStates, actualState]) => {
        const { client, fireEvent } = createMockDAPClient();
        const session = new SessionManager(stubConfig(), client, stubPathMapper(), stubNotifier());

        await driveToState(session, actualState, fireEvent);
        expect(session.state).toBe(actualState);

        // Should NOT throw
        expect(() => session.assertState(...allowedStates)).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * Helper: drives a SessionManager from NotStarted to the target state
 * by launching and then firing the appropriate DAP events.
 */
async function driveToState(
  session: SessionManager,
  target: SessionState,
  fireEvent: (name: string, body: Record<string, unknown>) => void,
): Promise<void> {
  if (target === SessionState.NotStarted) return;

  // Launch gets us to Listening (through Initializing).
  // Initializing is transient — launch() completes synchronously in our mock.
  await session.launch();

  if (target === SessionState.Listening) return;

  // Fire thread event to get to Connected
  fireEvent('thread', { threadId: 1, reason: 'started' });
  if (target === SessionState.Connected) return;

  // Fire stopped event to get to Paused
  fireEvent('stopped', { reason: 'breakpoint', threadId: 1, allThreadsStopped: true });
  if (target === SessionState.Paused) return;

  // Fire terminated event to get to Terminated
  fireEvent('terminated', {});
  if (target === SessionState.Terminated) return;
}

// --- Property 17: Debug status accuracy ---

describe('Property 17: Debug status accuracy', () => {
  /**
   * Property 17: Debug status accuracy
   *
   * For any session state, calling `status` shall return a SessionStatus
   * object whose `state` field matches the actual session state, whose
   * `adapterAlive` field matches whether the adapter process is running,
   * and whose `pendingEventCount` is non-negative.
   *
   * Validates: Requirements 2.7
   */

  const reachableStates: SessionState[] = [
    SessionState.NotStarted,
    SessionState.Listening,
    SessionState.Connected,
    SessionState.Paused,
    SessionState.Terminated,
  ];

  /**
   * Arbitrary: generates a reachable session state paired with a random
   * adapter alive/dead status and an optional sequence of events that
   * add to pendingEvents.
   */
  const statusScenarioArb = fc.record({
    targetState: fc.constantFrom(...reachableStates),
    adapterAlive: fc.boolean(),
    adapterPid: fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined }),
    /** Number of extra stopped/terminated/exited events to fire after reaching target state */
    extraEventCount: fc.integer({ min: 0, max: 5 }),
  });

  it('status reflects actual state, adapter liveness, and non-negative pending event count', async () => {
    await fc.assert(
      fc.asyncProperty(statusScenarioArb, async ({ targetState, adapterAlive, adapterPid, extraEventCount }) => {
        const eventHandlers = new Map<string, Array<(event: DebugProtocol.Event) => void>>();

        // Mock DAPClient with configurable alive/pid status
        const client = {
          onEvent(name: string, handler: (event: DebugProtocol.Event) => void) {
            const list = eventHandlers.get(name) ?? [];
            list.push(handler);
            eventHandlers.set(name, list);
          },
          onAnyEvent() {},
          async initialize() {
            return {} as any;
          },
          async launch() {
            return {} as any;
          },
          async configurationDone() {
            return {} as any;
          },
          async sendRequest() {
            return {} as any;
          },
          async disconnect() {},
          waitForEvent() {
            return Promise.resolve({} as DebugProtocol.Event);
          },
          isAlive() {
            return adapterAlive;
          },
          getStatus() {
            return {
              alive: adapterAlive,
              pid: adapterPid,
              exitCode: adapterAlive ? undefined : 0,
            };
          },
        } as unknown as DAPClient;

        function fireEvent(name: string, body: Record<string, unknown> = {}) {
          const event: DebugProtocol.Event = { seq: 0, type: 'event', event: name, body };
          const handlers = eventHandlers.get(name) ?? [];
          for (const h of handlers) h(event);
        }

        const session = new SessionManager(stubConfig(), client, stubPathMapper(), stubNotifier());

        // Drive to target state
        await driveToState(session, targetState, fireEvent);
        expect(session.state).toBe(targetState);

        // Fire extra events that accumulate in pendingEvents (stopped, terminated, exited push to pendingEvents)
        // Only fire events that are meaningful in the current state to avoid unexpected transitions
        // We fire stopped events if in Connected or Paused (they add to pendingEvents)
        if (targetState === SessionState.Connected || targetState === SessionState.Paused) {
          for (let i = 0; i < extraEventCount; i++) {
            fireEvent('stopped', { reason: 'breakpoint', threadId: 1, allThreadsStopped: true });
          }
        }

        // Now check the status
        const status = session.status;

        // 1. state matches actual session state
        expect(status.state).toBe(session.state);

        // 2. adapterAlive matches the mock's alive value
        expect(status.adapterAlive).toBe(adapterAlive);

        // 3. adapterPid matches when alive
        if (adapterPid !== undefined) {
          expect(status.adapterPid).toBe(adapterPid);
        }

        // 4. pendingEventCount is non-negative
        expect(status.pendingEventCount).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 100 },
    );
  });
});
