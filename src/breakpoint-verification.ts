import { SessionState } from './session.js';

/**
 * Honest breakpoint verification status for the MCP boundary.
 *
 * The adapter's raw `verified` boolean cannot be passed through: it is
 * `BreakpointManager.listeners('add').length === 0` (vscode-php-debug
 * breakpoints.ts:82), and the only registrant is a per-connection
 * BreakpointAdapter. So it encodes exactly one bit — "a live Xdebug connection
 * exists" — inverted relative to how a reader interprets the word "verified":
 *
 *   - no connection  → `true`,  meaning "nobody could check this"
 *   - a connection   → `false`, meaning "not resolved yet"
 *
 * And it is `false` both for a write that landed (issued while paused) and for
 * one that was silently staged and dropped (issued while running), so it cannot
 * discriminate those either. `SessionState` carries both bits — connection
 * existence and running-vs-paused — so the derivation below keys on state alone.
 */
export type VerificationStatus =
  /** The adapter confirmed resolution against a live connection. */
  | 'verified'
  /** The adapter reported failure; `detail` carries its message. */
  | 'rejected'
  /**
   * Registered while listening, before any Xdebug connection existed. Nothing
   * could check it yet, but BreakpointManager replays all breakpoints onto each
   * new connection, so it *will* be applied before PHP executes a line.
   */
  | 'pending_connection'
  /**
   * Registered while PHP was running. The adapter stages such writes in its map
   * and skips the network send while a run/step command is outstanding, so this
   * write has NOT reached Xdebug. Any previous breakpoints in the file are still
   * live and will keep firing until the session next pauses.
   */
  | 'staged_not_applied'
  /** Sent to Xdebug; the adapter has not reported resolution yet. */
  | 'pending_resolution'
  /**
   * Xdebug ACCEPTED the breakpoint but reports it as `resolved="unresolved"`
   * (DBGP section 7.6) — it cannot yet confirm the file/line exists, almost
   * always because the file has not been compiled yet (lazy autoload).
   *
   * This is NOT a failure. DBGP section 8.5.1 has the engine send a
   * `breakpoint_resolved` notification once it can resolve it, which the
   * adapter relays as another DAP `breakpoint` event. Reporting this as
   * "rejected" made agents relocate perfectly good breakpoints.
   */
  | 'unresolved';

/** A resolution result recorded from a DAP `breakpoint` event. */
export interface VerificationRecord {
  verified: boolean;
  line?: number;
  message?: string;
  /**
   * DAP `Breakpoint.reason` — 'pending' (may verify later) or 'failed'
   * (will not verify without intervention).
   *
   * vscode-php-debug does not populate it: BreakpointAdapter.__process
   * (breakpoints.ts:359) emits `{id, verified, line}` on a successful
   * breakpoint_set and `{id, verified:false, message}` only from its catch.
   * Read it when present so this works automatically if upstream starts
   * sending it; otherwise fall back to message-presence.
   */
  reason?: 'pending' | 'failed';
  /** Epoch ms when the event was received. */
  at: number;
}

export interface VerificationDescription {
  status: VerificationStatus;
  detail: string;
}

const DETAIL: Record<VerificationStatus, string> = {
  verified:
    'The debug adapter confirmed this breakpoint is resolved on the live Xdebug connection.',
  rejected:
    'The debug adapter reported that it could not set this breakpoint.',
  unresolved:
    'Xdebug accepted this breakpoint but reports it as UNRESOLVED — normally because the file is not loaded yet (lazy autoload). This is NOT a failure: Xdebug resolves it and notifies the adapter once the file is compiled, and debug_status will show it verified from then on. If it never resolves, the path mapping or the line number is wrong.',
  pending_connection:
    'Registered before Xdebug connected, so nothing could verify it yet. It is replayed onto the connection when one arrives, before PHP executes a line.',
  staged_not_applied:
    'NOT applied — the adapter stages breakpoint writes while PHP is running and does not send them until execution next pauses. Previous breakpoints in this file are still live and will keep firing. Call debug_wait to reach a pause, then re-check debug_status.',
  pending_resolution:
    'Sent to Xdebug; resolution has not been reported yet. Re-check debug_status after the next debug_wait.',
};

/**
 * Derive an unambiguous verification status.
 *
 * A recorded `breakpoint` event wins — it is the adapter's own resolution
 * result. Otherwise session state alone decides. The adapter's raw boolean is
 * deliberately never consulted; see the VerificationStatus docs for why.
 */
export function describeVerification(
  state: SessionState,
  recorded?: VerificationRecord,
): VerificationDescription {
  if (recorded) {
    // `verified: false` does NOT mean rejected. The adapter derives it from
    // `ret.resolved !== 'unresolved'` (breakpoints.ts:359), so an accepted but
    // not-yet-resolvable breakpoint lands here too — the common case when
    // breakpoints are set before the request is triggered. DAP names the same
    // split `reason: 'pending' | 'failed'`; prefer it when the adapter supplies
    // it, and otherwise use the one signal that does separate the two: the
    // adapter's error path sets `message`, its unresolved path does not.
    let status: VerificationStatus;
    if (recorded.verified) {
      status = 'verified';
    } else if (recorded.reason === 'failed') {
      status = 'rejected';
    } else if (recorded.reason === 'pending') {
      status = 'unresolved';
    } else {
      status = recorded.message !== undefined ? 'rejected' : 'unresolved';
    }
    return {
      status,
      detail: recorded.message ? `${DETAIL[status]} ${recorded.message}` : DETAIL[status],
    };
  }

  switch (state) {
    case SessionState.Listening:
      return { status: 'pending_connection', detail: DETAIL.pending_connection };
    case SessionState.Connected:
      return { status: 'staged_not_applied', detail: DETAIL.staged_not_applied };
    default:
      // Paused — and the states the breakpoint tools reject before reaching here.
      return { status: 'pending_resolution', detail: DETAIL.pending_resolution };
  }
}

/** A breakpoint as the DAP adapter reports it in a setBreakpoints response. */
export interface DapBreakpoint {
  id?: number;
  line?: number;
  verified?: boolean;
  message?: string;
}

/** A breakpoint as we report it to the model. */
export interface ReportedBreakpoint {
  id?: number;
  line?: number;
  verification: VerificationStatus;
  verificationDetail: string;
  /** The adapter's own message, when it supplied one. */
  message?: string;
}

/** The slice of SessionManager these helpers need, kept narrow so they stay testable. */
export interface VerificationContext {
  readonly state: SessionState;
  getVerification(id: number): VerificationRecord | undefined;
  markBreakpointsStaged(ids: number[]): void;
}

/**
 * Map a DAP setBreakpoints response onto honest statuses, and register any
 * write the adapter has staged rather than sent.
 */
export function describeBreakpoints(
  breakpoints: DapBreakpoint[],
  session: VerificationContext,
): ReportedBreakpoint[] {
  if (session.state === SessionState.Connected) {
    const ids = breakpoints.map((bp) => bp.id).filter((id): id is number => id !== undefined);
    if (ids.length > 0) session.markBreakpointsStaged(ids);
  }

  return breakpoints.map((bp) => {
    const recorded = bp.id !== undefined ? session.getVerification(bp.id) : undefined;
    const { status, detail } = describeVerification(session.state, recorded);
    return {
      id: bp.id,
      line: recorded?.line ?? bp.line,
      verification: status,
      verificationDetail: detail,
      ...(bp.message !== undefined ? { message: bp.message } : {}),
    };
  });
}

/**
 * Cross-check our session state against the one bit the adapter's raw `verified`
 * does carry: whether a live Xdebug connection exists. A disagreement means our
 * state is stale — a connection arrived or died without us noticing.
 */
export function detectStateMismatch(
  breakpoints: DapBreakpoint[],
  state: SessionState,
): string | undefined {
  const raw = breakpoints.find((bp) => bp.verified !== undefined)?.verified;
  if (raw === undefined) return undefined;

  const adapterHasConnection = raw === false;

  if (adapterHasConnection && state === SessionState.Listening) {
    return 'Session state says "listening" but the adapter reports a live Xdebug connection. State may be stale — call debug_status.';
  }
  if (!adapterHasConnection && (state === SessionState.Connected || state === SessionState.Paused)) {
    return `Session state says "${state}" but the adapter reports no live Xdebug connection. The connection may have dropped — call debug_status.`;
  }
  return undefined;
}
