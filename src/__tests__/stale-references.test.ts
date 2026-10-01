import { describe, it, expect } from 'vitest';
import { handleDebugStackTrace } from '../tools/debug-stack-trace.js';
import { handleDebugScopes } from '../tools/debug-scopes.js';
import { handleDebugVariables } from '../tools/debug-variables.js';
import { handleDebugContinue } from '../tools/debug-continue.js';
import { ErrorCodes } from '../tools/types.js';
import { createMockBackend, launchAndPause, type MockBackend } from './helpers/mock-backend.js';
import type { SessionManager } from '../session.js';

/** Respond per DAP command so frames and scopes come back with real ids. */
function wireResponses(mock: MockBackend, frameId = 1000, varRef = 500) {
  mock.mockClient.sendRequest.mockImplementation(async (cmd: string) => {
    if (cmd === 'stackTrace') {
      return { body: { stackFrames: [{ id: frameId, name: 'f', line: 1 }], totalFrames: 1 } };
    }
    if (cmd === 'scopes') return { body: { scopes: [{ name: 'Locals', variablesReference: varRef }] } };
    if (cmd === 'variables') return { body: { variables: [{ name: '$x', value: '1', variablesReference: 0 }] } };
    return { body: {} };
  });
}

/** Resume and re-stop, so the session advances one suspension. */
async function advanceSuspension(mock: MockBackend, session: SessionManager, threadId = 1) {
  await handleDebugContinue(session, { threadId });
  mock.fireEvent('stopped', { reason: 'breakpoint', threadId, allThreadsStopped: false });
}

describe('stale references — DAP object references die on resume', () => {
  it('accepts a reference issued in the CURRENT suspension', async () => {
    const mock = createMockBackend();
    wireResponses(mock);
    const session = await launchAndPause(mock);

    await handleDebugStackTrace(session, { threadId: 1 });
    const result = await handleDebugScopes(session, { frameId: 1000 });

    expect(result.success).toBe(true);
  });

  it('rejects a frameId issued in an EARLIER suspension', async () => {
    const mock = createMockBackend();
    wireResponses(mock);
    const session = await launchAndPause(mock);
    await handleDebugStackTrace(session, { threadId: 1 });

    await advanceSuspension(mock, session);

    const result = await handleDebugScopes(session, { frameId: 1000 });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ErrorCodes.STALE_REFERENCE);
    expect(result.error?.detail).toMatchObject({ kind: 'frameId', reference: 1000 });
    expect(result.error?.message).toContain('debug_stack_trace');
  });

  it('rejects a variablesReference issued in an EARLIER suspension', async () => {
    const mock = createMockBackend();
    wireResponses(mock);
    const session = await launchAndPause(mock);
    await handleDebugStackTrace(session, { threadId: 1 });
    await handleDebugScopes(session, { frameId: 1000 });

    await advanceSuspension(mock, session);

    const result = await handleDebugVariables(session, { variablesReference: 500 });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ErrorCodes.STALE_REFERENCE);
    expect(result.error?.detail).toMatchObject({ kind: 'variablesReference', reference: 500 });
  });

  it('FAILS OPEN: a reference we never issued is passed straight through', async () => {
    // The check must never invent a STALE_REFERENCE for an id it cannot vouch
    // for — that would break callers that get ids from elsewhere.
    const mock = createMockBackend();
    wireResponses(mock);
    const session = await launchAndPause(mock);

    const result = await handleDebugVariables(session, { variablesReference: 999999 });

    expect(result.success).toBe(true);
    expect(mock.mockClient.sendRequest).toHaveBeenCalledWith(
      'variables',
      expect.objectContaining({ variablesReference: 999999 }),
    );
  });

  it('does not confuse a frameId with a variablesReference of the same number', async () => {
    // The adapter draws the two from separate counters, so the numeric spaces
    // overlap; one shared map would raise false positives.
    const mock = createMockBackend();
    wireResponses(mock, 7, 7);
    const session = await launchAndPause(mock);
    await handleDebugStackTrace(session, { threadId: 1 }); // issues frameId 7 only

    await advanceSuspension(mock, session);

    // frameId 7 is stale...
    const scopes = await handleDebugScopes(session, { frameId: 7 });
    expect(scopes.error?.code).toBe(ErrorCodes.STALE_REFERENCE);

    // ...but variablesReference 7 was never issued, so it passes through.
    const vars = await handleDebugVariables(session, { variablesReference: 7 });
    expect(vars.success).toBe(true);
  });

  it('forgets history older than the retained window, degrading to pass-through', async () => {
    const mock = createMockBackend();
    wireResponses(mock);
    const session = await launchAndPause(mock);
    await handleDebugStackTrace(session, { threadId: 1 });

    // Walk several suspensions past the retention window.
    for (let i = 0; i < 4; i++) await advanceSuspension(mock, session);

    const result = await handleDebugScopes(session, { frameId: 1000 });

    // Pruned, so indistinguishable from "never issued" — pass-through, which is
    // exactly the pre-existing behaviour and never a false positive.
    expect(result.success).toBe(true);
  });

  it('clears tracking on relaunch', async () => {
    const mock = createMockBackend();
    wireResponses(mock);
    const session = await launchAndPause(mock);
    await handleDebugStackTrace(session, { threadId: 1 });

    await session.launch();
    mock.fireEvent('thread', { threadId: 1, reason: 'started' });
    mock.fireEvent('stopped', { reason: 'breakpoint', threadId: 1, allThreadsStopped: false });

    const result = await handleDebugScopes(session, { frameId: 1000 });
    expect(result.success).toBe(true);
  });
});
