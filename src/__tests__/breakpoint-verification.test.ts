/**
 * Unit tests for breakpoint verification status derivation.
 *
 * These pin the defect directly: the adapter's raw `verified` boolean inverts
 * meaning across the connect boundary, and is identical for a write that landed
 * and one that was silently staged. Nothing here may depend on it.
 */
import { describe, it, expect } from 'vitest';
import { SessionState } from '../session.js';
import {
  describeVerification,
  describeBreakpoints,
  detectStateMismatch,
  type VerificationRecord,
  type VerificationContext,
} from '../breakpoint-verification.js';

function context(state: SessionState, recorded?: Map<number, VerificationRecord>) {
  const staged: number[] = [];
  const ctx: VerificationContext = {
    state,
    getVerification: (id) => recorded?.get(id),
    markBreakpointsStaged: (ids) => staged.push(...ids),
  };
  return { ctx, staged };
}

describe('describeVerification', () => {
  it('reports pending_connection while listening, where the raw flag says "verified"', () => {
    // breakpoints.ts:82 returns verified:true here — meaning "no connection
    // existed to check it", the opposite of what the word implies.
    const { status } = describeVerification(SessionState.Listening);
    expect(status).toBe('pending_connection');
  });

  it('reports staged_not_applied while connected — the write did not reach Xdebug', () => {
    const { status, detail } = describeVerification(SessionState.Connected);
    expect(status).toBe('staged_not_applied');
    expect(detail).toContain('NOT applied');
  });

  it('reports pending_resolution while paused, where the write is actually sent', () => {
    const { status } = describeVerification(SessionState.Paused);
    expect(status).toBe('pending_resolution');
  });

  it('distinguishes the two states the raw boolean cannot tell apart', () => {
    // The adapter returns verified:false for BOTH of these — a connection
    // exists in each case. Only session state separates the dropped write from
    // the one that landed.
    const running = describeVerification(SessionState.Connected).status;
    const paused = describeVerification(SessionState.Paused).status;
    expect(running).not.toBe(paused);
  });

  it('lets a recorded breakpoint event override state', () => {
    const recorded: VerificationRecord = { verified: true, line: 42, at: Date.now() };
    expect(describeVerification(SessionState.Connected, recorded).status).toBe('verified');
  });

  it('reports rejected and surfaces the adapter message', () => {
    const recorded: VerificationRecord = { verified: false, message: 'no code on line 7', at: 1 };
    const { status, detail } = describeVerification(SessionState.Listening, recorded);
    expect(status).toBe('rejected');
    expect(detail).toContain('no code on line 7');
  });
});

describe('describeVerification — unresolved is not rejected (DBGP section 7.6)', () => {
  it('reports an accepted-but-unresolved breakpoint as unresolved, not rejected', () => {
    // vscode-php-debug sends verified:false with NO message when Xdebug
    // answered resolved="unresolved" — the file is simply not loaded yet.
    const result = describeVerification(SessionState.Paused, { verified: false, at: Date.now() });

    expect(result.status).toBe('unresolved');
    expect(result.detail).toContain('NOT a failure');
    expect(result.detail).not.toContain('could not set');
  });

  it('still reports a genuine failure as rejected (adapter supplied a message)', () => {
    const result = describeVerification(SessionState.Paused, {
      verified: false,
      message: 'no code on line 7',
      at: Date.now(),
    });

    expect(result.status).toBe('rejected');
    expect(result.detail).toContain('no code on line 7');
  });

  it("prefers DAP's Breakpoint.reason over the message heuristic when present", () => {
    // Forward compatibility: if upstream starts populating `reason`, it wins.
    const failedNoMessage = describeVerification(SessionState.Paused, {
      verified: false, reason: 'failed', at: Date.now(),
    });
    expect(failedNoMessage.status).toBe('rejected');

    const pendingWithMessage = describeVerification(SessionState.Paused, {
      verified: false, reason: 'pending', message: 'not loaded yet', at: Date.now(),
    });
    expect(pendingWithMessage.status).toBe('unresolved');
  });

  it('a later resolution flips unresolved to verified', () => {
    const before = describeVerification(SessionState.Paused, { verified: false, at: 1 });
    const after = describeVerification(SessionState.Paused, { verified: true, line: 42, at: 2 });

    expect(before.status).toBe('unresolved');
    expect(after.status).toBe('verified');
  });
});

describe('describeBreakpoints', () => {
  it('never emits the raw verified key, whatever the adapter returned', () => {
    const { ctx } = context(SessionState.Paused);
    const out = describeBreakpoints(
      [{ id: 1, line: 10, verified: true }, { id: 2, line: 20, verified: false }],
      ctx,
    );
    for (const bp of out) expect(bp).not.toHaveProperty('verified');
  });

  it('registers ids as staged only while connected', () => {
    const connected = context(SessionState.Connected);
    describeBreakpoints([{ id: 1 }, { id: 2 }], connected.ctx);
    expect(connected.staged).toEqual([1, 2]);

    const paused = context(SessionState.Paused);
    describeBreakpoints([{ id: 1 }, { id: 2 }], paused.ctx);
    expect(paused.staged).toEqual([]);
  });

  it('prefers the resolved line from a recorded event over the requested one', () => {
    // Xdebug moves a breakpoint to the next executable line; the event carries
    // where it actually landed.
    const recorded = new Map([[1, { verified: true, line: 12, at: 1 }]]);
    const { ctx } = context(SessionState.Paused, recorded);
    const [bp] = describeBreakpoints([{ id: 1, line: 10 }], ctx);
    expect(bp.line).toBe(12);
    expect(bp.verification).toBe('verified');
  });
});

describe('detectStateMismatch', () => {
  // The one bit the raw flag does carry is "a connection exists", which makes
  // it an independent witness against our own state.
  it('flags a connection we never noticed', () => {
    expect(detectStateMismatch([{ verified: false }], SessionState.Listening))
      .toContain('live Xdebug connection');
  });

  it('flags a connection that has gone away', () => {
    expect(detectStateMismatch([{ verified: true }], SessionState.Paused))
      .toContain('no live Xdebug connection');
  });

  it('stays quiet when the adapter and our state agree', () => {
    expect(detectStateMismatch([{ verified: true }], SessionState.Listening)).toBeUndefined();
    expect(detectStateMismatch([{ verified: false }], SessionState.Connected)).toBeUndefined();
    expect(detectStateMismatch([{ verified: false }], SessionState.Paused)).toBeUndefined();
  });

  it('stays quiet when the adapter reported no flag at all', () => {
    expect(detectStateMismatch([{ id: 1 }], SessionState.Listening)).toBeUndefined();
    expect(detectStateMismatch([], SessionState.Listening)).toBeUndefined();
  });
});
