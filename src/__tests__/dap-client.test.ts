import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { DAPRequestError, DAPClient, type ProcessSpawner, type ChildProcessLike } from '../dap-client.js';
import { frameMessage } from '../dap-framing.js';
import type { DebugProtocol } from '@vscode/debugprotocol';
import { SessionManager, SessionState, type NotificationSender } from '../session.js';
import type { Config } from '../config.js';
import type { PathMapper } from '../path-mapper.js';
import { handleDebugWait } from '../tools/debug-wait.js';

/**
 * Creates a mock child process that auto-responds to DAP requests with success responses.
 * Captures all messages written to stdin for inspection.
 * Optionally accepts a custom responder to control response behavior.
 */
function createMockProcess(options?: {
  responder?: (request: { seq: number; command: string; arguments?: unknown }) => object | null;
}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();

  const capturedMessages: Array<{ seq: number; command: string }> = [];

  // Parse incoming requests from stdin and auto-respond
  let buffer = Buffer.alloc(0);
  let contentLength = -1;

  stdin.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      if (contentLength === -1) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const header = buffer.subarray(0, headerEnd).toString('ascii');
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        if (!match) return;
        contentLength = parseInt(match[1], 10);
        buffer = buffer.subarray(headerEnd + 4);
      }

      if (buffer.length < contentLength) return;

      const body = buffer.subarray(0, contentLength).toString('utf-8');
      buffer = buffer.subarray(contentLength);
      contentLength = -1;

      const request = JSON.parse(body);
      capturedMessages.push({ seq: request.seq, command: request.command });

      if (options?.responder) {
        const customResponse = options.responder(request);
        if (customResponse) {
          stdout.write(frameMessage(customResponse));
        }
        continue;
      }

      // Auto-respond with success
      const response = {
        seq: 0,
        type: 'response',
        request_seq: request.seq,
        command: request.command,
        success: true,
        body: request.command === 'initialize' ? { supportsConfigurationDoneRequest: true } : {},
      };
      stdout.write(frameMessage(response));
    }
  });

  const process: ChildProcessLike = {
    stdin,
    stdout,
    stderr,
    pid: 12345,
    on(event: 'exit', listener: (code: number | null) => void) {
      emitter.on(event, listener);
      return process;
    },
    kill() {
      emitter.emit('exit', 0);
      return true;
    },
  };

  return { process, capturedMessages, emitter, stdout, stderr };
}

function createMockSpawner(mockProcess: ChildProcessLike): ProcessSpawner {
  return {
    spawn: () => mockProcess,
  };
}

describe('Property 6: DAP sequence number monotonicity', () => {
  /**
   * Property 6: DAP sequence number monotonicity
   *
   * For any sequence of N requests sent through the DAP client,
   * the sequence numbers assigned to those requests shall be strictly
   * monotonically increasing (each seq is greater than the previous).
   *
   * Validates: Requirements 4.3
   */
  it('sequence numbers are strictly monotonically increasing for any number of requests', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate a list of 1-20 arbitrary DAP command names
        fc.array(
          fc.constantFrom('evaluate', 'variables', 'stackTrace', 'scopes', 'threads', 'continue', 'next', 'stepIn', 'stepOut', 'pause'),
          { minLength: 1, maxLength: 20 },
        ),
        async (commands) => {
          const { process: mockProc, capturedMessages } = createMockProcess();
          const spawner = createMockSpawner(mockProc);
          const client = new DAPClient('/fake/adapter.js', spawner);

          // Initialize first (this also sends a request with a seq number)
          await client.initialize();

          // Send all the generated commands
          for (const cmd of commands) {
            await client.sendRequest(cmd, {});
          }

          // Verify strict monotonicity across ALL captured messages (including initialize)
          expect(capturedMessages.length).toBe(commands.length + 1);

          for (let i = 1; i < capturedMessages.length; i++) {
            expect(capturedMessages[i].seq).toBeGreaterThan(capturedMessages[i - 1].seq);
          }

          await client.disconnect();
        },
      ),
      { numRuns: 100 },
    );
  });
});


describe('DAPClient unit tests (Task 5.5)', () => {
  /**
   * Test initialize → launch → configurationDone sequence with mock process.
   * Requirements: 2.1, 2.2, 2.3
   */
  it('executes initialize → launch → configurationDone sequence in order', async () => {
    const { process: mockProc, capturedMessages } = createMockProcess();
    const spawner: ProcessSpawner = { spawn: () => mockProc };
    const client = new DAPClient('/fake/adapter.js', spawner);

    await client.initialize();
    await client.launch({ noDebug: false } as any);
    await client.configurationDone();

    expect(capturedMessages.map(m => m.command)).toEqual([
      'initialize',
      'launch',
      'configurationDone',
    ]);

    await client.disconnect();
  });

  /**
   * Test disconnect sends disconnect request and cleans up.
   * Requirements: 2.4
   */
  it('disconnect sends disconnect request and marks client as not alive', async () => {
    const { process: mockProc, capturedMessages } = createMockProcess();
    const spawner: ProcessSpawner = { spawn: () => mockProc };
    const client = new DAPClient('/fake/adapter.js', spawner);

    await client.initialize();
    expect(client.isAlive()).toBe(true);

    await client.disconnect();

    expect(capturedMessages.some(m => m.command === 'disconnect')).toBe(true);
    expect(client.isAlive()).toBe(false);
  });

  /**
   * Test adapter crash detection — process exits unexpectedly, pending requests are rejected.
   * Requirement: 2.5
   */
  it('rejects pending requests and updates status when adapter crashes', async () => {
    const { process: mockProc, emitter } = createMockProcess({
      // Don't auto-respond to 'evaluate' so it stays pending
      responder: (req) => {
        if (req.command === 'initialize') {
          return {
            seq: 0, type: 'response', request_seq: req.seq,
            command: 'initialize', success: true,
            body: { supportsConfigurationDoneRequest: true },
          };
        }
        // Don't respond to other requests — leave them pending
        return null;
      },
    });
    const spawner: ProcessSpawner = { spawn: () => mockProc };
    const client = new DAPClient('/fake/adapter.js', spawner);

    await client.initialize();

    // Send a request that won't get a response
    const pendingPromise = client.sendRequest('evaluate', { expression: '1+1' });

    // Simulate adapter crash
    emitter.emit('exit', 1);

    await expect(pendingPromise).rejects.toThrow(/exited unexpectedly/);
    expect(client.isAlive()).toBe(false);
    expect(client.getStatus().exitCode).toBe(1);
  });

  /**
   * Test that sendRequest throws when adapter is not running.
   * Requirement: 2.6 (invalid/missing adapter)
   */
  it('throws when sending a request before initialize', async () => {
    const client = new DAPClient('/nonexistent/adapter.js');

    await expect(client.sendRequest('evaluate', {})).rejects.toThrow(
      /not running/,
    );
  });

  /**
   * Test DAP error response propagation — adapter returns success: false.
   * Requirement: 4.5
   */
  it('rejects with error message when DAP response has success: false', async () => {
    const { process: mockProc } = createMockProcess({
      responder: (req) => {
        if (req.command === 'initialize') {
          return {
            seq: 0, type: 'response', request_seq: req.seq,
            command: 'initialize', success: true,
            body: { supportsConfigurationDoneRequest: true },
          };
        }
        // Return a failure response for everything else
        return {
          seq: 0, type: 'response', request_seq: req.seq,
          command: req.command, success: false,
          message: `Cannot ${req.command}: session not paused`,
        };
      },
    });
    const spawner: ProcessSpawner = { spawn: () => mockProc };
    const client = new DAPClient('/fake/adapter.js', spawner);

    await client.initialize();

    await expect(client.sendRequest('evaluate', { expression: '$x' }))
      .rejects.toThrow('Cannot evaluate: session not paused');

    await client.disconnect();
  });

  it('preserves the adapter\'s structured body.error on a failed response', async () => {
    // vscode-php-debug puts a DBGP error code in body.error.id
    // (phpDebug.ts:893-910). Discarding the envelope collapsed every adapter
    // failure into one opaque string.
    const { process: mockProc } = createMockProcess({
      responder: (req) => {
        if (req.command === 'initialize') {
          return {
            seq: 0, type: 'response', request_seq: req.seq,
            command: 'initialize', success: true, body: {},
          };
        }
        return {
          seq: 0, type: 'response', request_seq: req.seq,
          command: req.command, success: false,
          message: 'Error evaluating code',
          body: { error: { id: 206, format: 'Error evaluating code', showUser: true } },
        };
      },
    });
    const client = new DAPClient('/fake/adapter.js', { spawn: () => mockProc });
    await client.initialize();

    const err = await client.sendRequest('evaluate', { expression: '$x' }).catch((e) => e);

    expect(err).toBeInstanceOf(DAPRequestError);
    expect(err.command).toBe('evaluate');
    expect(err.dapMessage).toEqual({ id: 206, format: 'Error evaluating code', showUser: true });
    expect(err.message).toBe('Error evaluating code');

    await client.disconnect();
  });

  it('renders body.error.format when the adapter sent no flat message', async () => {
    const { process: mockProc } = createMockProcess({
      responder: (req) => {
        if (req.command === 'initialize') {
          return {
            seq: 0, type: 'response', request_seq: req.seq,
            command: 'initialize', success: true, body: {},
          };
        }
        return {
          seq: 0, type: 'response', request_seq: req.seq,
          command: req.command, success: false,
          body: { error: { id: 301, format: 'Stack depth {d} invalid', variables: { d: '9' } } },
        };
      },
    });
    const client = new DAPClient('/fake/adapter.js', { spawn: () => mockProc });
    await client.initialize();

    await expect(client.sendRequest('scopes', { frameId: 9 }))
      .rejects.toThrow('Stack depth 9 invalid');

    await client.disconnect();
  });
});

// --- Adapter lifecycle: crash, disconnect, relaunch ---

/** Answers initialize and disconnect; leaves every other request pending. */
function lifecycleResponder(req: { seq: number; command: string }) {
  if (req.command === 'initialize' || req.command === 'disconnect') {
    return { seq: 0, type: 'response', request_seq: req.seq, command: req.command, success: true, body: {} };
  }
  return null;
}

function collectEvents(client: DAPClient, name: string): DebugProtocol.Event[] {
  const seen: DebugProtocol.Event[] = [];
  client.onEvent(name, (e) => seen.push(e));
  return seen;
}

describe('DAPClient adapter lifecycle', () => {
  it('an unexpected exit dispatches exactly one synthetic terminated event', async () => {
    const { process: mockProc, emitter } = createMockProcess({ responder: lifecycleResponder });
    const client = new DAPClient('/fake/adapter.js', createMockSpawner(mockProc));
    const terminated = collectEvents(client, 'terminated');
    const any: DebugProtocol.Event[] = [];
    client.onAnyEvent((e) => any.push(e));

    await client.initialize();
    emitter.emit('exit', 1);

    expect(terminated).toHaveLength(1);
    expect(terminated[0].body).toEqual({ adapterExited: true, exitCode: 1 });
    expect(any.map((e) => e.event)).toEqual(['terminated']);
  });

  it('no synthetic event when the adapter already reported terminated', async () => {
    const { process: mockProc, emitter, stdout } = createMockProcess({ responder: lifecycleResponder });
    const client = new DAPClient('/fake/adapter.js', createMockSpawner(mockProc));
    const terminated = collectEvents(client, 'terminated');

    await client.initialize();
    stdout.write(frameMessage({ seq: 0, type: 'event', event: 'terminated' }));
    await vi.waitFor(() => expect(terminated).toHaveLength(1));

    emitter.emit('exit', 0);

    expect(terminated).toHaveLength(1);
    expect(terminated[0].body).toBeUndefined();
  });

  it('disconnect() reports no crash and rejects in-flight requests at once', async () => {
    const { process: mockProc } = createMockProcess({ responder: lifecycleResponder });
    const client = new DAPClient('/fake/adapter.js', createMockSpawner(mockProc));
    const terminated = collectEvents(client, 'terminated');

    await client.initialize();
    const inFlight = client.sendRequest('evaluate', { expression: '1' });

    // The mock's kill() emits 'exit' synchronously, as a real process may.
    await client.disconnect();

    await expect(inFlight).rejects.toThrow('DAP adapter disconnected');
    expect(terminated).toHaveLength(0);
    expect(client.isAlive()).toBe(false);
  });

  it('a stale process exiting after a relaunch does not touch the new adapter', async () => {
    const first = createMockProcess({ responder: lifecycleResponder });
    const second = createMockProcess();
    const procs = [first.process, second.process];
    const client = new DAPClient('/fake/adapter.js', { spawn: () => procs.shift()! });
    const terminated = collectEvents(client, 'terminated');

    await client.initialize();
    await client.disconnect();
    await client.initialize();

    first.emitter.emit('exit', 137);

    expect(client.isAlive()).toBe(true);
    expect(terminated).toHaveLength(0);
    await expect(client.sendRequest('threads')).resolves.toMatchObject({ success: true });

    await client.disconnect();
  });

  it('a crash while listening ends the session and wakes a blocked debug_wait', async () => {
    let stdout!: PassThrough;
    const mock = createMockProcess({
      responder: (req) => {
        if (req.command === 'launch') {
          // vscode-php-debug writes InitializedEvent right after the launch response.
          setImmediate(() => stdout.write(frameMessage({ seq: 0, type: 'event', event: 'initialized' })));
        }
        return { seq: 0, type: 'response', request_seq: req.seq, command: req.command, success: true, body: {} };
      },
    });
    stdout = mock.stdout;
    const client = new DAPClient('/fake/adapter.js', createMockSpawner(mock.process));
    const notifier: NotificationSender = {
      sendProgress: async () => {},
      sendLog: vi.fn(async () => {}),
      sendDebugEvent: async () => {},
    };
    const config = { adapterPath: '/fake/adapter.js', port: 9003, hostname: '127.0.0.1', stopOnEntry: false, pathMappings: {} } as unknown as Config;
    const pathMapper = { toRemote: (p: string) => p, toLocal: (p: string) => p } as PathMapper;
    const session = new SessionManager(config, client, pathMapper, notifier);

    await session.launch();
    expect(session.state).toBe(SessionState.Listening);

    const waiting = handleDebugWait(session, { timeout: 5000 });
    mock.emitter.emit('exit', 1);
    const result = await waiting;

    expect(result.success).toBe(true);
    expect((result.data as { event: string }).event).toBe('terminated');
    expect(session.state).toBe(SessionState.Terminated);
    expect(session.status.adapterAlive).toBe(false);
    expect(notifier.sendLog).toHaveBeenCalledWith('error', 'DAP adapter exited unexpectedly (code 1)');
  });
});
