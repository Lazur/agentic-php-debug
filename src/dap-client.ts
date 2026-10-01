import type { DebugProtocol } from '@vscode/debugprotocol';
import { spawn } from 'node:child_process';
import { frameMessage, DAPStreamParser } from './dap-framing.js';
import type { DebugBackend, EventHandler } from './debug-backend.js';

// Re-export EventHandler from the canonical location for backwards compatibility
export type { EventHandler } from './debug-backend.js';

/**
 * A request that exceeded its timeout. Distinct from a generic adapter error
 * because the cause is different and so is the remedy: the target may still be
 * executing the command, and the session's view of it may now be stale.
 */
export class DAPTimeoutError extends Error {
  readonly command: string;
  readonly timeoutMs: number;

  constructor(command: string, timeoutMs: number) {
    super(`DAP request "${command}" timed out after ${timeoutMs}ms`);
    this.name = 'DAPTimeoutError';
    this.command = command;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * A DAP request the adapter answered with `success: false`.
 *
 * Carries the adapter's `body.error` (a DAP `Message`), which the previous
 * implementation discarded in favour of the flat `response.message` string.
 * That lost every machine-readable distinction the adapter had already made.
 *
 * Per the DAP spec `Message.id` is ADAPTER-SCOPED — "unique (within a debug
 * adapter implementation)" — so there is no protocol-wide registry and nothing
 * in this package interprets it. For reference only: vscode-php-debug's
 * `sendErrorResponse` (phpDebug.ts:893-910) puts a positive DBGP error code
 * (DBGP spec section 6.5.1) when the thrown error had a numeric `code`, a
 * negative Node `errno` when it had one, and 0 otherwise. Surface it; do not
 * switch on it.
 */
export class DAPRequestError extends Error {
  readonly command: string;
  readonly requestSeq: number;
  readonly dapMessage?: DebugProtocol.Message;

  constructor(command: string, requestSeq: number, message: string, dapMessage?: DebugProtocol.Message) {
    super(message);
    this.name = 'DAPRequestError';
    this.command = command;
    this.requestSeq = requestSeq;
    this.dapMessage = dapMessage;
  }
}

/**
 * Render a DAP `Message` for humans, substituting its `{name}` placeholders
 * from `variables` as the spec describes. Used only when the adapter gave us no
 * flat `response.message` to prefer.
 */
export function formatDapMessage(m: DebugProtocol.Message): string {
  const vars = m.variables ?? {};
  return (m.format ?? '').replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  );
}

/** Injectable interface for process spawning (Requirement 14.1). */
export interface ProcessSpawner {
  spawn(command: string, args: string[]): ChildProcessLike;
}

export interface ChildProcessLike {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  pid: number | undefined;
  on(event: 'exit', listener: (code: number | null) => void): this;
  kill(): boolean;
}

interface PendingRequest {
  resolve: (response: DebugProtocol.Response) => void;
  reject: (error: Error) => void;
}

/** Default spawner using child_process.spawn. */
const defaultSpawner: ProcessSpawner = {
  spawn(command: string, args: string[]): ChildProcessLike {
    return spawn(command, args, { stdio: 'pipe' }) as unknown as ChildProcessLike;
  },
};

export class DAPClient implements DebugBackend {
  private readonly adapterPath: string;
  private readonly spawner: ProcessSpawner;

  private process: ChildProcessLike | null = null;
  private parser: DAPStreamParser | null = null;
  private seq = 1;
  private readonly pending = new Map<number, PendingRequest>();
  /**
   * Requests we gave up waiting on. A timeout does not cancel the in-flight DBGp
   * command — the engine may still be evaluating — so a response can arrive long
   * after. Keeping the seq lets us report that instead of dropping it silently.
   */
  private readonly abandoned = new Map<number, string>();
  private readonly eventHandlers = new Map<string, EventHandler[]>();
  private readonly anyEventHandlers: EventHandler[] = [];

  private exitCode: number | null = null;
  private alive = false;
  /** Set once the adapter itself reports `terminated`/`exited`; suppresses the synthetic one on exit. */
  private terminalEventSeen = false;
  private stderrChunks: string[] = [];

  /** Default timeout for DAP requests in milliseconds (Req 16.2). */
  readonly defaultTimeout = 30_000;

  /** Optional callback for tracing DAP messages (request/response/event). */
  onTrace: ((direction: 'send' | 'recv', msg: DebugProtocol.ProtocolMessage) => void) | null = null;

  /** Optional callback for adapter stderr output. */
  onStderr: ((text: string) => void) | null = null;

  /**
   * Called when a request exceeds its timeout, and again if its response later
   * arrives. Lets the session record that its view of the target may be stale.
   */
  onRequestTimeout: ((command: string, timeoutMs: number) => void) | null = null;
  onLateResponse: ((command: string, seq: number) => void) | null = null;

  constructor(adapterPath: string, spawner?: ProcessSpawner) {
    this.adapterPath = adapterPath;
    this.spawner = spawner ?? defaultSpawner;
  }

  /** Register an event handler for a specific DAP event type. */
  onEvent(eventName: string, handler: EventHandler): void {
    const handlers = this.eventHandlers.get(eventName) ?? [];
    handlers.push(handler);
    this.eventHandlers.set(eventName, handlers);
  }
  /** Remove a previously registered event handler. */
  offEvent(eventName: string, handler: EventHandler): void {
    const handlers = this.eventHandlers.get(eventName);
    if (handlers) {
      const idx = handlers.indexOf(handler);
      if (idx !== -1) handlers.splice(idx, 1);
    }
  }

  /** Register a handler for all events. */
  onAnyEvent(handler: EventHandler): void {
    this.anyEventHandlers.push(handler);
  }

  /** Wait for a specific event, with timeout. */
  waitForEvent(eventName: string, timeout = 30000): Promise<DebugProtocol.Event> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout waiting for DAP event "${eventName}" after ${timeout}ms`));
      }, timeout);

      const handler: EventHandler = (event) => {
        cleanup();
        resolve(event);
      };

      const cleanup = () => {
        clearTimeout(timer);
        const handlers = this.eventHandlers.get(eventName);
        if (handlers) {
          const idx = handlers.indexOf(handler);
          if (idx !== -1) handlers.splice(idx, 1);
        }
      };

      this.onEvent(eventName, handler);
    });
  }

  /** Start the adapter process and send initialize request. */
  async initialize(): Promise<DebugProtocol.InitializeResponse> {
    const proc = this.spawner.spawn('node', [this.adapterPath]);
    this.process = proc;
    this.alive = true;
    this.exitCode = null;
    this.stderrChunks = [];
    this.terminalEventSeen = false;

    // Collect stderr for error reporting and optional forwarding
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      this.stderrChunks.push(text);
      this.onStderr?.(text);
    });

    // Track process exit
    proc.on('exit', (code) => {
      // A process we disconnected, or one a relaunch replaced, must not touch
      // the current adapter's liveness or its in-flight requests.
      if (this.process !== proc) return;

      this.alive = false;
      this.exitCode = code;
      // Reject all pending requests
      for (const [, pending] of this.pending) {
        pending.reject(
          new Error(`DAP adapter exited unexpectedly (code ${code}). stderr: ${this.stderrChunks.join('')}`),
        );
      }
      this.pending.clear();

      // The adapter died without ending the session itself. Without an event
      // nothing moves the session off its last state, and a blocked debug_wait
      // sleeps to its timeout. VsCodeDebugBackend synthesizes the same event
      // when VS Code tears its session down.
      if (!this.terminalEventSeen) {
        this.dispatchEvent({
          seq: 0,
          type: 'event',
          event: 'terminated',
          body: { adapterExited: true, exitCode: code },
        });
      }
    });

    // Set up message parser
    this.parser = new DAPStreamParser(proc.stdout);
    this.parser.on('message', (msg: DebugProtocol.ProtocolMessage) => {
      if (this.process !== proc) return;
      this.handleMessage(msg);
    });

    return this.sendRequest<DebugProtocol.InitializeResponse>('initialize', {
      clientID: 'agentic-php-debug',
      clientName: 'agentic-php-debug',
      adapterID: 'php',
      pathFormat: 'path',
      linesStartAt1: true,
      columnsStartAt1: true,
      supportsRunInTerminalRequest: false,
    });
  }

  /** Send launch request with configuration. */
  async launch(config: DebugProtocol.LaunchRequestArguments): Promise<DebugProtocol.LaunchResponse> {
    return this.sendRequest<DebugProtocol.LaunchResponse>('launch', config);
  }

  /** Send configurationDone request. */
  async configurationDone(): Promise<DebugProtocol.ConfigurationDoneResponse> {
    return this.sendRequest<DebugProtocol.ConfigurationDoneResponse>('configurationDone');
  }

  /** Send a generic DAP request and wait for response. */
  async sendRequest<T extends DebugProtocol.Response>(command: string, args?: object, timeout?: number): Promise<T> {
    if (!this.process || !this.alive) {
      throw new Error('DAP adapter is not running');
    }

    const seqNum = this.seq++;
    const request: DebugProtocol.Request = {
      seq: seqNum,
      type: 'request',
      command,
      ...(args !== undefined ? { arguments: args } : {}),
    };

    this.onTrace?.('send', request);
    const framed = frameMessage(request);

    const effectiveTimeout = timeout ?? this.defaultTimeout;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seqNum);
        // The command is still running on the engine; remember it so a late
        // response is reported rather than silently discarded.
        this.abandoned.set(seqNum, command);
        this.onRequestTimeout?.(command, effectiveTimeout);
        reject(new DAPTimeoutError(command, effectiveTimeout));
      }, effectiveTimeout);

      this.pending.set(seqNum, {
        resolve: (response: DebugProtocol.Response) => {
          clearTimeout(timer);
          resolve(response as T);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.process!.stdin.write(framed, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(seqNum);
          reject(new Error(`Failed to write to DAP adapter stdin: ${err.message}`));
        }
      });
    });
  }

  /** Send disconnect and kill the process. */
  async disconnect(): Promise<void> {
    const proc = this.process;
    if (!proc) return;

    if (this.alive) {
      try {
        await this.sendRequest('disconnect', { restart: false });
      } catch {
        // Adapter may already be gone — that's fine
      }
    }

    // Detach BEFORE killing: the exit listener ignores a process that is no
    // longer current, so an intentional kill neither reports a crash nor
    // clobbers a client that has already been relaunched.
    const wasAlive = this.alive;
    this.alive = false;
    this.process = null;
    this.parser = null;

    // The exit listener will not reject these any more, so do it here rather
    // than leave them to run out their timeout.
    for (const [, pending] of this.pending) {
      pending.reject(new Error('DAP adapter disconnected'));
    }
    this.pending.clear();

    if (wasAlive) {
      proc.kill();
    }
  }

  /** Check if the adapter process is alive. */
  isAlive(): boolean {
    return this.alive;
  }

  /** Get process status details. */
  getStatus(): { alive: boolean; pid?: number; exitCode?: number; sessionId?: string } {
    return {
      alive: this.alive,
      pid: this.process?.pid ?? undefined,
      exitCode: this.exitCode ?? undefined,
    };
  }

  /** Get the current sequence counter (for testing). */
  getSeq(): number {
    return this.seq;
  }

  private handleMessage(msg: DebugProtocol.ProtocolMessage): void {
    this.onTrace?.('recv', msg);
    if (msg.type === 'response') {
      const response = msg as DebugProtocol.Response;
      const pending = this.pending.get(response.request_seq);
      if (pending) {
        this.pending.delete(response.request_seq);
        if (response.success) {
          pending.resolve(response);
        } else {
          // Keep response.message first: it is what the adapter chose to show,
          // and existing callers match on it. Fall back to the structured
          // Message only when there is no flat text.
          const dapMessage = (response as DebugProtocol.ErrorResponse).body?.error;
          const text =
            response.message ??
            (dapMessage ? formatDapMessage(dapMessage) : undefined) ??
            `DAP request "${response.command}" failed`;
          pending.reject(new DAPRequestError(response.command, response.request_seq, text, dapMessage));
        }
      } else if (this.abandoned.has(response.request_seq)) {
        // Arrived after we timed out. Nobody is waiting for it, but the fact it
        // came back at all says the adapter survived — worth reporting.
        const command = this.abandoned.get(response.request_seq)!;
        this.abandoned.delete(response.request_seq);
        this.onLateResponse?.(command, response.request_seq);
      }
    } else if (msg.type === 'event') {
      const event = msg as DebugProtocol.Event;
      if (event.event === 'terminated' || event.event === 'exited') {
        this.terminalEventSeen = true;
      }
      this.dispatchEvent(event);
    }
  }

  /** Deliver an event, real or synthesized, to its handlers and then to the any-event handlers. */
  private dispatchEvent(event: DebugProtocol.Event): void {
    const handlers = this.eventHandlers.get(event.event);
    if (handlers) {
      for (const handler of [...handlers]) {
        handler(event);
      }
    }
    for (const handler of this.anyEventHandlers) {
      handler(event);
    }
  }
}
