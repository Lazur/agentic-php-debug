/**
 * Tests for DAP request timeout handling.
 *
 * A timeout does not cancel the in-flight command — the engine keeps evaluating
 * — so the failure has to be distinguishable from an adapter error, and the
 * session has to stop vouching for a state it can no longer see.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { DAPClient, DAPTimeoutError, type ProcessSpawner, type ChildProcessLike } from '../dap-client.js';
import { frameMessage } from '../dap-framing.js';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { SessionManager, SessionState, type NotificationSender } from '../session.js';
import type { Config } from '../config.js';
import type { PathMapper } from '../path-mapper.js';
import type { DebugProtocol } from '@vscode/debugprotocol';
import { handleDebugEvaluate } from '../tools/debug-evaluate.js';
import { handleDebugStatus } from '../tools/debug-status.js';
import { ErrorCodes } from '../tools/types.js';

function stubNotifier(): NotificationSender {
  return { sendProgress: async () => {}, sendLog: async () => {}, sendDebugEvent: async () => {} };
}
function stubConfig(): Config {
  return {
    adapterPath: '/fake/adapter.js',
    port: 9003,
    hostname: '127.0.0.1',
    stopOnEntry: false,
    pathMappings: {},
    runtimeExecutable: 'php',
    maxConnections: 0,
    log: false,
  } as Config;
}
function stubPathMapper(): PathMapper {
  return { toRemote: (p: string) => p, toLocal: (p: string) => p } as PathMapper;
}

/** A process that answers `initialize` and then goes quiet. */
function createSilentProcess() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const emitter = new EventEmitter();
  let buffer = Buffer.alloc(0);

  stdin.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;
    const body = buffer.subarray(headerEnd + 4).toString();
    buffer = Buffer.alloc(0);
    try {
      const msg = JSON.parse(body);
      if (msg.command === 'initialize') {
        stdout.write(
          frameMessage({
            seq: 1,
            type: 'response',
            request_seq: msg.seq,
            command: 'initialize',
            success: true,
            body: {},
          } as DebugProtocol.Response),
        );
      }
    } catch {
      /* partial frame */
    }
  });

  const proc = Object.assign(emitter, {
    stdin,
    stdout,
    stderr: new PassThrough(),
    pid: 4321,
    kill: () => true,
  }) as unknown as ChildProcessLike;
  return { proc, stdout };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('DAPTimeoutError', () => {
  it('is thrown instead of a generic Error, carrying command and duration', async () => {
    vi.useFakeTimers();
    const { proc } = createSilentProcess();
    const spawner: ProcessSpawner = { spawn: () => proc };
    const client = new DAPClient('/fake/adapter.js', spawner);

    const init = client.initialize();
    await vi.advanceTimersByTimeAsync(10);
    await init;

    const pending = client.sendRequest('evaluate', {}, 2000);
    const assertion = expect(pending).rejects.toBeInstanceOf(DAPTimeoutError);
    await vi.advanceTimersByTimeAsync(2001);
    await assertion;
  });

  it('notifies the session, which stops asserting an unqualified state', async () => {
    vi.useFakeTimers();
    const { proc } = createSilentProcess();
    const spawner: ProcessSpawner = { spawn: () => proc };
    const client = new DAPClient('/fake/adapter.js', spawner);
    const session = new SessionManager(stubConfig(), client, stubPathMapper(), stubNotifier());

    const launch = session.launch();
    await vi.advanceTimersByTimeAsync(10);
    // launch waits on the `initialized` event which never comes; abandon it.
    launch.catch(() => {});

    const pending = client.sendRequest('evaluate', {}, 1000);
    const assertion = expect(pending).rejects.toBeInstanceOf(DAPTimeoutError);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;

    expect(session.status.lastRequestTimeout).toMatchObject({
      command: 'evaluate',
      timeoutMs: 1000,
    });

    const guidance = (handleDebugStatus(session).data as any).guidance;
    expect(guidance).toContain('timed out');
    expect(guidance).toContain('may still be executing it');
  });
});

describe('handleDebugEvaluate timeout reporting', () => {
  it('reports DAP_TIMEOUT, not DAP_ERROR, and says how to tell the causes apart', async () => {
    const client = {
      onEvent: vi.fn(),
      offEvent: vi.fn(),
      onAnyEvent: vi.fn(),
      initialize: vi.fn().mockResolvedValue({}),
      launch: vi.fn().mockResolvedValue({}),
      configurationDone: vi.fn().mockResolvedValue({}),
      sendRequest: vi.fn().mockRejectedValue(new DAPTimeoutError('evaluate', 2000)),
      disconnect: vi.fn().mockResolvedValue(undefined),
      waitForEvent: vi.fn().mockResolvedValue({} as DebugProtocol.Event),
      isAlive: () => true,
      getStatus: () => ({ alive: true, pid: 1 }),
      getSeq: () => 1,
      onTrace: null,
      onStderr: null,
    };
    const session = new SessionManager(stubConfig(), client as any, stubPathMapper(), stubNotifier());
    await session.launch();
    // Drive to Paused so evaluate is allowed.
    for (const call of client.onEvent.mock.calls) {
      if (call[0] === 'stopped') {
        call[1]({ seq: 0, type: 'event', event: 'stopped', body: { reason: 'breakpoint', threadId: 1 } });
      }
    }
    expect(session.state).toBe(SessionState.Paused);

    const result = await handleDebugEvaluate(session, { expression: '$x', frameId: 1 });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ErrorCodes.DAP_TIMEOUT);
    // The reporter could not separate an adapter timeout from an fpm read
    // timeout; the message has to say how.
    expect(result.error?.message).toContain('PHP-FPM read timeout');
    expect(result.error?.message).toContain('may still be evaluating');
  });

  it('passes an explicit timeout through to the adapter', async () => {
    const sendRequest = vi.fn().mockResolvedValue({ body: { result: '1', type: 'int' } });
    const client = {
      onEvent: vi.fn(),
      offEvent: vi.fn(),
      onAnyEvent: vi.fn(),
      initialize: vi.fn().mockResolvedValue({}),
      launch: vi.fn().mockResolvedValue({}),
      configurationDone: vi.fn().mockResolvedValue({}),
      sendRequest,
      disconnect: vi.fn().mockResolvedValue(undefined),
      waitForEvent: vi.fn().mockResolvedValue({} as DebugProtocol.Event),
      isAlive: () => true,
      getStatus: () => ({ alive: true, pid: 1 }),
      getSeq: () => 1,
      onTrace: null,
      onStderr: null,
    };
    const session = new SessionManager(stubConfig(), client as any, stubPathMapper(), stubNotifier());
    await session.launch();
    for (const call of client.onEvent.mock.calls) {
      if (call[0] === 'stopped') {
        call[1]({ seq: 0, type: 'event', event: 'stopped', body: { reason: 'breakpoint', threadId: 1 } });
      }
    }

    await handleDebugEvaluate(session, { expression: '$x', frameId: 1, timeout: 2500 });

    expect(sendRequest).toHaveBeenCalledWith('evaluate', expect.anything(), 2500);
  });
});
