import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { ProcessSpawner, ChildProcessLike } from '../dap-client.js';
import { DAPClient } from '../dap-client.js';
import { PathMapper } from '../path-mapper.js';
import { SessionManager, SessionState, type NotificationSender } from '../session.js';
import type { Config } from '../config.js';
import { frameMessage } from '../dap-framing.js';
import { handleDebugLaunch } from '../tools/debug-launch.js';
import { handleDebugSetBreakpoints } from '../tools/debug-set-breakpoints.js';
import { handleDebugStackTrace } from '../tools/debug-stack-trace.js';
import { handleDebugVariables } from '../tools/debug-variables.js';
import { handleDebugContinue } from '../tools/debug-continue.js';
import { handleDebugTerminate } from '../tools/debug-terminate.js';

/**
 * Integration test with MockProcessSpawner (Task 16.1).
 *
 * Tests the full debugging flow through real component wiring:
 * DAPClient → SessionManager → Tool Handlers
 *
 * The only mock boundary is the child process (ProcessSpawner),
 * which simulates DAP adapter responses.
 *
 * Requirements: 14.1, 14.2, 14.5, 14.6
 */

/** Creates a mock child process that simulates a DAP adapter. */
function createMockAdapter() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();

  const capturedRequests: Array<{ seq: number; command: string; arguments?: unknown }> = [];

  // Parse DAP requests from stdin and auto-respond
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
      capturedRequests.push({
        seq: request.seq,
        command: request.command,
        arguments: request.arguments,
      });

      // Build response based on command
      const response: Record<string, unknown> = {
        seq: 0,
        type: 'response',
        request_seq: request.seq,
        command: request.command,
        success: true,
        body: {},
      };

      switch (request.command) {
        case 'initialize':
          response.body = { supportsConfigurationDoneRequest: true };
          break;
        case 'launch':
          // Send response, then emit initialized event
          stdout.write(frameMessage(response));
          setTimeout(() => {
            stdout.write(frameMessage({
              seq: 0, type: 'event', event: 'initialized', body: {},
            }));
          }, 5);
          continue; // skip the default write below
        case 'setBreakpoints':
          response.body = {
            breakpoints: (request.arguments?.breakpoints ?? []).map((bp: any, i: number) => ({
              id: i + 1,
              verified: true,
              line: bp.line,
            })),
          };
          break;
        case 'stackTrace':
          response.body = {
            stackFrames: [
              {
                id: 1,
                name: 'main',
                source: { name: 'index.php', path: '/var/www/html/index.php' },
                line: 10,
                column: 1,
              },
              {
                id: 2,
                name: 'handleRequest',
                source: { name: 'app.php', path: '/var/www/html/app.php' },
                line: 25,
                column: 1,
              },
            ],
            totalFrames: 2,
          };
          break;
        case 'variables':
          response.body = {
            variables: [
              { name: '$request', value: 'object(Request)', type: 'object', variablesReference: 10 },
              { name: '$count', value: '42', type: 'int', variablesReference: 0 },
            ],
          };
          break;
        case 'continue':
          response.body = { allThreadsContinued: true };
          break;
        case 'disconnect':
          // respond then exit
          stdout.write(frameMessage(response));
          setTimeout(() => emitter.emit('exit', 0), 5);
          continue;
      }

      stdout.write(frameMessage(response));
    }
  });

  const process: ChildProcessLike = {
    stdin,
    stdout,
    stderr,
    pid: 99999,
    on(event: 'exit', listener: (code: number | null) => void) {
      emitter.on(event, listener);
      return process;
    },
    kill() {
      emitter.emit('exit', 0);
      return true;
    },
  };

  /** Emit a DAP event from the adapter to the client. */
  function emitEvent(eventName: string, body: Record<string, unknown>) {
    stdout.write(frameMessage({
      seq: 0, type: 'event', event: eventName, body,
    }));
  }

  return { process, capturedRequests, emitEvent };
}

/** Captures all notification calls for assertion. */
function createCapturingNotifier() {
  const progressCalls: Array<{ token: string | number; progress: number; total?: number; message?: string }> = [];
  const logCalls: Array<{ level: string; message: string; data?: unknown }> = [];
  const debugEventCalls: Array<{ event: string; details: Record<string, unknown> }> = [];

  const notifier: NotificationSender = {
    async sendProgress(token, progress, total, message) {
      progressCalls.push({ token, progress, total, message });
    },
    async sendLog(level, message, data) {
      logCalls.push({ level, message, data });
    },
    async sendDebugEvent(event, details) {
      debugEventCalls.push({ event, details });
    },
  };

  return { notifier, progressCalls, logCalls, debugEventCalls };
}

function createTestConfig(): Config {
  return {
    adapterPath: '/fake/phpDebug.js',
    port: 9003,
    hostname: '127.0.0.1',
    stopOnEntry: false,
    pathMappings: { '/var/www/html': '/home/user/project' },
    runtimeExecutable: 'php',
    maxConnections: 0,
    log: false,
  } as Config;
}

describe('Integration test with mock adapter (Task 16.1)', () => {
  it('full debug flow: launch → breakpoints → stopped → stack trace → variables → continue → terminate', async () => {
    // --- Setup ---
    const { process: mockProc, capturedRequests, emitEvent } = createMockAdapter();
    const spawner: ProcessSpawner = { spawn: () => mockProc };

    const config = createTestConfig();
    const pathMapper = new PathMapper([
      { local: '/home/user/project', remote: '/var/www/html' },
    ]);
    const dapClient = new DAPClient(config.adapterPath, spawner);
    const { notifier, progressCalls, logCalls, debugEventCalls } = createCapturingNotifier();
    const session = new SessionManager(config, dapClient, pathMapper, notifier);

    // --- 1. Launch ---
    const launchResult = await handleDebugLaunch(session, {}, 'test-progress-token', { isPortBound: async () => false });
    expect(launchResult.success).toBe(true);
    expect(session.state).toBe(SessionState.Listening);

    // Verify progress notifications were sent during launch (Req 14.6)
    expect(progressCalls.length).toBeGreaterThanOrEqual(3);
    expect(progressCalls.every(p => p.token === 'test-progress-token')).toBe(true);
    expect(progressCalls.some(p => p.message?.includes('Initializing'))).toBe(true);
    expect(progressCalls.some(p => p.message?.includes('Listening'))).toBe(true);

    // Verify DAP init sequence was sent
    const commands = capturedRequests.map(r => r.command);
    expect(commands).toContain('initialize');
    expect(commands).toContain('launch');
    expect(commands).toContain('configurationDone');

    // --- 2. Set breakpoints ---
    const bpResult = await handleDebugSetBreakpoints(session, {
      path: '/home/user/project/index.php',
      breakpoints: [{ line: 10 }, { line: 20 }],
    });
    expect(bpResult.success).toBe(true);
    // Breakpoints go to the adapter right away, even while listening — they
    // must be registered before Xdebug connects.
    expect((bpResult.data as any).queued).toBe(false);
    expect(capturedRequests.map(r => r.command)).toContain('setBreakpoints');

    // --- 3. Simulate Xdebug connection (thread event) ---
    emitEvent('thread', { threadId: 1, reason: 'started' });
    // Allow event to propagate
    await new Promise(r => setTimeout(r, 20));
    expect(session.state).toBe(SessionState.Connected);

    // Verify debug event notification for Xdebug connection
    expect(debugEventCalls.some(e => e.event === 'thread' && e.details.reason === 'started')).toBe(true);

    // --- 4. Simulate stopped event (breakpoint hit) ---
    emitEvent('stopped', {
      reason: 'breakpoint',
      threadId: 1,
      allThreadsStopped: true,
      description: 'Breakpoint hit',
    });
    await new Promise(r => setTimeout(r, 20));
    expect(session.state).toBe(SessionState.Paused);

    // Verify debug event notification for stopped event (Req 14.6)
    expect(debugEventCalls.some(e => e.event === 'stopped' && e.details.reason === 'breakpoint')).toBe(true);

    // --- 5. Stack trace (with path mapping) ---
    const stackResult = await handleDebugStackTrace(session, { threadId: 1 });
    expect(stackResult.success).toBe(true);
    const frames = (stackResult.data as any).stackFrames;
    expect(frames).toHaveLength(2);
    // Verify remote paths were mapped to local
    expect(frames[0].source.path).toBe('/home/user/project/index.php');
    expect(frames[1].source.path).toBe('/home/user/project/app.php');

    // --- 6. Variables ---
    const varsResult = await handleDebugVariables(session, { variablesReference: 1 });
    expect(varsResult.success).toBe(true);
    const vars = (varsResult.data as any).variables;
    expect(vars).toHaveLength(2);
    expect(vars[0].name).toBe('$request');
    expect(vars[1].name).toBe('$count');
    expect(vars[1].value).toBe('42');

    // --- 7. Continue ---
    const contResult = await handleDebugContinue(session, { threadId: 1 });
    expect(contResult.success).toBe(true);
    // The fake adapter here models the real one: it answers `continue` with
    // success and sends NO `continued` event. The session must still leave
    // paused, or debug_wait would answer already_paused while PHP runs.
    expect(session.state).toBe(SessionState.Connected);
    expect(session.stopInfo).toBeUndefined();

    // --- 8. Terminate ---
    const termResult = await handleDebugTerminate(session);
    expect(termResult.success).toBe(true);
    expect(session.state).toBe(SessionState.Terminated);
  });
});
