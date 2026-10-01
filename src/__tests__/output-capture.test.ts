import { describe, it, expect, vi } from 'vitest';
import { handleDebugStatus } from '../tools/debug-status.js';
import { handleDebugWait } from '../tools/debug-wait.js';
import { createMockBackend, launchAndConnect } from './helpers/mock-backend.js';

describe('output capture', () => {
  it('records category and text', async () => {
    const mock = createMockBackend();
    const session = await launchAndConnect(mock);

    mock.fireEvent('output', { category: 'stdout', output: 'hello from php\n' });
    mock.fireEvent('output', { category: 'stderr', output: 'a warning\n' });

    expect(session.status.recentOutput).toHaveLength(2);
    expect(session.status.recentOutput[0]).toMatchObject({ category: 'stdout', output: 'hello from php\n' });
    expect(session.status.recentOutput[1]).toMatchObject({ category: 'stderr' });
  });

  it("defaults a missing category to DAP's 'console'", async () => {
    const mock = createMockBackend();
    const session = await launchAndConnect(mock);

    mock.fireEvent('output', { output: 'no category' });

    expect(session.status.recentOutput[0].category).toBe('console');
  });

  it('filters the adapter protocol echo emitted under log:true', async () => {
    // Otherwise every request/response/event lands here and drowns the ring.
    const mock = createMockBackend();
    const session = await launchAndConnect(mock);

    mock.fireEvent('output', { output: '-> evaluateRequest\n{ seq: 1 }\n\n' });
    mock.fireEvent('output', { output: '<- evaluateResponse\n{ seq: 2 }\n\n' });
    mock.fireEvent('output', { output: '<- stoppedEvent\n{ }\n\n' });
    mock.fireEvent('output', { category: 'stdout', output: 'real program output' });

    expect(session.status.recentOutput).toHaveLength(1);
    expect(session.status.recentOutput[0].output).toBe('real program output');
  });

  it('bounds the ring and counts what it dropped', async () => {
    const mock = createMockBackend();
    const session = await launchAndConnect(mock);

    for (let i = 0; i < 260; i++) mock.fireEvent('output', { output: `line ${i}` });

    // status surfaces only a tail, but the drop counter reflects the whole ring
    expect(session.status.recentOutput.length).toBeLessThanOrEqual(30);
    expect(session.status.droppedOutputCount).toBe(60);
    expect(session.status.recentOutput.at(-1)?.output).toBe('line 259');
  });

  it('truncates an enormous single line', async () => {
    const mock = createMockBackend();
    const session = await launchAndConnect(mock);

    mock.fireEvent('output', { output: 'x'.repeat(5000) });

    const recorded = session.status.recentOutput[0].output;
    expect(recorded.length).toBeLessThan(5000);
    expect(recorded).toContain('[truncated]');
  });

  it('never resolves a debug_wait', async () => {
    // A wait must not return because the target printed something.
    vi.useFakeTimers();
    try {
      const mock = createMockBackend();
      const session = await launchAndConnect(mock);
      // Drop the `thread` event buffered by setup, or the wait resolves on that
      // replay instead of testing anything about output.
      session.clearPendingEvents();

      let settled = false;
      const waiting = handleDebugWait(session, { timeout: 5000 }).then((r) => {
        settled = true;
        return r;
      });

      mock.fireEvent('output', { category: 'stdout', output: 'chatter' });
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(session.status.pendingEventCount).toBe(0); // output is never buffered

      await vi.advanceTimersByTimeAsync(5000);
      const result = await waiting;
      expect((result.data as any).reason).toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('debug_status explains a continuation that failed after a success response', async () => {
    const mock = createMockBackend();
    const session = await launchAndConnect(mock);

    mock.fireEvent('output', {
      output: 'continueRequest thread ID 1 error: connection closed (on close)\n',
    });

    const guidance = (handleDebugStatus(session).data as any).guidance;
    expect(guidance).toContain('FAILED continuation command');
    expect(guidance).toContain('did not mean the target resumed');
  });

  it('stays silent when the output holds no continuation failure', async () => {
    const mock = createMockBackend();
    const session = await launchAndConnect(mock);

    mock.fireEvent('output', { category: 'stdout', output: 'ordinary program output' });

    expect((handleDebugStatus(session).data as any).guidance).not.toContain('FAILED continuation');
  });
});
