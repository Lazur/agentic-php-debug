/**
 * launch() must never leave a half-started session behind.
 *
 * Before: a throwing handshake step left the state at Initializing (every
 * guarded tool rejected, the spawned adapter kept the port), a throwing `launch`
 * orphaned the `initialized` wait into an unhandled rejection, and a terminate()
 * that landed mid-handshake was overwritten by Listening.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { DebugProtocol } from '@vscode/debugprotocol';
import { SessionManager, SessionState } from '../session.js';
import { handleDebugLaunch } from '../tools/debug-launch.js';
import { handleDebugTerminate } from '../tools/debug-terminate.js';
import {
  createMockBackend,
  stubConfig,
  stubNotifier,
  stubPathMapper,
  type MockBackend,
} from './helpers/mock-backend.js';

const neverBound = { isPortBound: async () => false };

function setup(): { mock: MockBackend; session: SessionManager; notifier: ReturnType<typeof stubNotifier> } {
  const mock = createMockBackend();
  const notifier = stubNotifier();
  const session = new SessionManager(stubConfig(), mock.client, stubPathMapper(), notifier);
  return { mock, session, notifier };
}

/** A promise whose settlement the test controls. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const initializedEvent: DebugProtocol.Event = { seq: 0, type: 'event', event: 'initialized' };

describe('launch() failure rolls back to Terminated', () => {
  const failingSteps = ['initialize', 'launch', 'waitForEvent', 'configurationDone'] as const;

  for (const step of failingSteps) {
    it(`when ${step} rejects`, async () => {
      const { mock, session, notifier } = setup();
      mock.mockClient[step].mockRejectedValue(new Error(`${step} blew up`));

      await expect(session.launch()).rejects.toThrow(`${step} blew up`);

      expect(session.state).toBe(SessionState.Terminated);
      expect(mock.mockClient.disconnect).toHaveBeenCalledTimes(1);
      expect(notifier.sendLog).toHaveBeenCalledWith('error', `Launch failed: ${step} blew up`);
    });
  }

  it('handleDebugLaunch reports DAP_ERROR and a relaunch succeeds', async () => {
    const { mock, session } = setup();
    mock.mockClient.configurationDone.mockRejectedValueOnce(new Error('adapter refused'));

    const failed = await handleDebugLaunch(session, {}, undefined, neverBound);
    expect(failed.success).toBe(false);
    expect(failed.error?.code).toBe('DAP_ERROR');
    expect(session.state).toBe(SessionState.Terminated);

    const retried = await handleDebugLaunch(session, {}, undefined, neverBound);
    expect(retried.success).toBe(true);
    expect(session.state).toBe(SessionState.Listening);
  });

  it('a failed launch does not register a second set of handlers on relaunch', async () => {
    const { mock, session } = setup();
    mock.mockClient.initialize.mockRejectedValueOnce(new Error('spawn failed'));

    await expect(session.launch()).rejects.toThrow('spawn failed');
    const afterFailure = mock.handlerCount('stopped');
    await session.launch();

    expect(mock.handlerCount('stopped')).toBe(afterFailure);
    expect(mock.handlerCount('stopped')).toBe(1);
  });
});

describe('launch() does not orphan the initialized wait', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    unhandled.length = 0;
  });

  it('a launch that throws before step 3 leaves no unhandled rejection', async () => {
    process.on('unhandledRejection', onUnhandled);
    const { mock, session } = setup();
    const initialized = deferred<DebugProtocol.Event>();
    // A plain function, not vi.fn: vitest attaches its own handlers to promises
    // a spy returns (to track settledResults), which would mask the bug.
    mock.mockClient.waitForEvent = () => initialized.promise;
    mock.mockClient.launch.mockRejectedValue(new Error('launch rejected'));

    await expect(session.launch()).rejects.toThrow('launch rejected');

    // What DAPClient.waitForEvent does after its 30s timeout.
    initialized.reject(new Error('Timeout waiting for DAP event "initialized"'));
    await new Promise((r) => setTimeout(r, 10));

    expect(unhandled).toEqual([]);
  });
});

describe('terminate() during launch wins', () => {
  it('terminate during the initialized wait aborts the launch', async () => {
    const { mock, session } = setup();
    const initialized = deferred<DebugProtocol.Event>();
    mock.mockClient.waitForEvent.mockReturnValue(initialized.promise);

    const launching = session.launch();
    await vi.waitFor(() => expect(mock.mockClient.launch).toHaveBeenCalled());

    await handleDebugTerminate(session);
    expect(session.state).toBe(SessionState.Terminated);

    initialized.resolve(initializedEvent);
    await expect(launching).rejects.toThrow('Launch aborted: session terminated');

    expect(session.state).toBe(SessionState.Terminated);
    expect(mock.mockClient.configurationDone).not.toHaveBeenCalled();
  });

  it('terminate during configurationDone is not overwritten by Listening', async () => {
    const { mock, session } = setup();
    // VsCodeDebugBackend.configurationDone() swallows errors, so the request
    // still "succeeds" after the session has been torn down.
    const configured = deferred<DebugProtocol.ConfigurationDoneResponse>();
    mock.mockClient.configurationDone.mockReturnValue(configured.promise);

    const launching = session.launch();
    await vi.waitFor(() => expect(mock.mockClient.configurationDone).toHaveBeenCalled());

    await handleDebugTerminate(session);
    configured.resolve({} as DebugProtocol.ConfigurationDoneResponse);

    await expect(launching).rejects.toThrow('Launch aborted');
    expect(session.state).toBe(SessionState.Terminated);
  });

  it('a terminated event mid-handshake aborts the launch too', async () => {
    const { mock, session } = setup();
    const initialized = deferred<DebugProtocol.Event>();
    mock.mockClient.waitForEvent.mockReturnValue(initialized.promise);

    const launching = session.launch();
    await vi.waitFor(() => expect(mock.mockClient.launch).toHaveBeenCalled());

    mock.fireEvent('terminated', { adapterExited: true, exitCode: 1 });
    initialized.resolve(initializedEvent);

    await expect(launching).rejects.toThrow('Launch aborted');
    expect(session.state).toBe(SessionState.Terminated);
    expect(mock.mockClient.configurationDone).not.toHaveBeenCalled();
  });
});
