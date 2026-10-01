import type { DebugProtocol } from '@vscode/debugprotocol';
import type { Config } from './config.js';
import type { DebugBackend, EventHandler } from './debug-backend.js';
import type { PathMapper } from './path-mapper.js';
import type { VerificationRecord } from './breakpoint-verification.js';

export enum SessionState {
  NotStarted = 'not_started',
  Initializing = 'initializing',
  Listening = 'listening',
  Connected = 'connected',
  Paused = 'paused',
  Terminated = 'terminated',
}

export interface StopInfo {
  reason: string;
  threadId: number;
  description?: string;
  allThreadsStopped?: boolean;
}

export interface SessionStatus {
  state: SessionState;
  stopInfo?: StopInfo;
  adapterAlive: boolean;
  adapterPid?: number;
  pendingEventCount: number;
  queuedBreakpointCount: number;
  /**
   * Breakpoint ids written while PHP was running. The adapter stages these and
   * does not send them until execution next pauses — until then the file's
   * previous breakpoints are still the live ones.
   */
  stagedBreakpointIds: number[];
  /** Resolution results reported by the adapter, keyed by breakpoint id. */
  breakpointVerifications: Array<{ id: number } & VerificationRecord>;
  /** Set when a DAP request timed out; the target may still be executing it. */
  lastRequestTimeout?: { command: string; timeoutMs: number; at: number };
  /**
   * Every thread currently suspended, not just the one `stopInfo` names.
   *
   * vscode-php-debug maps one Xdebug connection to one DAP "thread", and every
   * stop carries `allThreadsStopped: false` — so resuming one does NOT resume
   * the others. `state` stays a single value ("paused" means at least one
   * thread is suspended); this is what makes that honest.
   */
  stoppedThreads: Array<{ threadId: number } & StopInfo>;
  /** Thread ids the adapter has announced and not yet reported as exited. */
  liveThreadIds: number[];
  /** Monotonic id of the current suspension; bumped by every stop. */
  suspensionId: number;
  /**
   * Tail of the adapter's output channel.
   *
   * Populated under both backends: headless parses `output` events off the
   * adapter's stdout, and the VS Code backends tap them from a debug adapter
   * tracker. (Before that tracker existed this was always empty in UI mode,
   * because onDidReceiveDebugSessionCustomEvent carries no standard events.)
   */
  recentOutput: OutputRecord[];
  /** Output lines dropped from the ring since the session started. */
  droppedOutputCount: number;
}

/** One captured `output` event. */
export interface OutputRecord {
  /** DAP output category: 'stdout' | 'stderr' | 'console' | 'important' | ... */
  category: string;
  output: string;
  at: number;
}

/** A stop record, tagged with the suspension it belongs to. */
interface ThreadStop extends StopInfo {
  suspensionId: number;
}

/**
 * Thrown by `assertState` when the session is in the wrong state.
 *
 * The message text is deliberately byte-identical to the plain `Error` it
 * replaced — several handlers and tests still match on it. New code should
 * branch on the class instead (see `tools/errors.ts`).
 */
export class SessionStateError extends Error {
  readonly name = 'SessionStateError';
  readonly allowed: SessionState[];
  readonly actual: SessionState;

  constructor(allowed: SessionState[], actual: SessionState) {
    super(`Invalid session state: expected one of [${allowed.join(', ')}], but current state is "${actual}"`);
    this.allowed = allowed;
    this.actual = actual;
  }
}

/** Injectable notification sender (Requirement 14.6). */
export interface NotificationSender {
  sendProgress(token: string | number, progress: number, total?: number, message?: string): Promise<void>;
  sendLog(level: string, message: string, data?: unknown): Promise<void>;
  /** Notify the client that a debug event occurred (e.g. breakpoint hit, thread started). */
  sendDebugEvent(event: string, details: Record<string, unknown>): Promise<void>;
}

/** Queued breakpoint request to be sent after configurationDone. */
interface QueuedBreakpoint {
  command: string;
  args: object;
}

/**
 * Upper bound on buffered events. debug_wait drains one per call; the cap only
 * matters for an agent that never waits, so it must not grow without limit.
 */
const MAX_PENDING_EVENTS = 100;

/**
 * How many suspensions of reference history to keep. Current + previous is
 * enough to catch the realistic mistake (an agent reusing an id from the stop
 * it just left); older ids fall back to pass-through.
 */
const RETAINED_SUSPENSIONS = 2;

/**
 * Hard cap on tracked references. Load-bearing, not defensive padding:
 * stackTraceRequest allocates FRESH ids on every call, so ten stack traces of a
 * 50-frame stack is 500 entries inside a single suspension.
 */
const MAX_TRACKED_REFERENCES = 2000;

/** Ring size for captured adapter/debuggee output. */
const MAX_OUTPUT_RECORDS = 200;
/** Per-record truncation; debug_status serialises these into every response. */
const MAX_OUTPUT_CHARS = 1000;
/** How much of the ring debug_status surfaces. */
export const STATUS_OUTPUT_TAIL = 30;

/**
 * With launch arg `log: true`, vscode-php-debug overrides dispatchRequest,
 * sendEvent and sendResponse to echo EVERY protocol message as an OutputEvent.
 * That is duplicate of what onTrace already provides, and it would swamp the
 * ring — drowning the one thing this channel exists to carry.
 */
const ADAPTER_PROTOCOL_LOG_RE = /^(-> \w+Request|<- \w+(Response|Event))\n/;

export class SessionManager {
  private _state: SessionState = SessionState.NotStarted;
  private _stopInfo: StopInfo | undefined;
  /**
   * Monotonic suspension counter. Bumped by every `stopped`, never reset — so
   * an id minted before a relaunch can never be mistaken for a current one.
   */
  private _suspensionId = 0;
  /**
   * Bumped by every launch() and syncFromExternalSession(). Lets per-session
   * caches (debug_snapshot's previous frame per thread) notice a relaunch:
   * thread ids restart at 1 in a new adapter, so they alone cannot.
   */
  private _launchCount = 0;
  /** Threads currently suspended, keyed by thread id. */
  private stoppedThreads = new Map<number, ThreadStop>();
  /** Threads the adapter has announced as started and not yet as exited. */
  private liveThreads = new Set<number>();
  /**
   * Frame ids and variablesReferences we handed to the caller, each tagged with
   * the suspension it was issued in.
   *
   * Two maps rather than one: vscode-php-debug draws frame ids from
   * `_stackFrameIdCounter` and variable refs from `_variableIdCounter`, so the
   * two spaces overlap numerically and a shared map would raise false positives.
   */
  private issuedFrameIds = new Map<number, number>();
  private issuedVarRefs = new Map<number, number>();
  private outputRing: OutputRecord[] = [];
  private droppedOutputCount = 0;
  /** Buffered events, each tagged with the suspension it was observed in. */
  private pendingEvents: Array<{ event: DebugProtocol.Event; suspensionId: number }> = [];
  private queuedBreakpoints: QueuedBreakpoint[] = [];
  private handlersRegistered = false;
  /**
   * Every handler this session put on the backend. The backend outlives a
   * terminate() — DAPClient keeps its handler map across disconnect and a
   * relaunch respawns into the same client — so terminate() must take them
   * off again, or the next launch stacks a second copy of each.
   */
  private registeredHandlers: Array<[string, EventHandler]> = [];
  /** Config merged with this launch's overrides. The injected one is never mutated. */
  private _effectiveConfig: Config | undefined;
  private verifications = new Map<number, VerificationRecord>();
  private stagedBreakpoints = new Set<number>();
  private _lastRequestTimeout: SessionStatus['lastRequestTimeout'];

  constructor(
    private readonly config: Config,
    private readonly _dapClient: DebugBackend,
    private readonly _pathMapper: PathMapper,
    private readonly notifier: NotificationSender,
  ) {}

  /** Expose DAP client for tool handlers that need to send requests. */
  get dapClient(): DebugBackend {
    return this._dapClient;
  }

  /** Expose path mapper for tool handlers that need path translation. */
  get pathMapper(): PathMapper {
    return this._pathMapper;
  }

  get state(): SessionState {
    return this._state;
  }
  /**
   * The config this session is actually running with — the injected config
   * merged with the overrides passed to the most recent launch(). The injected
   * object itself is never mutated (Req 17.1, 17.2).
   */
  get sessionConfig(): Config {
    return this._effectiveConfig ?? this.config;
  }

  /**
   * The thread a caller should act on: the still-suspended thread that stopped
   * most recently, or undefined when nothing is suspended.
   *
   * Derived rather than stored, which also fixes a latent bug — the old field
   * outlived the death of its own connection, so `debug_evaluate` could aim at
   * a thread that no longer existed.
   */
  get stopInfo(): StopInfo | undefined {
    return this._stopInfo;
  }

  /** Monotonic id of the current suspension. */
  get suspensionId(): number {
    return this._suspensionId;
  }

  /** How many times this manager has started (or adopted) a session. */
  get launchCount(): number {
    return this._launchCount;
  }

  /**
   * The suspension id under which `threadId` is currently suspended, or
   * undefined when that thread is not suspended at all.
   */
  suspensionIdFor(threadId: number): number | undefined {
    return this.stoppedThreads.get(threadId)?.suspensionId;
  }

  /**
   * Record that a continuation request succeeded and a thread is running again.
   *
   * DAP puts this transition on the client: "a debug adapter is not expected to
   * send [a continued] event in response to a request that implies that
   * execution continues, e.g. launch or continue." vscode-php-debug only ever
   * emits `continued` from disposeConnection, so nothing else would move us off
   * Paused, and `debug_wait` would keep answering `already_paused` with a stale
   * stop while PHP ran.
   *
   * `observedSuspensionId` MUST be read before the request is sent. The adapter
   * sends the continuation response BEFORE issuing the DBGp command, and
   * DAPStreamParser.parse() dispatches every complete message in a chunk
   * synchronously — before an awaiting promise continuation (a microtask) runs.
   * So a target that re-stops immediately delivers response and `stopped` in one
   * chunk, and this call must not clobber the fresh stop.
   *
   * @returns true when the resume was actually applied.
   */
  markResumed(threadId: number, observedSuspensionId: number): boolean {
    // `terminated`/`exited` do not bump the counter, so the id check alone
    // would happily walk a finished session back to Connected.
    if (this._state === SessionState.Terminated) return false;

    const current = this.stoppedThreads.get(threadId);
    if (!current || current.suspensionId !== observedSuspensionId) return false;

    this.stoppedThreads.delete(threadId);
    // A `stopped` buffered from the suspension we just ended would otherwise be
    // replayed by the next debug_wait as though it were new. Events of every
    // other kind are still true and must survive.
    this.pendingEvents = this.pendingEvents.filter(
      (e) => !(e.event.event === 'stopped' && e.suspensionId <= observedSuspensionId),
    );
    this.recomputeSuspension();
    return true;
  }

  /**
   * Single writer for `_state` and `_stopInfo`, derived from the suspended-thread
   * set. Keeping one derivation point is what lets the per-thread `stopped`,
   * `continued`, `thread` and `markResumed` paths stay idempotent.
   */
  private recomputeSuspension(): void {
    if (this._state === SessionState.Terminated) return;

    if (this.stoppedThreads.size > 0) {
      let latest: ThreadStop | undefined;
      for (const stop of this.stoppedThreads.values()) {
        if (!latest || stop.suspensionId > latest.suspensionId) latest = stop;
      }
      const { suspensionId: _ignored, ...info } = latest!;
      this._stopInfo = info;
      if (this._state !== SessionState.Paused) this.setState(SessionState.Paused);
    } else {
      this._stopInfo = undefined;
      if (this._state === SessionState.Paused) this.setState(SessionState.Connected);
    }
  }

  get status(): SessionStatus {
    const adapterStatus = this.dapClient.getStatus();
    return {
      state: this._state,
      stopInfo: this._stopInfo,
      adapterAlive: adapterStatus.alive,
      adapterPid: adapterStatus.pid,
      pendingEventCount: this.pendingEvents.length,
      queuedBreakpointCount: this.queuedBreakpoints.length,
      stagedBreakpointIds: [...this.stagedBreakpoints],
      breakpointVerifications: [...this.verifications].map(([id, record]) => ({ id, ...record })),
      // StopInfo already carries threadId; strip only the internal suspension tag.
      stoppedThreads: [...this.stoppedThreads.values()].map(({ suspensionId: _s, ...info }) => info),
      liveThreadIds: [...this.liveThreads],
      suspensionId: this._suspensionId,
      recentOutput: this.outputRing.slice(-STATUS_OUTPUT_TAIL),
      droppedOutputCount: this.droppedOutputCount,
      ...(this._lastRequestTimeout ? { lastRequestTimeout: this._lastRequestTimeout } : {}),
    };
  }

  /**
   * Take the oldest buffered event, or undefined when none are pending.
   *
   * Events that fire between two tool calls have no listener to catch them —
   * debug_wait registers its listeners at call time. Buffering plus this drain
   * is what stops such an event from being lost and the next wait from blocking
   * to its full timeout.
   */
  takePendingEvent(): DebugProtocol.Event | undefined {
    return this.pendingEvents.shift()?.event;
  }

  /**
   * Drop the buffered copy of an event a live debug_wait listener just caught,
   * so the next debug_wait does not replay it as though it were new.
   *
   * Matched by identity. That works because this manager's handlers are
   * registered at launch, before any wait's listener, and the backend hands the
   * same event object to every handler in registration order — so by the time
   * the wait's listener runs, bufferEvent() has already stored this object.
   */
  consumePendingEvent(event: DebugProtocol.Event): void {
    const i = this.pendingEvents.findIndex((e) => e.event === event);
    if (i !== -1) this.pendingEvents.splice(i, 1);
  }

  /** Discard buffered events — used when a caller has already been told the current state. */
  clearPendingEvents(): void {
    this.pendingEvents = [];
  }

  /** Record breakpoint ids written while running, which the adapter has staged but not sent. */
  markBreakpointsStaged(ids: number[]): void {
    for (const id of ids) this.stagedBreakpoints.add(id);
  }

  /** Resolution reported by the adapter for a breakpoint id, if any has arrived. */
  getVerification(id: number): VerificationRecord | undefined {
    return this.verifications.get(id);
  }

  /** Note that a DAP request timed out, so status can stop asserting a state it no longer knows. */
  noteRequestTimeout(command: string, timeoutMs: number): void {
    this._lastRequestTimeout = { command, timeoutMs, at: Date.now() };
  }

  /** Record frame ids handed to the caller during the current suspension. */
  noteIssuedFrameIds(ids: Array<number | undefined>): void {
    this.noteIssued(this.issuedFrameIds, ids);
  }

  /**
   * Record variablesReferences handed to the caller. `0` is skipped — DAP uses
   * it to mean "not expandable", so it is not a reference at all.
   */
  noteIssuedVariablesReferences(refs: Array<number | undefined>): void {
    this.noteIssued(this.issuedVarRefs, refs, (r) => r !== 0);
  }

  private noteIssued(
    map: Map<number, number>,
    values: Array<number | undefined>,
    accept: (v: number) => boolean = () => true,
  ): void {
    for (const v of values) {
      if (v === undefined || !accept(v)) continue;
      map.set(v, this._suspensionId);
    }
    this.enforceReferenceCap(map);
  }

  /**
   * The suspension a frame id was issued in, when that is NOT the current one.
   *
   * Returns undefined both for a reference that is still valid AND for one we
   * never issued — the check is deliberately fail-open, so it can never produce
   * a false STALE_REFERENCE.
   */
  staleFrameSuspension(frameId: number): number | undefined {
    return this.staleSuspension(this.issuedFrameIds, frameId);
  }

  /** As {@link staleFrameSuspension}, for a variablesReference. */
  staleVariablesReferenceSuspension(ref: number): number | undefined {
    return this.staleSuspension(this.issuedVarRefs, ref);
  }

  private staleSuspension(map: Map<number, number>, value: number): number | undefined {
    const issued = map.get(value);
    if (issued === undefined || issued === this._suspensionId) return undefined;
    return issued;
  }

  /**
   * Drop history older than RETAINED_SUSPENSIONS. Called on every stop, never
   * on resume: the previous suspension's entries are exactly what lets us
   * reject a stale id rather than silently forwarding it.
   */
  private pruneIssuedReferences(): void {
    const cutoff = this._suspensionId - RETAINED_SUSPENSIONS;
    for (const map of [this.issuedFrameIds, this.issuedVarRefs]) {
      for (const [value, issued] of map) {
        if (issued < cutoff) map.delete(value);
      }
    }
  }

  /** Oldest-first eviction; Map preserves insertion order. */
  private enforceReferenceCap(map: Map<number, number>): void {
    while (map.size > MAX_TRACKED_REFERENCES) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
    }
  }

  /** Validate that the session is in an allowed state. */
  assertState(...allowed: SessionState[]): void {
    if (!allowed.includes(this._state)) {
      throw new SessionStateError(allowed, this._state);
    }
  }
  /**
   * Send all queued breakpoint requests to the DAP adapter and clear the queue.
   * Errors on individual requests are logged but do not halt the flush.
   */
  private async flushQueuedBreakpoints(): Promise<void> {
    const pending = this.queuedBreakpoints;
    this.queuedBreakpoints = [];
    for (const bp of pending) {
      try {
        await this.dapClient.sendRequest(bp.command, bp.args);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.notifier.sendLog('error', `Failed to flush queued breakpoint: ${message}`).catch(() => {});
      }
    }
  }

  /** Queue a breakpoint request to be sent after configurationDone. */
  queueBreakpoint(command: string, args: object): void {
    this.queuedBreakpoints.push({ command, args });
  }

  /**
   * Launch debug session: initialize → launch → wait for initialized → send queued
   * breakpoints → configurationDone.
   *
   * `overrides` are merged over the injected config for this launch and used to
   * build the actual launch arguments — the injected object is left untouched, and
   * `sessionConfig` reports the merged result so callers echo what is really running.
   */
  async launch(progressToken?: string | number, overrides?: Partial<Config>): Promise<SessionStatus> {
    // Strip undefined here rather than at the call site: a bare spread would
    // overwrite a real value with undefined for any key the caller left unset.
    const applied = Object.fromEntries(
      Object.entries(overrides ?? {}).filter(([, value]) => value !== undefined),
    ) as Partial<Config>;
    this._effectiveConfig = { ...this.config, ...applied };
    this._launchCount++;

    this.setState(SessionState.Initializing);
    this._stopInfo = undefined;
    this.pendingEvents = [];
    this.queuedBreakpoints = [];
    this.verifications.clear();
    this.stagedBreakpoints.clear();
    this.stoppedThreads.clear();
    this.liveThreads.clear();
    this.issuedFrameIds.clear();
    this.issuedVarRefs.clear();
    this.outputRing = [];
    this.droppedOutputCount = 0;
    this._lastRequestTimeout = undefined;

    // Register DAP event handlers before starting
    this.registerEventHandlers();

    try {
      if (progressToken !== undefined) {
        await this.notifier.sendProgress(progressToken, 0, 5, 'Initializing DAP adapter...');
        this.assertStillLaunching();
      }

      // Step 1: Initialize
      await this.dapClient.initialize();
      this.assertStillLaunching();
      if (progressToken !== undefined) {
        await this.notifier.sendProgress(progressToken, 1, 5, 'DAP adapter initialized');
        this.assertStillLaunching();
      }

      // Step 2: Launch — prepare the initialized event promise before sending launch
      const initializedPromise = this.dapClient.waitForEvent('initialized', 30000);
      // If launch throws first, nobody awaits this; its later timeout must not
      // surface as an unhandled rejection. The await in step 3 still sees it.
      initializedPromise.catch(() => {});

      const launchArgs: DebugProtocol.LaunchRequestArguments = {
        ...this.sessionConfig,
        noDebug: false,
      };
      await this.dapClient.launch(launchArgs);
      this.assertStillLaunching();
      if (progressToken !== undefined) {
        await this.notifier.sendProgress(progressToken, 2, 5, 'Launch request sent');
        this.assertStillLaunching();
      }

      // Step 3: Wait for initialized event
      await initializedPromise;
      this.assertStillLaunching();
      if (progressToken !== undefined) {
        await this.notifier.sendProgress(progressToken, 3, 5, 'Adapter initialized, sending breakpoints...');
        this.assertStillLaunching();
      }

      // Step 4: Send queued breakpoints
      for (const bp of this.queuedBreakpoints) {
        await this.dapClient.sendRequest(bp.command, bp.args);
        this.assertStillLaunching();
      }
      this.queuedBreakpoints = [];
      if (progressToken !== undefined) {
        await this.notifier.sendProgress(progressToken, 4, 5, 'Breakpoints sent, finalizing...');
        this.assertStillLaunching();
      }

      // Step 5: configurationDone
      await this.dapClient.configurationDone();
      this.assertStillLaunching();
      this.setState(SessionState.Listening);
      if (progressToken !== undefined) {
        await this.notifier.sendProgress(progressToken, 5, 5, `Listening on port ${this.sessionConfig.port}...`);
      }
    } catch (err: unknown) {
      // No half-started session: free the adapter (and its port) and end in
      // Terminated, which debug_status maps to debug_launch.
      await this.dapClient.disconnect().catch(() => {});
      this.stoppedThreads.clear();
      this._stopInfo = undefined;
      if (this._state !== SessionState.Terminated) this.setState(SessionState.Terminated);
      const message = err instanceof Error ? err.message : String(err);
      this.notifier.sendLog('error', `Launch failed: ${message}`).catch(() => {});
      throw err;
    }

    return this.status;
  }

  /**
   * Abort a launch whose session was ended underneath it — by terminate(), or
   * by a `terminated`/`exited` event — so the handshake cannot finish by
   * overwriting Terminated with Listening. Checked after every await in launch().
   */
  private assertStillLaunching(): void {
    if (this._state !== SessionState.Initializing) {
      throw new Error('Launch aborted: session terminated');
    }
  }

  /** Terminate debug session. */
  async terminate(): Promise<void> {
    try {
      await this.dapClient.disconnect();
    } finally {
      this.setState(SessionState.Terminated);
      this.unregisterEventHandlers();
    }
  }

  /**
   * Sync state from an externally-started debug session (F5 / launch.json).
   * Registers event handlers and transitions straight to Listening or
   * Connected depending on whether the backend already has a live session.
   */
  async syncFromExternalSession(): Promise<SessionStatus> {
    if (this._state === SessionState.NotStarted) {
      this.registerEventHandlers();
    }
    this._launchCount++;
    this._stopInfo = undefined;
    this.pendingEvents = [];
    // A new session lifecycle must not inherit a previous launch's overrides.
    this._effectiveConfig = undefined;
    this.verifications.clear();
    this.stagedBreakpoints.clear();
    this.stoppedThreads.clear();
    this.liveThreads.clear();
    this.issuedFrameIds.clear();
    this.issuedVarRefs.clear();
    this.outputRing = [];
    this.droppedOutputCount = 0;
    this._lastRequestTimeout = undefined;
    this.setState(this.dapClient.isAlive() ? SessionState.Connected : SessionState.Listening);
    return this.status;
  }

  /** Undo registerEventHandlers(), so a later launch registers exactly one set again. */
  private unregisterEventHandlers(): void {
    for (const [eventName, handler] of this.registeredHandlers) {
      this.dapClient.offEvent(eventName, handler);
    }
    this.registeredHandlers = [];
    if ('onRequestTimeout' in this.dapClient) this.dapClient.onRequestTimeout = null;
    if ('onLateResponse' in this.dapClient) this.dapClient.onLateResponse = null;
    this.handlersRegistered = false;
  }

  private setState(newState: SessionState): void {
    const oldState = this._state;
    this._state = newState;
    this.notifier.sendLog('info', `Session state: ${oldState} → ${newState}`).catch(() => {});
  }

  /**
   * Buffer an event so a debug_wait issued after it fired can still see it.
   * Every event debug_wait races must be buffered, or that event is lost
   * whenever it lands between two tool calls.
   */
  private bufferEvent(event: DebugProtocol.Event): void {
    this.pendingEvents.push({ event, suspensionId: this._suspensionId });
    if (this.pendingEvents.length > MAX_PENDING_EVENTS) {
      this.pendingEvents.splice(0, this.pendingEvents.length - MAX_PENDING_EVENTS);
    }
  }

  private registerEventHandlers(): void {
    if (this.handlersRegistered) return;
    this.handlersRegistered = true;

    const on = (eventName: string, handler: EventHandler): void => {
      this.dapClient.onEvent(eventName, handler);
      this.registeredHandlers.push([eventName, handler]);
    };

    // A timed-out request leaves the target in an unknown state — record it so
    // status stops asserting a state it can no longer vouch for.
    if ('onRequestTimeout' in this.dapClient) {
      this.dapClient.onRequestTimeout = (command, timeoutMs) => {
        this.noteRequestTimeout(command, timeoutMs);
        this.notifier
          .sendLog(
            'warning',
            `DAP request "${command}" timed out after ${timeoutMs}ms; the target may still be executing it`,
          )
          .catch(() => {});
      };
    }
    if ('onLateResponse' in this.dapClient) {
      this.dapClient.onLateResponse = (command, seq) => {
        this.notifier
          .sendLog(
            'info',
            `Late response for abandoned DAP request "${command}" (seq ${seq}) — the adapter is still alive`,
          )
          .catch(() => {});
      };
    }

    // stopped → Paused
    on('stopped', (event) => {
      const body = (event as DebugProtocol.StoppedEvent).body;
      const threadId = body.threadId ?? 0;
      this._suspensionId++;
      this.pruneIssuedReferences();
      const stop: ThreadStop = {
        reason: body.reason,
        threadId,
        description: body.description,
        allThreadsStopped: body.allThreadsStopped,
        suspensionId: this._suspensionId,
      };
      // allThreadsStopped is false for every Xdebug stop, so this records one
      // thread rather than replacing the whole set.
      if (body.allThreadsStopped === true) this.stoppedThreads.clear();
      this.stoppedThreads.set(threadId, stop);
      this.liveThreads.add(threadId);
      this.recomputeSuspension();
      this.bufferEvent(event);
      this.notifier
        .sendDebugEvent('stopped', {
          reason: body.reason,
          threadId: body.threadId ?? 0,
          description: body.description,
          allThreadsStopped: body.allThreadsStopped,
          state: this._state,
        })
        .catch(() => {});
    });

    // continued → Connected
    // Per-thread, not session-wide. disposeConnection sends
    // ContinuedEvent(connection.id, false) when ONE connection dies; treating
    // that as a global resume reported the session as running while another
    // connection was still suspended. It also makes a late synthesized
    // `continued` (the VS Code backend's poller emits one up to 500ms after
    // markResumed already cleared the thread) a harmless no-op.
    on('continued', (event) => {
      const body = (event as DebugProtocol.ContinuedEvent).body;
      if (body?.allThreadsContinued === true || body?.threadId === undefined) {
        this.stoppedThreads.clear();
      } else {
        this.stoppedThreads.delete(body.threadId);
      }
      this.recomputeSuspension();
      this.bufferEvent(event);
      this.notifier.sendDebugEvent('continued', { state: this._state }).catch(() => {});
    });

    // terminated → Terminated
    on('terminated', (event) => {
      this.setState(SessionState.Terminated);
      this.stoppedThreads.clear();
      this._stopInfo = undefined;
      this.bufferEvent(event);
      // Synthesized by DAPClient when the adapter process died on its own.
      const body = (event as DebugProtocol.TerminatedEvent).body as
        { adapterExited?: boolean; exitCode?: number | null } | undefined;
      if (body?.adapterExited) {
        this.notifier.sendLog('error', `DAP adapter exited unexpectedly (code ${body.exitCode})`).catch(() => {});
      }
      this.notifier.sendDebugEvent('terminated', { state: this._state }).catch(() => {});
    });

    // exited → Terminated
    on('exited', (event) => {
      this.setState(SessionState.Terminated);
      this.stoppedThreads.clear();
      this._stopInfo = undefined;
      this.bufferEvent(event);
      const exitCode = (event as DebugProtocol.ExitedEvent).body.exitCode;
      this.notifier.sendDebugEvent('exited', { exitCode, state: this._state }).catch(() => {});
    });

    // thread → Connected (Xdebug connection)
    on('thread', (event) => {
      const body = (event as DebugProtocol.ThreadEvent).body;
      if (body.reason === 'exited') {
        // Drop it from BOTH sets: a suspended thread whose connection died is
        // not suspended any more, and leaving it in stoppedThreads pinned the
        // session at "paused" forever.
        this.liveThreads.delete(body.threadId);
        this.stoppedThreads.delete(body.threadId);
        this.recomputeSuspension();
        // Listen mode: PHP closing its last connection is not the end of the
        // session — the adapter keeps listening for the next request. Staying
        // Connected told the agent Xdebug was "connected and running" with no
        // connection left.
        if (this.liveThreads.size === 0 && this._state === SessionState.Connected) {
          this.setState(SessionState.Listening);
        }
      } else {
        this.liveThreads.add(body.threadId);
        if (this._state === SessionState.Listening) {
          this.setState(SessionState.Connected);
          this.flushQueuedBreakpoints().catch((err) => {
            this.notifier.sendLog('error', `Failed to flush queued breakpoints: ${err}`).catch(() => {});
          });
        }
      }
      this.bufferEvent(event);
      this.notifier
        .sendDebugEvent('thread', {
          reason: body.reason,
          threadId: body.threadId,
          state: this._state,
        })
        .catch(() => {});
    });

    /*
     * output → captured, never buffered.
     *
     * This is the ONLY channel on which a failed continuation is observable.
     * vscode-php-debug answers continue/next/stepIn/stepOut BEFORE issuing the
     * DBGp command and, when that command fails, reports it here — the success
     * response has already gone out and cannot be retracted. It also carries
     * PHP stdout/stderr (DBGp section 7.15) and xdebug_notify() output.
     *
     * Deliberately NOT bufferEvent()'d, and deliberately absent from
     * debug_wait's WAIT_EVENTS: a wait must not return because the target
     * printed something.
     */
    on('output', (event) => {
      const body = (event as DebugProtocol.OutputEvent).body;
      const text = body?.output ?? '';
      if (ADAPTER_PROTOCOL_LOG_RE.test(text)) return;

      this.outputRing.push({
        category: body?.category ?? 'console',
        output: text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}…[truncated]` : text,
        at: Date.now(),
      });
      if (this.outputRing.length > MAX_OUTPUT_RECORDS) {
        this.droppedOutputCount += this.outputRing.length - MAX_OUTPUT_RECORDS;
        this.outputRing.splice(0, this.outputRing.length - MAX_OUTPUT_RECORDS);
      }

      this.notifier
        .sendDebugEvent('output', {
          category: body?.category ?? 'console',
          output: text,
          state: this._state,
        })
        .catch(() => {});
    });

    // breakpoint → the adapter's real resolution result. Deliberately NOT
    // buffered: debug_wait must not return on breakpoint bookkeeping.
    on('breakpoint', (event) => {
      const breakpoint = (event as DebugProtocol.BreakpointEvent).body?.breakpoint;
      if (breakpoint?.id === undefined) return;
      const record: VerificationRecord = {
        verified: breakpoint.verified,
        line: breakpoint.line,
        message: breakpoint.message,
        // Absent from vscode-php-debug today; carried through so the honest
        // 'pending' vs 'failed' split works automatically once it isn't.
        reason: breakpoint.reason,
        at: Date.now(),
      };
      this.verifications.set(breakpoint.id, record);
      // The adapter only emits this once it has actually sent the write.
      this.stagedBreakpoints.delete(breakpoint.id);
      this.notifier
        .sendDebugEvent('breakpoint', {
          id: breakpoint.id,
          verified: record.verified,
          line: record.line,
          message: record.message,
          ...(record.reason !== undefined ? { reason: record.reason } : {}),
          state: this._state,
        })
        .catch(() => {});
    });
  }
}
