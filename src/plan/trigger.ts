import { spawn as nodeSpawn } from 'node:child_process';
import type { ResolvedTrigger } from './validate.js';

/** What a trigger did, as recorded in the run report. */
export interface TriggerResult {
  kind: ResolvedTrigger['kind'];
  settled: boolean;
  /** command */
  exitCode?: number | null;
  signal?: string | null;
  stdoutTail?: string;
  stderrTail?: string;
  /** http */
  status?: number;
  bodyTail?: string;
  /** Spawn failure, network error, or cancellation. */
  error?: string;
  durationMs?: number;
}

export interface TriggerHandle {
  /** Settles when the command exits, the response completes, or the trigger is cancelled. */
  readonly done: Promise<TriggerResult>;
  isSettled(): boolean;
  /** Kill the process / abort the request / release a manual trigger. Idempotent. */
  cancel(): void;
}

export interface TriggerContext {
  /** Xdebug listen port of the session — injected into XDEBUG_CONFIG for command triggers. */
  port: number;
  /** Listen host; wildcards are replaced by 127.0.0.1 for the client side. */
  hostname?: string;
  /** Receives the instructions of a manual trigger. */
  onMessage?: (message: string) => void;
  spawn?: typeof nodeSpawn;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Tail kept of stdout, stderr and HTTP bodies. */
const TAIL_BYTES = 8 * 1024;

/**
 * Start PHP. Returns immediately: the trigger runs concurrently with the
 * runner's wait loop, because it BLOCKS while PHP sits at a breakpoint. A
 * trigger awaited before the loop would deadlock the run at the first hit.
 */
export function startTrigger(trigger: ResolvedTrigger, ctx: TriggerContext): TriggerHandle {
  switch (trigger.kind) {
    case 'command':
      return startCommand(trigger, ctx);
    case 'http':
      return startHttp(trigger, ctx);
    case 'manual':
      return startManual(trigger, ctx);
  }
}

function startCommand(
  trigger: Extract<ResolvedTrigger, { kind: 'command' }>,
  ctx: TriggerContext,
): TriggerHandle {
  const now = ctx.now ?? Date.now;
  const t0 = now();
  const spawn = ctx.spawn ?? nodeSpawn;
  let settled = false;
  let stdout = '';
  let stderr = '';

  const xdebugEnv: Record<string, string> = trigger.xdebugEnv
    ? {
        XDEBUG_MODE: 'debug',
        XDEBUG_TRIGGER: '1',
        XDEBUG_CONFIG: `client_host=${clientHost(ctx.hostname)} client_port=${ctx.port}`,
      }
    : {};

  let child: ReturnType<typeof nodeSpawn> | undefined;
  let resolveDone!: (r: TriggerResult) => void;
  const done = new Promise<TriggerResult>((resolve) => {
    resolveDone = resolve;
  });
  const finish = (partial: Omit<TriggerResult, 'kind' | 'settled' | 'durationMs'>) => {
    if (settled) return;
    settled = true;
    resolveDone({
      kind: 'command',
      settled: true,
      ...partial,
      stdoutTail: stdout,
      stderrTail: stderr,
      durationMs: now() - t0,
    });
  };

  try {
    child = spawn(trigger.argv[0], trigger.argv.slice(1), {
      cwd: trigger.cwd,
      env: { ...process.env, ...xdebugEnv, ...trigger.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d: Buffer) => {
      stdout = tail(stdout + d.toString());
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr = tail(stderr + d.toString());
    });
    child.on('error', (err) => finish({ error: `Could not start ${trigger.argv[0]}: ${err.message}` }));
    child.on('close', (code, signal) => finish({ exitCode: code, signal }));
  } catch (err) {
    finish({ error: `Could not start ${trigger.argv[0]}: ${err instanceof Error ? err.message : String(err)}` });
  }

  return {
    done,
    isSettled: () => settled,
    cancel: () => {
      if (settled) return;
      if (child && child.exitCode === null) child.kill('SIGTERM');
      // 'close' normally follows the kill; this covers a process that ignores it.
      setTimeout(() => {
        if (!settled && child && child.exitCode === null) child.kill('SIGKILL');
        finish({ error: 'cancelled' });
      }, 2000).unref();
    },
  };
}

function startHttp(trigger: Extract<ResolvedTrigger, { kind: 'http' }>, ctx: TriggerContext): TriggerHandle {
  const now = ctx.now ?? Date.now;
  const t0 = now();
  const doFetch = ctx.fetch ?? fetch;
  const abort = new AbortController();
  let settled = false;

  const headers: Record<string, string> = { ...trigger.headers };
  if (trigger.xdebugCookie) {
    const existing = Object.entries(headers).find(([k]) => k.toLowerCase() === 'cookie');
    const cookie = 'XDEBUG_SESSION=plan';
    if (existing) headers[existing[0]] = `${existing[1]}; ${cookie}`;
    else headers.Cookie = cookie;
  }

  // No timeout of its own: the response legitimately takes as long as PHP sits
  // at breakpoints. The run's deadline cancels it.
  const done = (async (): Promise<TriggerResult> => {
    try {
      const res = await doFetch(trigger.url, {
        method: trigger.method,
        headers,
        ...(trigger.body !== undefined ? { body: trigger.body } : {}),
        signal: abort.signal,
      });
      const text = await res.text();
      return { kind: 'http', settled: true, status: res.status, bodyTail: tail(text), durationMs: now() - t0 };
    } catch (err) {
      const message = abort.signal.aborted ? 'cancelled' : err instanceof Error ? err.message : String(err);
      return { kind: 'http', settled: true, error: message, durationMs: now() - t0 };
    } finally {
      settled = true;
    }
  })();

  return {
    done,
    isSettled: () => settled,
    cancel: () => {
      if (!settled) abort.abort();
    },
  };
}

function startManual(trigger: Extract<ResolvedTrigger, { kind: 'manual' }>, ctx: TriggerContext): TriggerHandle {
  ctx.onMessage?.(trigger.instructions ?? 'Trigger the PHP request now.');
  let settled = false;
  let release!: () => void;
  const done = new Promise<TriggerResult>((resolve) => {
    release = () => {
      settled = true;
      resolve({ kind: 'manual', settled: true });
    };
  });
  return {
    done,
    // A person never "finishes"; the run ends on connection idleness instead.
    isSettled: () => settled,
    cancel: () => {
      if (!settled) release();
    },
  };
}

/** The address PHP should dial: a wildcard listen address is not dialable. */
function clientHost(hostname: string | undefined): string {
  if (!hostname || hostname === '0.0.0.0' || hostname === '::' || hostname === '[::]') return '127.0.0.1';
  return hostname;
}

function tail(text: string): string {
  return text.length > TAIL_BYTES ? text.slice(text.length - TAIL_BYTES) : text;
}
