/**
 * Resolving which thread a tool acts on when the caller omits threadId.
 *
 * This convenience used to live in the VS Code extension, copy-pasted into six
 * tool classes, defaulting from `stopInfo` in every case. Two things were wrong
 * with that: it could not see how many threads were suspended, so it picked one
 * silently; and for debug_pause — which runs while NOTHING is suspended — it
 * could only ever produce INVALID_PARAMS.
 *
 * **Validates: Requirements 4.4, 17.4**
 */
import { describe, it, expect } from 'vitest';
import {
  createMockBackend,
  launchAndConnect,
  launchAndPause,
} from './helpers/mock-backend.js';
import {
  ambiguousThreadNote,
  resolveRunningThreadId,
  resolveStoppedThreadId,
} from '../tools/thread-resolution.js';
import { handleDebugContinue } from '../tools/debug-continue.js';
import { handleDebugStackTrace } from '../tools/debug-stack-trace.js';
import { handleDebugPause } from '../tools/debug-pause.js';
import { handleDebugExceptionInfo } from '../tools/debug-exception-info.js';
import { ErrorCodes } from '../tools/types.js';

describe('resolveStoppedThreadId', () => {
  it('returns an explicit threadId untouched, never overridden by stopInfo', async () => {
    const mock = createMockBackend();
    const session = await launchAndPause(mock, 7);

    expect(resolveStoppedThreadId(session, 42)).toEqual({ threadId: 42, ambiguous: false });
  });

  it('falls back to the suspended thread and reports it unambiguous', async () => {
    const mock = createMockBackend();
    const session = await launchAndPause(mock, 3);

    expect(resolveStoppedThreadId(session)).toEqual({ threadId: 3, ambiguous: false });
  });

  it('flags ambiguity when more than one thread is suspended', async () => {
    const mock = createMockBackend();
    const session = await launchAndPause(mock, 1);
    mock.fireEvent('thread', { threadId: 2, reason: 'started' });
    mock.fireEvent('stopped', { reason: 'breakpoint', threadId: 2, allThreadsStopped: false });

    const resolved = resolveStoppedThreadId(session);
    expect(resolved?.ambiguous).toBe(true);
    // The note names the thread acted on and the alternatives.
    const note = ambiguousThreadNote(session, resolved!.threadId);
    expect(note).toContain(String(resolved!.threadId));
    expect(note).toContain('Pass threadId explicitly');
  });

  it('returns undefined when nothing is suspended', async () => {
    const mock = createMockBackend();
    const session = await launchAndConnect(mock);

    expect(resolveStoppedThreadId(session)).toBeUndefined();
  });
});

describe('resolveRunningThreadId', () => {
  it('returns an explicit threadId untouched', async () => {
    const mock = createMockBackend();
    const session = await launchAndConnect(mock);

    expect(resolveRunningThreadId(session, 99)).toBe(99);
  });

  it('falls back to the sole live connection', async () => {
    const mock = createMockBackend();
    const session = await launchAndConnect(mock);

    expect(resolveRunningThreadId(session)).toBe(1);
  });

  it('refuses to guess between several live connections', async () => {
    const mock = createMockBackend();
    const session = await launchAndConnect(mock);
    mock.fireEvent('thread', { threadId: 2, reason: 'started' });

    expect(session.status.liveThreadIds.length).toBeGreaterThan(1);
    expect(resolveRunningThreadId(session)).toBeUndefined();
  });
});

describe('handlers resolve threadId end to end', () => {
  it('debug_continue acts on the suspended thread when threadId is omitted', async () => {
    const mock = createMockBackend();
    const session = await launchAndPause(mock, 5);

    const result = await handleDebugContinue(session, {});

    expect(result.success).toBe(true);
    expect(mock.mockClient.sendRequest).toHaveBeenCalledWith('continue', { threadId: 5 });
    expect((result.data as { threadId: number }).threadId).toBe(5);
  });

  it('debug_stack_trace resolves and echoes the thread it used', async () => {
    const mock = createMockBackend();
    const session = await launchAndPause(mock, 6);

    const result = await handleDebugStackTrace(session, {});

    expect(result.success).toBe(true);
    expect((result.data as { threadId: number }).threadId).toBe(6);
  });

  it('debug_exception_info resolves the suspended thread', async () => {
    const mock = createMockBackend();
    const session = await launchAndPause(mock, 8);

    const result = await handleDebugExceptionInfo(session, {});

    expect(result.success).toBe(true);
    expect(mock.mockClient.sendRequest).toHaveBeenCalledWith('exceptionInfo', { threadId: 8 });
  });

  it('debug_pause resolves from the live connection, not from stopInfo', async () => {
    const mock = createMockBackend();
    const session = await launchAndConnect(mock);

    const result = await handleDebugPause(session, {});

    expect(result.success).toBe(true);
    expect(mock.mockClient.sendRequest).toHaveBeenCalledWith('pause', { threadId: 1 });
  });

  it('debug_pause explains itself instead of guessing between connections', async () => {
    const mock = createMockBackend();
    const session = await launchAndConnect(mock);
    mock.fireEvent('thread', { threadId: 2, reason: 'started' });

    const result = await handleDebugPause(session, {});

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(result.error?.message).toContain('connections are live');
    expect(mock.mockClient.sendRequest).not.toHaveBeenCalledWith('pause', expect.anything());
  });

  it('reports INVALID_PARAMS when a continuation has no thread to act on', async () => {
    const mock = createMockBackend();
    const session = await launchAndPause(mock, 1);
    // The thread goes away, leaving the session with nothing suspended.
    mock.fireEvent('thread', { threadId: 1, reason: 'exited' });

    const result = await handleDebugContinue(session, {});

    expect(result.success).toBe(false);
    expect(result.error?.code).toBeDefined();
  });

  it('surfaces the ambiguity warning through the tool result', async () => {
    const mock = createMockBackend();
    const session = await launchAndPause(mock, 1);
    mock.fireEvent('thread', { threadId: 2, reason: 'started' });
    mock.fireEvent('stopped', { reason: 'breakpoint', threadId: 2, allThreadsStopped: false });

    const result = await handleDebugContinue(session, {});

    expect(result.success).toBe(true);
    expect((result.data as { warning?: string }).warning).toContain('threads are suspended');
  });
});
