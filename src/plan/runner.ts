import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ToolResult } from '../tools/types.js';
import type { ToolContext } from '../tools/registry.js';
import type { ToolInvoker } from './invoker.js';
import { Redactor } from './redact.js';
import {
  captureStop,
  DEFAULT_CAPTURE_LIMITS,
  fetchStack,
  framesNeeded,
  toFrameRecords,
  type CaptureLimits,
  type RawFrame,
} from './capture.js';
import {
  startTrigger as defaultStartTrigger,
  type TriggerContext,
  type TriggerHandle,
  type TriggerResult,
} from './trigger.js';
import {
  evaluateExpectations,
  evaluatePredictions,
  REPORT_VERSION,
  type BreakpointRecord,
  type PlanRunReport,
  type ProbeSummary,
  type RunError,
  type StopKind,
  type StopRecord,
} from './report.js';
import type { RunOutcome } from './schema.js';
import type { PlanIssue, ResolvedLineProbe, ResolvedPlan, ResolvedProbe, ResolvedTrigger } from './validate.js';

export interface RunProgress {
  phase: 'initialize' | 'execute' | 'teardown';
  message: string;
  /** Stops handled so far. */
  stops: number;
}

export interface RunPlanOptions {
  invoker: ToolInvoker;
  /** Cancels the run; teardown still runs. */
  signal?: AbortSignal;
  onProgress?: (progress: RunProgress) => void;
  runId?: string;
  /** Validation warnings, carried into the report. */
  warnings?: PlanIssue[];
  /** Recorded in the report's env, e.g. from dist/adapter/VERSION. */
  adapterVersion?: string;
  /** Recorded in the report: "headless" or "ui". */
  backend?: string;
  /** Test seams. */
  startTrigger?: (trigger: ResolvedTrigger, ctx: TriggerContext) => TriggerHandle;
  now?: () => number;
  captureLimits?: Partial<CaptureLimits>;
}

/** The slice of a debug_status / debug_wait status payload the runner reads. */
interface StatusData {
  state?: string;
  liveThreadIds?: number[];
  stoppedThreads?: Array<{ threadId: number; reason?: string }>;
  suspensionId?: number;
  recentOutput?: Array<{ category: string; output: string }>;
  droppedOutputCount?: number;
}

interface WaitData {
  reason?: string;
  event?: string | null;
  body?: Record<string, unknown> | null;
  status?: StatusData;
}

/**
 * Execute a validated plan: initialize → execute → teardown → report.
 *
 * Deterministic by construction — nothing in here consults a model, and the
 * plan cannot change once this starts. Never throws: every failure, including
 * an internal one, ends up as the report's outcome and errors, and teardown
 * always runs so no adapter or PHP process is left behind.
 */
export async function runPlan(plan: ResolvedPlan, opts: RunPlanOptions): Promise<PlanRunReport> {
  return new PlanRun(plan, opts).run();
}

class PlanRun {
  private readonly now: () => number;
  private readonly t0: number;
  private readonly startedAt: string;
  private readonly deadline: number;
  private readonly redactor: Redactor;
  private readonly captureLimits: CaptureLimits;
  private readonly stackLevels: number;
  private readonly startTrigger: (trigger: ResolvedTrigger, ctx: TriggerContext) => TriggerHandle;

  private readonly stops: StopRecord[] = [];
  private readonly probeSummaries: Record<string, ProbeSummary> = {};
  private readonly breakpoints: BreakpointRecord[] = [];
  private readonly errors: RunError[] = [];
  private readonly phases: PlanRunReport['phases'] = {};
  /** Probe id → the line the adapter actually placed its breakpoint on, when it moved it. */
  private readonly resolvedLines = new Map<string, number>();
  private readonly canonicalPaths = new Map<string, string>();

  private unmatchedStops = 0;
  private handledStops = 0;
  private launched = false;
  private port = 9003;
  private sawConnection = false;
  private trigger?: TriggerHandle;
  private triggerResult?: TriggerResult;
  private output?: PlanRunReport['output'];
  private outcome?: RunOutcome;
  private outcomeDetail?: string;

  constructor(
    private readonly plan: ResolvedPlan,
    private readonly opts: RunPlanOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.t0 = this.now();
    this.startedAt = new Date().toISOString();
    this.deadline = this.t0 + plan.limits.timeoutMs;
    this.redactor = new Redactor(plan.redact.names, plan.redact.scopes);
    this.captureLimits = {
      ...DEFAULT_CAPTURE_LIMITS,
      evaluateTimeoutMs: plan.limits.evaluateTimeoutMs,
      ...opts.captureLimits,
    };
    this.startTrigger = opts.startTrigger ?? defaultStartTrigger;

    const all = this.allProbes();
    this.stackLevels = Math.max(plan.onUnmatchedStop === 'record' ? 5 : 1, ...all.map((p) => framesNeeded(p.capture)));
    for (const p of all) this.probeSummaries[p.id] = { kind: p.kind, hits: 0, captured: 0 };
  }

  async run(): Promise<PlanRunReport> {
    try {
      const t = this.now();
      const ready = await this.initialize();
      this.phases.initialize = { ms: this.now() - t };
      if (ready) {
        const e = this.now();
        await this.execute();
        this.phases.execute = { ms: this.now() - e };
      }
    } catch (err) {
      this.end('failed', 'The runner failed internally.');
      this.errors.push({
        phase: 'execute',
        code: 'INTERNAL',
        message: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
    } finally {
      await this.teardown().catch((err) => {
        this.errors.push({
          phase: 'teardown',
          code: 'INTERNAL',
          message: err instanceof Error ? err.message : String(err),
        });
      });
    }
    return this.buildReport();
  }

  // ── initialize ─────────────────────────────────────────────────────────────

  private async initialize(): Promise<boolean> {
    this.progress('initialize', `Initializing plan "${this.plan.name}"`);

    // Never take over a live session: that could be a developer's ReAct run.
    const before = await this.call('debug_status', {});
    const state = (before.data as StatusData | undefined)?.state;
    if (before.success && state !== undefined && state !== 'not_started' && state !== 'terminated') {
      this.fail(
        'initialize',
        'SESSION_BUSY',
        `A debug session is already "${state}". Terminate it first — a plan run never takes over a live session.`,
      );
      return false;
    }

    const launchArgs: Record<string, unknown> = { stopOnEntry: this.plan.session.stopOnEntry ?? false };
    if (this.plan.session.port !== undefined) launchArgs.port = this.plan.session.port;
    if (this.opts.invoker.surface === 'extension') {
      // The extension builds its Config per launch, so these take effect there.
      for (const key of ['hostname', 'pathMappings', 'backendMode'] as const) {
        if (this.plan.session[key] !== undefined) launchArgs[key] = this.plan.session[key];
      }
    }
    // Set before the call: a launch that fails half-way may still hold the port.
    this.launched = true;
    const launch = await this.call('debug_launch', launchArgs);
    if (!launch.success) {
      this.failFrom('initialize', 'debug_launch', launch);
      return false;
    }
    this.port = (launch.data as { port?: number } | undefined)?.port ?? this.plan.session.port ?? this.port;

    // One setBreakpoints per file: re-sending a file resets every hit counter in it.
    const byFile = new Map<string, ResolvedLineProbe[]>();
    for (const p of this.plan.probes) byFile.set(p.file, [...(byFile.get(p.file) ?? []), p]);
    for (const [file, probes] of byFile) {
      const r = await this.call('debug_set_breakpoints', {
        path: file,
        breakpoints: probes.map((p) => ({
          line: p.line,
          ...(p.condition !== undefined ? { condition: p.condition } : {}),
          ...(p.hitCondition !== undefined ? { hitCondition: p.hitCondition } : {}),
        })),
      });
      if (!r.success) {
        this.failFrom('initialize', 'debug_set_breakpoints', r);
        return false;
      }
      const d = r.data as {
        breakpoints?: Array<{ line?: number; verification?: string; message?: string }>;
        stateWarning?: string;
      };
      probes.forEach((p, i) => {
        const bp = d.breakpoints?.[i];
        this.breakpoints.push({
          probe: p.id,
          kind: 'line',
          file: p.file,
          line: p.line,
          ...(bp?.verification !== undefined ? { verification: bp.verification } : {}),
          ...(bp?.message !== undefined ? { message: bp.message } : {}),
        });
        if (bp?.line !== undefined && bp.line !== p.line) this.resolvedLines.set(p.id, bp.line);
      });
      if (d.stateWarning) {
        this.fail('initialize', 'NOT_LISTENING', `${d.stateWarning} ${PROGRAM_HINT}`, 'debug_set_breakpoints');
        return false;
      }
      const notArmed = probes
        .map((p, i) => ({ p, bp: d.breakpoints?.[i] }))
        .filter(({ bp }) => bp?.verification !== 'pending_connection');
      if (notArmed.length > 0) {
        this.fail(
          'initialize',
          'BREAKPOINT_NOT_ARMED',
          'Breakpoints must be registered before PHP starts, and these were not: ' +
            notArmed
              .map(
                ({ p, bp }) => `${p.id} → ${bp?.verification ?? 'no answer'}${bp?.message ? ` (${bp.message})` : ''}`,
              )
              .join('; '),
          'debug_set_breakpoints',
        );
        return false;
      }
    }

    if (this.plan.exceptions) {
      const r = await this.call('debug_set_exception_breakpoints', { filters: this.plan.exceptions.filters });
      if (!r.success) {
        this.failFrom('initialize', 'debug_set_exception_breakpoints', r);
        return false;
      }
      const bp = (r.data as { breakpoints?: Array<{ verification?: string }> } | undefined)?.breakpoints?.[0];
      this.breakpoints.push({
        probe: this.plan.exceptions.id,
        kind: 'exception',
        filters: this.plan.exceptions.filters,
        ...(bp?.verification !== undefined ? { verification: bp.verification } : {}),
      });
    }

    if (this.plan.functions.length > 0) {
      const r = await this.call('debug_set_function_breakpoints', {
        breakpoints: this.plan.functions.map((f) => ({
          name: f.name,
          ...(f.condition !== undefined ? { condition: f.condition } : {}),
          ...(f.hitCondition !== undefined ? { hitCondition: f.hitCondition } : {}),
        })),
      });
      if (!r.success) {
        this.failFrom('initialize', 'debug_set_function_breakpoints', r);
        return false;
      }
      const bps = (r.data as { breakpoints?: Array<{ verification?: string; message?: string }> } | undefined)
        ?.breakpoints;
      this.plan.functions.forEach((f, i) =>
        this.breakpoints.push({
          probe: f.id,
          kind: 'function',
          name: f.name,
          ...(bps?.[i]?.verification !== undefined ? { verification: bps[i].verification } : {}),
          ...(bps?.[i]?.message !== undefined ? { message: bps[i].message } : {}),
        }),
      );
    }

    // The flush check. "pending_connection" is derived from session state, and
    // a config with `program` makes PHP connect DURING launch while the state
    // still reads "listening" — so ask about connections directly.
    const after = await this.call('debug_status', {});
    const s = after.data as StatusData | undefined;
    if (after.success && ((s?.liveThreadIds?.length ?? 0) > 0 || s?.state !== 'listening')) {
      this.fail(
        'initialize',
        'NOT_LISTENING',
        `Expected a listening session with no Xdebug connection before the trigger; found "${s?.state}" with ` +
          `${s?.liveThreadIds?.length ?? 0} connection(s). ${PROGRAM_HINT}`,
      );
      return false;
    }

    this.progress('initialize', `Armed ${this.breakpoints.length} breakpoint(s) on port ${this.port}`);
    return true;
  }

  // ── execute ────────────────────────────────────────────────────────────────

  private async execute(): Promise<void> {
    const executeStart = this.now();
    this.trigger = this.startTrigger(this.plan.trigger, {
      port: this.port,
      ...(this.plan.session.hostname !== undefined ? { hostname: this.plan.session.hostname } : {}),
      onMessage: (m) => this.progress('execute', m),
      now: this.now,
    });
    this.progress('execute', `Triggered (${describeTrigger(this.plan.trigger)})`);

    let quietSince: number | undefined;
    let waitErrors = 0;

    for (;;) {
      if (this.opts.signal?.aborted) return this.end('cancelled', 'The run was cancelled.');
      const now = this.now();
      if (now >= this.deadline) {
        return this.end('timeout', `The run exceeded limits.timeoutMs (${this.plan.limits.timeoutMs} ms).`);
      }

      // Block no longer than the next moment a decision could change.
      let timeout = Math.min(this.plan.limits.waitMs, this.deadline - now);
      if (!this.sawConnection) timeout = Math.min(timeout, executeStart + this.plan.limits.connectTimeoutMs - now);
      if (quietSince !== undefined) timeout = Math.min(timeout, quietSince + this.plan.limits.idleMs - now);

      const data = await this.wait(Math.max(1, Math.floor(timeout)));
      if (!data) {
        if (++waitErrors > 3) return this.end('failed', 'debug_wait kept failing.');
        continue;
      }
      waitErrors = 0;
      const status = data.status ?? {};

      if (data.reason === 'event' || data.reason === 'already_paused') quietSince = undefined;
      if (
        (status.liveThreadIds?.length ?? 0) > 0 ||
        status.state === 'connected' ||
        status.state === 'paused' ||
        data.event === 'thread'
      ) {
        this.sawConnection = true;
      }

      if (status.state === 'terminated') {
        const body = data.body as { adapterExited?: boolean; exitCode?: number } | null | undefined;
        if (data.event === 'terminated' && body?.adapterExited) {
          this.errors.push({
            phase: 'execute',
            code: 'ADAPTER_EXITED',
            message: `The debug adapter exited unexpectedly (code ${body.exitCode ?? 'unknown'}).`,
          });
          return this.end('failed', 'The debug adapter exited unexpectedly.');
        }
        return this.sawConnection
          ? this.end('completed', 'The debug session ended.')
          : this.end('failed', 'The debug session ended before Xdebug connected.');
      }

      const suspended = status.stoppedThreads ?? [];
      if (suspended.length > 0) {
        for (const t of suspended) {
          if (this.handledStops >= this.plan.limits.maxStops) {
            return this.end('max_stops', `Reached limits.maxStops (${this.plan.limits.maxStops}).`);
          }
          this.handledStops++;
          const result = await this.handleStop(t.threadId, t.reason ?? 'unknown', status.suspensionId);
          if (result === 'abort') {
            return this.end('failed', 'Execution stopped where no probe explains it, and onUnmatchedStop is "abort".');
          }
          if (result === 'fatal') return this.end('failed', 'A suspended thread could not be resumed.');
          if (this.opts.signal?.aborted) return this.end('cancelled', 'The run was cancelled.');
        }
        quietSince = undefined;
        continue;
      }

      const triggerSettled = this.trigger.isSettled();
      if (!this.sawConnection) {
        if (triggerSettled) {
          // PHP finished without dialling in. Allow idleMs for a late connection.
          quietSince ??= this.now();
          if (this.now() - quietSince >= this.plan.limits.idleMs) {
            return this.end('no_connection', await this.noConnectionDetail());
          }
        } else if (this.now() - executeStart >= this.plan.limits.connectTimeoutMs) {
          return this.end('no_connection', await this.noConnectionDetail());
        }
        continue;
      }

      // A manual trigger has no end of its own; the connections closing is the signal.
      const triggerDone = triggerSettled || this.plan.trigger.kind === 'manual';
      if (triggerDone && (status.liveThreadIds?.length ?? 0) === 0 && status.state !== 'paused') {
        quietSince ??= this.now();
        if (this.now() - quietSince >= this.plan.limits.idleMs) {
          return this.end('completed', 'The trigger finished and every Xdebug connection closed.');
        }
      } else {
        quietSince = undefined;
      }
    }
  }

  /**
   * One debug_wait, cut short when the trigger settles or the run is cancelled.
   * Returns undefined when neither the wait nor a status fallback produced data.
   */
  private async wait(timeout: number): Promise<WaitData | undefined> {
    const abort = new AbortController();
    const onRunAbort = () => abort.abort();
    this.opts.signal?.addEventListener('abort', onRunAbort, { once: true });
    if (this.trigger && !this.trigger.isSettled()) {
      this.trigger.done.then(
        () => abort.abort(),
        () => abort.abort(),
      );
    }
    try {
      const w = await this.call('debug_wait', { timeout }, { signal: abort.signal });
      if (w.success && (w.data as WaitData | undefined)?.status) return w.data as WaitData;
      // A cancelled request over MCP rejects client-side without a payload;
      // fall back to a plain status read so the loop can still decide.
      if (!w.success && !abort.signal.aborted)
        this.errors.push({
          phase: 'execute',
          tool: 'debug_wait',
          code: w.error?.code ?? 'DAP_ERROR',
          message: w.error?.message ?? 'debug_wait failed',
        });
      const st = await this.call('debug_status', {});
      return st.success ? { reason: 'status', status: st.data as StatusData } : undefined;
    } finally {
      this.opts.signal?.removeEventListener('abort', onRunAbort);
    }
  }

  private async handleStop(
    threadId: number,
    reason: string,
    suspensionId: number | undefined,
  ): Promise<'ok' | 'abort' | 'fatal'> {
    const stop: StopRecord = {
      seq: this.stops.length + 1,
      probe: null,
      kind: 'unmatched',
      hit: 0,
      captured: false,
      reason,
      threadId,
      at: this.now() - this.t0,
    };

    let frames: RawFrame[] = [];
    const stack = await fetchStack(this.opts.invoker, threadId, this.stackLevels);
    if ('error' in stack) stop.errors = [stack.error];
    else frames = stack.frames;

    const top = frames[0];
    if (top) {
      stop.location = {
        ...(top.source?.path !== undefined ? { file: top.source.path } : {}),
        ...(top.line !== undefined ? { line: top.line } : {}),
        ...(top.name !== undefined ? { function: top.name } : {}),
      };
    }

    const { probe, kind } = this.match(reason, top);
    stop.kind = kind;

    if (probe) {
      const summary = this.probeSummaries[probe.id];
      summary.hits++;
      stop.probe = probe.id;
      stop.hit = summary.hits;
      if (summary.captured < probe.maxCaptures && frames.length > 0) {
        summary.captured++;
        stop.captured = true;
        const cap = await captureStop(
          this.opts.invoker,
          { threadId, frames, reason },
          probe.capture,
          this.redactor,
          this.captureLimits,
        );
        stop.frames = cap.frames;
        if (cap.evaluate) stop.evaluate = cap.evaluate;
        if (cap.locals) stop.locals = cap.locals;
        if (cap.exception) stop.exception = cap.exception;
        if (cap.errors) stop.errors = [...(stop.errors ?? []), ...cap.errors];
      }
      this.progress(
        'execute',
        `stop ${this.handledStops}: ${probe.id} hit ${stop.hit}${stop.captured ? '' : ' (counted, not captured)'}`,
      );
      this.stops.push(stop);
    } else if (kind === 'entry') {
      this.stops.push(stop);
    } else {
      this.unmatchedStops++;
      const where = stop.location ? `${stop.location.file ?? '?'}:${stop.location.line ?? '?'}` : 'an unknown location';
      if (this.plan.onUnmatchedStop !== 'ignore') {
        stop.frames = toFrameRecords(frames, Math.min(frames.length, 5));
        this.stops.push(stop);
      }
      if (this.plan.onUnmatchedStop === 'abort') {
        this.errors.push({
          phase: 'execute',
          code: 'UNMATCHED_STOP',
          message: `Stopped (${reason}) at ${where}, which no probe explains.`,
        });
        return 'abort';
      }
      this.progress('execute', `stop ${this.handledStops}: unmatched (${reason}) at ${where}`);
    }

    return this.resume(threadId, suspensionId);
  }

  private match(reason: string, top: RawFrame | undefined): { probe: ResolvedProbe | null; kind: StopKind } {
    if (reason === 'entry') return { probe: null, kind: 'entry' };
    if (reason === 'exception') {
      return this.plan.exceptions
        ? { probe: this.plan.exceptions, kind: 'exception' }
        : { probe: null, kind: 'unmatched' };
    }
    if (top) {
      if (top.source?.path !== undefined && top.line !== undefined) {
        const file = this.canonical(top.source.path);
        const line = this.plan.probes.find(
          (p) => p.file === file && (p.line === top.line || this.resolvedLines.get(p.id) === top.line),
        );
        if (line) return { probe: line, kind: 'line' };
      }
      if (top.name !== undefined) {
        const fn = this.plan.functions.find((f) => sameFunction(f.name, top.name!));
        if (fn) return { probe: fn, kind: 'function' };
      }
    }
    return { probe: null, kind: 'unmatched' };
  }

  /** Continue a handled thread; retry once if the same suspension is still in place. */
  private async resume(threadId: number, suspensionId: number | undefined): Promise<'ok' | 'fatal'> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await this.call('debug_continue', { threadId });
      if (!r.success) {
        // The thread is gone (connection closed, session over): nothing to resume.
        if (r.error?.code === 'SESSION_NOT_PAUSED' || r.error?.code === 'SESSION_TERMINATED') return 'ok';
        this.errors.push({
          phase: 'execute',
          tool: 'debug_continue',
          code: r.error?.code ?? 'DAP_ERROR',
          message: r.error?.message ?? 'continue failed',
        });
        continue;
      }
      if ((r.data as { resumed?: boolean } | undefined)?.resumed !== false) return 'ok';

      // Not resumed: the thread re-stopped at a new place, the run finished, or
      // the continue did not take. Only the last case needs another attempt.
      const st = await this.call('debug_status', {});
      const s = st.data as StatusData | undefined;
      if (!st.success || s?.state !== 'paused') return 'ok';
      const sameSuspension =
        suspensionId !== undefined &&
        s.suspensionId === suspensionId &&
        (s.stoppedThreads ?? []).some((t) => t.threadId === threadId);
      if (!sameSuspension) return 'ok';
    }
    this.errors.push({
      phase: 'execute',
      tool: 'debug_continue',
      code: 'NOT_RESUMED',
      message: `Thread ${threadId} stayed suspended after two continue attempts.`,
    });
    return 'fatal';
  }

  // ── teardown and report ────────────────────────────────────────────────────

  private async teardown(): Promise<void> {
    const t = this.now();
    try {
      if (this.launched) {
        const st = await this.call('debug_status', {});
        const s = st.data as StatusData | undefined;
        if (st.success && s?.recentOutput) {
          this.output = {
            recent: s.recentOutput.map(({ category, output }) => ({ category, output })),
            dropped: s.droppedOutputCount ?? 0,
          };
        }
        const r = await this.call('debug_terminate', {});
        if (!r.success) {
          this.errors.push({
            phase: 'teardown',
            tool: 'debug_terminate',
            code: r.error?.code ?? 'DAP_ERROR',
            message: r.error?.message ?? 'terminate failed',
          });
        }
      }
      if (this.trigger) {
        // With the debugger gone PHP runs on and normally exits by itself;
        // give it a moment before killing it.
        if (this.plan.trigger.kind === 'manual') this.trigger.cancel();
        let result = await settleWithin(this.trigger.done, 2_000);
        if (!result) {
          this.trigger.cancel();
          result = await settleWithin(this.trigger.done, 3_000);
        }
        this.triggerResult = result ?? { kind: this.plan.trigger.kind, settled: false, error: 'did not finish' };
      }
    } finally {
      this.phases.teardown = { ms: this.now() - t };
      this.progress('teardown', `Finished: ${this.outcome ?? 'failed'}`);
    }
  }

  private buildReport(): PlanRunReport {
    const report: PlanRunReport = {
      reportVersion: REPORT_VERSION,
      runId: this.opts.runId ?? defaultRunId(this.plan.name),
      plan: {
        name: this.plan.name,
        version: this.plan.source.version,
        hash: this.plan.hash,
        ...(this.plan.goal !== undefined ? { goal: this.plan.goal } : {}),
        root: this.plan.root,
      },
      surface: this.opts.invoker.surface,
      ...(this.opts.backend !== undefined ? { backend: this.opts.backend } : {}),
      env: {
        ...(this.opts.adapterVersion !== undefined ? { adapterVersion: this.opts.adapterVersion } : {}),
        node: process.version,
        platform: process.platform,
      },
      startedAt: this.startedAt,
      durationMs: this.now() - this.t0,
      outcome: this.outcome ?? 'failed',
      ...(this.outcomeDetail !== undefined ? { outcomeDetail: this.outcomeDetail } : {}),
      phases: this.phases,
      breakpoints: this.breakpoints,
      stops: this.stops,
      probes: this.probeSummaries,
      unmatchedStops: this.unmatchedStops,
      ...(this.triggerResult ? { trigger: this.triggerResult } : {}),
      ...(this.output ? { output: this.output } : {}),
      expectations: [],
      predictions: [],
      errors: this.errors,
      warnings: this.opts.warnings ?? [],
    };
    report.expectations = evaluateExpectations(report, this.plan.expect);
    report.predictions = evaluatePredictions(report, this.plan.hypotheses);
    return report;
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private call(name: string, args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    return this.opts.invoker.invoke(name, args, ctx);
  }

  private end(outcome: RunOutcome, detail: string): void {
    this.outcome ??= outcome;
    this.outcomeDetail ??= detail;
  }

  private fail(phase: RunError['phase'], code: string, message: string, tool?: string): void {
    this.errors.push({ phase, code, message, ...(tool !== undefined ? { tool } : {}) });
    this.end('failed', message);
  }

  private failFrom(phase: RunError['phase'], tool: string, r: ToolResult): void {
    this.fail(phase, r.error?.code ?? 'DAP_ERROR', `${tool} failed: ${r.error?.message ?? 'unknown error'}`, tool);
  }

  private progress(phase: RunProgress['phase'], message: string): void {
    this.opts.onProgress?.({ phase, message, stops: this.handledStops });
  }

  private allProbes(): ResolvedProbe[] {
    return [...this.plan.probes, ...this.plan.functions, ...(this.plan.exceptions ? [this.plan.exceptions] : [])];
  }

  private canonical(path: string): string {
    let c = this.canonicalPaths.get(path);
    if (c === undefined) {
      try {
        c = realpathSync.native(path);
      } catch {
        c = resolve(path);
      }
      this.canonicalPaths.set(path, c);
    }
    return c;
  }

  private async noConnectionDetail(): Promise<string> {
    // Only read when settled: awaiting a running trigger here would block the run.
    const t = this.trigger?.isSettled() ? await this.trigger.done : undefined;
    const exit = t?.exitCode !== undefined && t.exitCode !== null ? ` The trigger exited with code ${t.exitCode}.` : '';
    return (
      'Xdebug never connected. Check that the trigger runs PHP with xdebug.mode=debug, that it reaches ' +
      `port ${this.port}, and that it starts a debug session (XDEBUG_TRIGGER / XDEBUG_SESSION or ` +
      'xdebug.start_with_request=yes).' +
      exit +
      (t?.error ? ` Trigger error: ${t.error}` : '') +
      (t?.stderrTail ? ` Trigger stderr: ${t.stderrTail.trim().slice(-500)}` : '')
    );
  }
}

const PROGRAM_HINT =
  'Plans need listen mode: a server config with "program" starts PHP during launch, before any breakpoint is armed.';

/** PHP function names are case-insensitive, and Xdebug writes instance methods with "->". */
function sameFunction(planned: string, frameName: string): boolean {
  const norm = (s: string) => s.replace(/^\\/, '').replace('->', '::').toLowerCase();
  const a = norm(planned);
  const b = norm(frameName);
  return a === b || b.endsWith(`\\${a}`);
}

function describeTrigger(t: ResolvedTrigger): string {
  switch (t.kind) {
    case 'command':
      return t.argv.join(' ');
    case 'http':
      return `${t.method} ${t.url}`;
    case 'manual':
      return 'manual';
  }
}

function defaultRunId(name: string): string {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${name}`;
}

function settleWithin<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
