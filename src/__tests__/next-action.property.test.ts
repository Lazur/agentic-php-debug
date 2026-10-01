/**
 * Property-based tests for nextAction hints in tool results.
 * Feature: typed-tools-headless-restore
 */
import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { handleDebugContinue } from '../tools/debug-continue.js';
import { handleDebugNext } from '../tools/debug-next.js';
import { handleDebugStepIn } from '../tools/debug-step-in.js';
import { handleDebugStepOut } from '../tools/debug-step-out.js';
import { handleDebugStackTrace } from '../tools/debug-stack-trace.js';
import { handleDebugScopes } from '../tools/debug-scopes.js';
import { handleDebugVariables } from '../tools/debug-variables.js';
import { handleDebugEvaluate } from '../tools/debug-evaluate.js';
import { handleDebugSetBreakpoints } from '../tools/debug-set-breakpoints.js';
import { handleDebugThreads } from '../tools/debug-threads.js';
import { SessionManager, type NotificationSender } from '../session.js';
import type { DebugProtocol } from '@vscode/debugprotocol';
import type { Config } from '../config.js';
import type { PathMapper } from '../path-mapper.js';

// --- Shared helpers ---

function stubNotifier(): NotificationSender {
  return {
    sendProgress: vi.fn().mockResolvedValue(undefined),
    sendLog: vi.fn().mockResolvedValue(undefined),
    sendDebugEvent: vi.fn().mockResolvedValue(undefined),
  };
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

function createMockBackend() {
  const eventHandlers = new Map<string, Array<(event: DebugProtocol.Event) => void>>();

  const client = {
    onEvent: vi.fn((name: string, handler: (event: DebugProtocol.Event) => void) => {
      const list = eventHandlers.get(name) ?? [];
      list.push(handler);
      eventHandlers.set(name, list);
    }),
    offEvent: vi.fn((name: string, handler: (event: DebugProtocol.Event) => void) => {
      const list = eventHandlers.get(name);
      if (list) {
        const idx = list.indexOf(handler);
        if (idx !== -1) list.splice(idx, 1);
      }
    }),
    onAnyEvent: vi.fn(),
    initialize: vi.fn().mockResolvedValue({}),
    launch: vi.fn().mockResolvedValue({}),
    configurationDone: vi.fn().mockResolvedValue({}),
    sendRequest: vi.fn().mockResolvedValue({ body: {} }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    waitForEvent: vi.fn().mockResolvedValue({} as DebugProtocol.Event),
    isAlive: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue({ alive: true, pid: 1234 }),
    getSeq: vi.fn().mockReturnValue(1),
    onTrace: null,
    onStderr: null,
  };

  function fireEvent(name: string, body: Record<string, unknown> = {}) {
    const event: DebugProtocol.Event = { seq: 0, type: 'event', event: name, body };
    for (const h of eventHandlers.get(name) ?? []) h(event);
  }

  return { client, eventHandlers, fireEvent };
}

async function launchAndPause(client: any, fireEvent: (name: string, body: Record<string, unknown>) => void) {
  const session = new SessionManager(stubConfig(), client, stubPathMapper(), stubNotifier());
  await session.launch();
  fireEvent('thread', { threadId: 1, reason: 'started' });
  fireEvent('stopped', { reason: 'breakpoint', threadId: 1, allThreadsStopped: true });
  return session;
}

async function launchAndConnect(client: any, fireEvent: (name: string, body: Record<string, unknown>) => void) {
  const session = new SessionManager(stubConfig(), client, stubPathMapper(), stubNotifier());
  await session.launch();
  fireEvent('thread', { threadId: 1, reason: 'started' });
  return session;
}

describe('Property 5: nextAction structural validity', () => {
  /**
   * **Validates: Requirements 11.1, 11.2**
   *
   * For any tool handler that returns a successful ToolResult, the data payload
   * should contain a nextAction field that is a non-empty string containing at
   * most one sentence.
   */
  it('all successful tool results contain a non-empty nextAction string', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 100 }), async (threadId) => {
        const { client, fireEvent } = createMockBackend();

        // Configure sendRequest to return appropriate bodies for each tool
        client.sendRequest.mockImplementation(async (cmd: string) => {
          if (cmd === 'stackTrace')
            return { body: { stackFrames: [{ id: 1, name: 'main', line: 1, column: 1 }], totalFrames: 1 } };
          if (cmd === 'scopes') return { body: { scopes: [] } };
          if (cmd === 'variables') return { body: { variables: [] } };
          if (cmd === 'evaluate') return { body: { result: 'test', type: 'string', variablesReference: 0 } };
          if (cmd === 'threads') return { body: { threads: [{ id: threadId, name: 'Thread' }] } };
          if (cmd === 'setBreakpoints') return { body: { breakpoints: [] } };
          return { body: {} };
        });

        // Test stepping handlers (require Paused state)
        const pausedSession = await launchAndPause(client, fireEvent);

        // Sequential, re-pausing between each: a continuation now leaves the
        // session running, so firing all four at once only worked because
        // assertState happens before the first await. That modelled nothing
        // an agent can actually do.
        const steppingResults = [];
        for (const handler of [handleDebugContinue, handleDebugNext, handleDebugStepIn, handleDebugStepOut]) {
          steppingResults.push(await handler(pausedSession, { threadId }));
          fireEvent('stopped', { reason: 'step', threadId, allThreadsStopped: true });
        }

        const inspectionResults = await Promise.all([
          handleDebugStackTrace(pausedSession, { threadId }),
          handleDebugScopes(pausedSession, { frameId: 0 }),
          handleDebugVariables(pausedSession, { variablesReference: 1 }),
          handleDebugEvaluate(pausedSession, { expression: '$x' }),
          handleDebugThreads(pausedSession),
          handleDebugSetBreakpoints(pausedSession, { path: '/test.php', breakpoints: [] }),
        ]);

        // Breakpoint writes made while connected take a different branch with
        // its own nextAction; without this the single-sentence rule went
        // unenforced there.
        const connectedSession = await launchAndConnect(client, fireEvent);
        const connectedResults = await Promise.all([
          handleDebugSetBreakpoints(connectedSession, { path: '/test.php', breakpoints: [] }),
        ]);

        const allResults = [...steppingResults, ...inspectionResults, ...connectedResults];

        for (const result of allResults) {
          expect(result.success).toBe(true);
          const data = result.data as any;
          expect(data.nextAction).toBeDefined();
          expect(typeof data.nextAction).toBe('string');
          expect(data.nextAction.length).toBeGreaterThan(0);
          // At most one sentence: no period followed by whitespace and capital letter
          expect(data.nextAction).not.toMatch(/\.\s+[A-Z]/);
        }
      }),
      { numRuns: 100 },
    );
  }, 30000);
});

describe('Property 6: Stepping handlers recommend debug_wait', () => {
  /**
   * **Validates: Requirements 11.4**
   *
   * For any stepping handler (handleDebugContinue, handleDebugNext,
   * handleDebugStepIn, handleDebugStepOut) that returns a successful result,
   * the nextAction field should contain the string "debug_wait".
   */
  it('stepping handler nextAction always contains debug_wait', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1000 }), async (threadId) => {
        const { client, fireEvent } = createMockBackend();
        const session = await launchAndPause(client, fireEvent);

        // Sequential with a re-pause between each — see the note in Property 5.
        const results = [];
        for (const handler of [handleDebugContinue, handleDebugNext, handleDebugStepIn, handleDebugStepOut]) {
          results.push(await handler(session, { threadId }));
          fireEvent('stopped', { reason: 'step', threadId, allThreadsStopped: true });
        }

        for (const result of results) {
          expect(result.success).toBe(true);
          const data = result.data as any;
          expect(data.nextAction).toContain('debug_wait');
        }
      }),
      { numRuns: 100 },
    );
  }, 30000);
});
