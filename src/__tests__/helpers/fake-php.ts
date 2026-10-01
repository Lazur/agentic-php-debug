/**
 * A scripted stand-in for vscode-php-debug + Xdebug + a PHP process, for plan
 * runner tests. It speaks the DebugBackend interface and reproduces the
 * protocol behaviour the runner depends on:
 *
 * - breakpoints registered while listening answer `verified: true` (no
 *   connection to verify against), as BreakpointManager does;
 * - a continue is answered first, and the next stop arrives afterwards;
 * - every stackTrace mints fresh frame ids, as stackTraceRequest does;
 * - a connection ends with `continued` then `thread exited` (disposeConnection).
 *
 * Not collected by vitest — `include` is `src/**\/*.test.ts`.
 */
import type { DebugProtocol } from '@vscode/debugprotocol';
import type { DebugBackend, EventHandler } from '../../debug-backend.js';
import { SessionManager } from '../../session.js';
import type { Config } from '../../config.js';
import type { TriggerHandle, TriggerResult } from '../../plan/trigger.js';
import type { ResolvedTrigger } from '../../plan/validate.js';
import { stubConfig, stubNotifier, stubPathMapper } from './mock-backend.js';

export interface FakeVar {
  name: string;
  value: string;
  type?: string;
  children?: FakeVar[];
}

export interface FakeFrame {
  file: string;
  line: number;
  function?: string;
}

export interface FakeStop extends FakeFrame {
  /** DAP stop reason (default "breakpoint"). */
  reason?: string;
  /** Frames below the stopped one, innermost first. */
  callers?: FakeFrame[];
  evaluate?: Record<string, { result: string; type?: string } | { error: string }>;
  locals?: FakeVar[];
  superglobals?: FakeVar[];
  exception?: { exceptionId: string; description: string };
}

export interface FakeConnection {
  stops: FakeStop[];
}

export interface FakePhpOptions {
  /** First thread id handed out (default 1). */
  firstThreadId?: number;
  /** Simulate a config with "program": a connection opens during launch. */
  connectDuringLaunch?: boolean;
  /** Line the adapter reports for a requested breakpoint line (Xdebug resolution). */
  resolveLine?: (file: string, line: number) => number;
  /** Delay before the next event after a continue (default 2 ms). */
  stepDelayMs?: number;
}

export class FakePhp {
  readonly requests: Array<{ command: string; args: any }> = [];
  readonly backend: DebugBackend;
  /** Test hook: runs inside sendRequest before the response is returned. */
  onRequest?: (command: string, args: any) => void;

  private readonly handlers = new Map<string, EventHandler[]>();
  private readonly positions = new Map<number, { conn: FakeConnection; index: number }>();
  private readonly varRefs = new Map<number, FakeVar[]>();
  private nextBpId = 1;
  private nextFrameId = 1000;
  private nextVarRef = 5000;
  private nextThreadId: number;
  private alive = false;
  private connected = false;
  private endedConnections = 0;
  private totalConnections = 0;
  private onAllEnded?: () => void;
  private settleTrigger?: (r: TriggerResult) => void;

  constructor(private readonly opts: FakePhpOptions = {}) {
    this.nextThreadId = opts.firstThreadId ?? 1;
    const self = this;
    this.backend = {
      async initialize() {
        self.alive = true;
        return { seq: 0, type: 'response', request_seq: 0, command: 'initialize', success: true, body: {} } as DebugProtocol.InitializeResponse;
      },
      async launch() {
        if (self.opts.connectDuringLaunch) {
          // With "program" the adapter spawns PHP inside launchRequest, so the
          // connection lands while the session is still initializing.
          const threadId = self.nextThreadId++;
          self.connected = true;
          self.fire('thread', { reason: 'started', threadId });
        }
        // Emitted right after the launch response, as the adapter does.
        setTimeout(() => self.fire('initialized', {}), 0);
        return { seq: 0, type: 'response', request_seq: 0, command: 'launch', success: true } as DebugProtocol.LaunchResponse;
      },
      async configurationDone() {
        return { seq: 0, type: 'response', request_seq: 0, command: 'configurationDone', success: true } as DebugProtocol.ConfigurationDoneResponse;
      },
      async sendRequest<T extends DebugProtocol.Response>(command: string, args?: any): Promise<T> {
        self.requests.push({ command, args });
        self.onRequest?.(command, args);
        const body = self.answer(command, args ?? {});
        return { seq: 0, type: 'response', request_seq: 0, command, success: true, body } as unknown as T;
      },
      async disconnect() {
        self.alive = false;
        // With the debugger gone PHP runs to the end and exits.
        self.positions.clear();
        self.settleTrigger?.({ kind: 'command', settled: true, exitCode: null, signal: null });
      },
      onEvent(name: string, handler: EventHandler) {
        self.handlers.set(name, [...(self.handlers.get(name) ?? []), handler]);
      },
      offEvent(name: string, handler: EventHandler) {
        const list = self.handlers.get(name);
        if (!list) return;
        const i = list.indexOf(handler);
        if (i !== -1) list.splice(i, 1);
      },
      onAnyEvent() {},
      waitForEvent(name: string, timeout = 30000) {
        return new Promise<DebugProtocol.Event>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`timeout waiting for ${name}`)), timeout);
          const handler: EventHandler = (e) => {
            clearTimeout(timer);
            self.backend.offEvent(name, handler);
            resolve(e);
          };
          self.backend.onEvent(name, handler);
        });
      },
      isAlive: () => self.alive,
      getStatus: () => ({ alive: self.alive, pid: 4242 }),
      getSeq: () => 1,
      onTrace: null,
      onStderr: null,
    };
  }

  /** A SessionManager wired to this fake. */
  session(config: Partial<Config> = {}): SessionManager {
    return new SessionManager(stubConfig(config), this.backend, stubPathMapper(), stubNotifier());
  }

  /**
   * A startTrigger replacement that plays `connections` once the runner
   * triggers: sequentially by default, all at once with `parallel`.
   */
  trigger(
    connections: FakeConnection[],
    opts: { exitCode?: number; parallel?: boolean; neverSettle?: boolean } = {},
  ): (trigger: ResolvedTrigger) => TriggerHandle {
    return () => {
      let settled = false;
      let resolveDone!: (r: TriggerResult) => void;
      const done = new Promise<TriggerResult>((r) => {
        resolveDone = r;
      });
      const settle = (r: TriggerResult) => {
        if (settled) return;
        settled = true;
        resolveDone(r);
      };
      this.settleTrigger = settle;
      this.totalConnections = connections.length;
      this.endedConnections = 0;
      this.onAllEnded = () => {
        if (!opts.neverSettle) setTimeout(() => settle({ kind: 'command', settled: true, exitCode: opts.exitCode ?? 0 }), 1);
      };

      if (connections.length === 0) {
        this.onAllEnded();
      } else if (opts.parallel) {
        setTimeout(() => connections.forEach((c) => this.open(c)), 1);
      } else {
        let i = 0;
        const next = () => {
          if (i < connections.length) this.open(connections[i++], next);
        };
        setTimeout(next, 1);
      }
      return {
        done,
        isSettled: () => settled,
        cancel: () => settle({ kind: 'command', settled: true, error: 'cancelled' }),
      };
    };
  }

  private open(conn: FakeConnection, onEnd?: () => void): void {
    const threadId = this.nextThreadId++;
    this.connected = true;
    this.positions.set(threadId, { conn, index: 0 });
    (conn as FakeConnection & { onEnd?: () => void }).onEnd = onEnd;
    this.fire('thread', { reason: 'started', threadId });
    setTimeout(() => this.advance(threadId, true), 1);
  }

  /** Stop at the current position, or close the connection past the last stop. */
  private advance(threadId: number, first = false, stepped = false): void {
    const pos = this.positions.get(threadId);
    if (!pos) return;
    if (!first) pos.index++;
    const stop = pos.conn.stops[pos.index];
    if (stop) {
      // The adapter reports 'step' for a stop that ends a next/stepIn/stepOut.
      this.fire('stopped', { reason: stop.reason ?? (stepped ? 'step' : 'breakpoint'), threadId, allThreadsStopped: false });
      return;
    }
    this.positions.delete(threadId);
    this.fire('continued', { threadId, allThreadsContinued: false });
    this.fire('thread', { reason: 'exited', threadId });
    this.endedConnections++;
    (pos.conn as FakeConnection & { onEnd?: () => void }).onEnd?.();
    if (this.endedConnections === this.totalConnections) this.onAllEnded?.();
  }

  private currentStop(threadId: number): FakeStop | undefined {
    const pos = this.positions.get(threadId);
    return pos ? pos.conn.stops[pos.index] : undefined;
  }

  private frameOwner = new Map<number, { threadId: number; depth: number }>();

  private answer(command: string, args: any): unknown {
    switch (command) {
      case 'setBreakpoints':
        return {
          breakpoints: (args.breakpoints ?? []).map((b: { line: number }) => ({
            id: this.nextBpId++,
            // The adapter's raw bit: true while no connection exists.
            verified: !this.connected,
            line: this.opts.resolveLine ? this.opts.resolveLine(args.source?.path, b.line) : b.line,
          })),
        };
      case 'setFunctionBreakpoints':
        return { breakpoints: (args.breakpoints ?? []).map(() => ({ id: this.nextBpId++, verified: !this.connected })) };
      case 'setExceptionBreakpoints':
        return { breakpoints: [] };
      case 'stackTrace': {
        const stop = this.currentStop(args.threadId);
        if (!stop) throw new Error(`thread ${args.threadId} is not stopped`);
        const frames = [stop, ...(stop.callers ?? [])].slice(0, args.levels ?? 100);
        return {
          stackFrames: frames.map((f, depth) => {
            const id = this.nextFrameId++;
            this.frameOwner.set(id, { threadId: args.threadId, depth });
            return { id, name: f.function ?? '{main}', source: { path: f.file, name: f.file.split('/').pop() }, line: f.line, column: 1 };
          }),
          totalFrames: 1 + (stop.callers?.length ?? 0),
        };
      }
      case 'evaluate': {
        const owner = this.frameOwner.get(args.frameId);
        const stop = owner ? this.currentStop(owner.threadId) : undefined;
        const v = stop?.evaluate?.[args.expression];
        if (!v) throw new Error(`error evaluating code: ${args.expression}`);
        if ('error' in v) throw new Error(v.error);
        return { result: v.result, type: v.type, variablesReference: 0 };
      }
      case 'scopes': {
        const owner = this.frameOwner.get(args.frameId);
        const stop = owner ? this.currentStop(owner.threadId) : undefined;
        const scopes = [];
        if (stop?.exception) scopes.push({ name: stop.exception.exceptionId.split('\\').pop(), variablesReference: this.ref([]) });
        scopes.push({ name: 'Locals', variablesReference: this.ref(stop?.locals ?? []) });
        scopes.push({ name: 'Superglobals', variablesReference: this.ref(stop?.superglobals ?? []) });
        return { scopes };
      }
      case 'variables':
        return {
          variables: (this.varRefs.get(args.variablesReference) ?? []).map((v) => ({
            name: v.name,
            value: v.value,
            type: v.type,
            variablesReference: v.children ? this.ref(v.children) : 0,
          })),
        };
      case 'exceptionInfo': {
        const stop = this.currentStop(args.threadId);
        return stop?.exception
          ? { exceptionId: stop.exception.exceptionId, description: stop.exception.description, breakMode: 'always' }
          : {};
      }
      case 'continue':
      case 'next':
      case 'stepIn':
      case 'stepOut': {
        const threadId = args.threadId;
        setTimeout(() => this.advance(threadId, false, command !== 'continue'), this.opts.stepDelayMs ?? 2);
        return command === 'continue' ? { allThreadsContinued: false } : {};
      }
      case 'threads':
        return { threads: [...this.positions.keys()].map((id) => ({ id, name: `Request ${id}` })) };
      default:
        return {};
    }
  }

  private ref(vars: FakeVar[]): number {
    const id = this.nextVarRef++;
    this.varRefs.set(id, vars);
    return id;
  }

  fire(name: string, body: Record<string, unknown>): void {
    const event: DebugProtocol.Event = { seq: 0, type: 'event', event: name, body };
    for (const h of [...(this.handlers.get(name) ?? [])]) h(event);
  }

  commands(): string[] {
    return this.requests.map((r) => r.command);
  }
}
