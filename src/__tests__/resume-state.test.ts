import { describe, it, expect } from 'vitest';
import { SessionState } from '../session.js';
import { handleDebugContinue } from '../tools/debug-continue.js';
import { handleDebugNext } from '../tools/debug-next.js';
import { handleDebugStepIn } from '../tools/debug-step-in.js';
import { handleDebugStepOut } from '../tools/debug-step-out.js';
import { handleDebugWait } from '../tools/debug-wait.js';
import { handleDebugStatus } from '../tools/debug-status.js';
import { createMockBackend, launchAndConnect, launchAndPause } from './helpers/mock-backend.js';

const COMMANDS = [
  ['debug_continue', handleDebugContinue],
  ['debug_next', handleDebugNext],
  ['debug_step_in', handleDebugStepIn],
  ['debug_step_out', handleDebugStepOut],
] as const;

describe('resume state — DAP makes the CLIENT infer the resume', () => {
  // "a debug adapter is not expected to send this event in response to a
  // request that implies that execution continues, e.g. launch or continue."
  // vscode-php-debug sends no `continued` for any of these four, so without
  // markResumed the session stayed `paused` and debug_wait lied.

  it.each(COMMANDS)('%s moves the session Paused -> Connected', async (_name, handler) => {
    const mock = createMockBackend();
    const session = await launchAndPause(mock);
    expect(session.state).toBe(SessionState.Paused);

    const result = await handler(session, { threadId: 1 });

    expect(result.success).toBe(true);
    expect((result.data as any).resumed).toBe(true);
    expect((result.data as any).state).toBe(SessionState.Connected);
    expect(session.state).toBe(SessionState.Connected);
    expect(session.stopInfo).toBeUndefined();
  });

  it('debug_wait no longer answers already_paused while the target is running', async () => {
    const mock = createMockBackend();
    const session = await launchAndPause(mock);

    await handleDebugContinue(session, { threadId: 1 });
    const wait = await handleDebugWait(session, { timeout: 1 });

    expect((wait.data as any).reason).not.toBe('already_paused');
    expect((wait.data as any).status.state).toBe(SessionState.Connected);
  });
});

describe('resume state — races the epoch guard must survive', () => {
  it('a same-chunk re-stop is NOT clobbered back to Connected', async () => {
    // The adapter answers the continuation BEFORE issuing the DBGp command, and
    // the stream parser dispatches every message in a chunk synchronously — so
    // a fast breakpoint delivers response and `stopped` together, with the
    // `stopped` landing before the awaiting continuation runs.
    const mock = createMockBackend();
    const session = await launchAndPause(mock);
    const firstSuspension = session.suspensionId;

    mock.mockClient.sendRequest.mockImplementationOnce(async () => {
      mock.fireEvent('stopped', { reason: 'breakpoint', threadId: 1, allThreadsStopped: false });
      return { body: {} };
    });

    const result = await handleDebugContinue(session, { threadId: 1 });

    expect(session.state).toBe(SessionState.Paused);
    expect((result.data as any).resumed).toBe(false);
    expect((result.data as any).note).toContain('NEW location');
    expect(session.suspensionId).toBeGreaterThan(firstSuspension);
  });

  it('a target that finishes mid-command is NOT walked back to Connected', async () => {
    // `terminated` does not bump the suspension counter, so the id check alone
    // would let this through — the Terminated precondition is what stops it.
    const mock = createMockBackend();
    const session = await launchAndPause(mock);

    mock.mockClient.sendRequest.mockImplementationOnce(async () => {
      mock.fireEvent('terminated', {});
      return { body: {} };
    });

    const result = await handleDebugContinue(session, { threadId: 1 });

    expect(session.state).toBe(SessionState.Terminated);
    expect((result.data as any).resumed).toBe(false);
    expect((result.data as any).note).toContain('debug_launch');
  });

  it('a failed continuation leaves the session suspended', async () => {
    const mock = createMockBackend();
    const session = await launchAndPause(mock);
    mock.mockClient.sendRequest.mockRejectedValueOnce(new Error('connection closed'));

    const result = await handleDebugContinue(session, { threadId: 1 });

    expect(result.success).toBe(false);
    expect(session.state).toBe(SessionState.Paused);
  });

  it('drops the concluded suspension\'s stopped, but keeps events still true', async () => {
    // Flow with no debug_wait in it: stopped -> stack_trace -> continue. The
    // buffered stop would otherwise be replayed as though it were new. The
    // buffered `thread` event is a different matter — that thread really did
    // start and still exists, so it must survive.
    const mock = createMockBackend();
    const session = await launchAndPause(mock);
    expect(session.status.pendingEventCount).toBe(2); // thread + stopped

    await handleDebugContinue(session, { threadId: 1 });

    expect(session.status.pendingEventCount).toBe(1); // thread survives
    const drained: Array<string | null> = [];
    for (let i = 0; i < 3; i++) {
      const wait = await handleDebugWait(session, { timeout: 1 });
      drained.push((wait.data as any).event);
    }
    expect(drained).toContain('thread');
    expect(drained).not.toContain('stopped');
  });
});

describe('resume state — one Xdebug connection is one thread', () => {
  it('resuming one suspended thread leaves the other suspended', async () => {
    const mock = createMockBackend();
    const session = await launchAndPause(mock, 1);
    mock.fireEvent('stopped', { reason: 'breakpoint', threadId: 2, allThreadsStopped: false });

    expect(session.status.stoppedThreads.map((t) => t.threadId).sort()).toEqual([1, 2]);

    const result = await handleDebugContinue(session, { threadId: 1 });

    expect((result.data as any).resumed).toBe(true);
    expect(session.state).toBe(SessionState.Paused);
    expect(session.status.stoppedThreads.map((t) => t.threadId)).toEqual([2]);
    expect(session.stopInfo?.threadId).toBe(2);
  });

  it('a stop on another thread does not cancel an unrelated resume', async () => {
    // The reason the guard is per-thread rather than a single global counter.
    const mock = createMockBackend();
    const session = await launchAndPause(mock, 1);

    mock.mockClient.sendRequest.mockImplementationOnce(async () => {
      mock.fireEvent('stopped', { reason: 'breakpoint', threadId: 2, allThreadsStopped: false });
      return { body: {} };
    });

    const result = await handleDebugContinue(session, { threadId: 1 });

    expect((result.data as any).resumed).toBe(true);
    expect(session.status.stoppedThreads.map((t) => t.threadId)).toEqual([2]);
  });

  it('a late synthesized continued for an already-resumed thread is a no-op', async () => {
    // The VS Code backend's 500ms poller emits one well after markResumed ran.
    const mock = createMockBackend();
    const session = await launchAndPause(mock, 1);
    await handleDebugContinue(session, { threadId: 1 });

    mock.fireEvent('continued', { threadId: 1, allThreadsContinued: true });

    expect(session.state).toBe(SessionState.Connected);
  });

  it('a thread exiting while suspended does not pin the session at paused', async () => {
    const mock = createMockBackend();
    const session = await launchAndPause(mock, 1);

    mock.fireEvent('thread', { threadId: 1, reason: 'exited' });

    // Not paused — and, with no connection left, not "connected" either.
    expect(session.state).toBe(SessionState.Listening);
    expect(session.stopInfo).toBeUndefined();
    expect(session.status.liveThreadIds).toEqual([]);
  });

  it('the last connection closing returns the session to listening', async () => {
    // Listen mode: the adapter sends `continued` + `thread` exited when PHP
    // closes its connection, and keeps listening — there is no `terminated`.
    const mock = createMockBackend();
    const session = await launchAndConnect(mock);

    mock.fireEvent('continued', { threadId: 1, allThreadsContinued: false });
    mock.fireEvent('thread', { threadId: 1, reason: 'exited' });

    expect(session.state).toBe(SessionState.Listening);
    const guidance = (handleDebugStatus(session).data as { guidance: string }).guidance;
    expect(guidance).not.toContain('connected and running');
    expect(guidance).toContain('listening');

    // The next request dials in through the ordinary Listening -> Connected path.
    mock.fireEvent('thread', { threadId: 2, reason: 'started' });
    expect(session.state).toBe(SessionState.Connected);
  });

  it('stays connected while another connection is still live', async () => {
    const mock = createMockBackend();
    const session = await launchAndConnect(mock);
    mock.fireEvent('thread', { threadId: 2, reason: 'started' });

    mock.fireEvent('thread', { threadId: 1, reason: 'exited' });

    expect(session.state).toBe(SessionState.Connected);
    expect(session.status.liveThreadIds).toEqual([2]);
  });

  it('reports a thread that was never suspended instead of guessing', async () => {
    const mock = createMockBackend();
    const session = await launchAndPause(mock, 1);

    const result = await handleDebugContinue(session, { threadId: 99 });

    expect((result.data as any).resumed).toBe(false);
    expect((result.data as any).note).toContain('Suspended thread ids: 1');
  });
});

describe('resume state — Terminated is sticky', () => {
  it('a stray stopped after termination does not revive the session', async () => {
    const mock = createMockBackend();
    const session = await launchAndPause(mock, 1);
    mock.fireEvent('terminated', {});
    expect(session.state).toBe(SessionState.Terminated);

    mock.fireEvent('stopped', { reason: 'breakpoint', threadId: 1, allThreadsStopped: false });

    expect(session.state).toBe(SessionState.Terminated);
    expect(session.stopInfo).toBeUndefined();
  });

  it('markResumed refuses to leave Terminated', async () => {
    const mock = createMockBackend();
    const session = await launchAndPause(mock, 1);
    const observed = session.suspensionIdFor(1)!;
    mock.fireEvent('terminated', {});

    expect(session.markResumed(1, observed)).toBe(false);
    expect(session.state).toBe(SessionState.Terminated);
  });
});
