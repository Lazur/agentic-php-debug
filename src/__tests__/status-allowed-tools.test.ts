/**
 * debug_status must only advertise tools the asking front end registered.
 *
 * allowedToolsByState names debug_breakpoints_get, which is backed by the
 * BreakpointLedger and exists only in the VS Code extension — the MCP server
 * never builds a ledger. Advertising it over MCP sent the agent after a tool
 * that does not exist, which reads as a broken server rather than a bad hint.
 *
 * **Validates: Requirements 10.4, 17.3**
 */
import { describe, it, expect } from 'vitest';
import { createMockBackend, launchAndConnect, launchAndPause } from './helpers/mock-backend.js';
import { allowedToolsByState, allowedToolsFor, handleDebugStatus } from '../tools/debug-status.js';
import { SessionState } from '../session.js';

const LEDGER_TOOL = 'debug_breakpoints_get';

describe('allowedToolsFor', () => {
  it('omits ledger-backed tools by default, for MCP callers', () => {
    for (const state of Object.values(SessionState)) {
      expect(allowedToolsFor(state)).not.toContain(LEDGER_TOOL);
    }
  });

  it('includes them for the extension, which does register them', () => {
    const paused = allowedToolsFor(SessionState.Paused, { includeLedgerTools: true });
    expect(paused).toContain(LEDGER_TOOL);
    expect(paused).toEqual(allowedToolsByState[SessionState.Paused]);
  });

  it('changes nothing else about the advice', () => {
    for (const state of Object.values(SessionState)) {
      const withLedger = allowedToolsFor(state, { includeLedgerTools: true });
      const without = allowedToolsFor(state);
      expect(withLedger.filter((t) => t !== LEDGER_TOOL)).toEqual(without);
    }
  });

  it('never hands back the shared array for a caller to mutate', () => {
    const a = allowedToolsFor(SessionState.Paused, { includeLedgerTools: true });
    a.push('debug_nonsense');
    expect(allowedToolsFor(SessionState.Paused, { includeLedgerTools: true })).not.toContain('debug_nonsense');
  });
});

describe('handleDebugStatus', () => {
  it('advertises only real MCP tools by default', async () => {
    const mock = createMockBackend();
    const session = await launchAndPause(mock, 1);

    const result = handleDebugStatus(session);
    const { allowedTools } = result.data as { allowedTools: string[] };

    expect(allowedTools).not.toContain(LEDGER_TOOL);
    expect(allowedTools).toContain('debug_set_breakpoints');
  });

  it('includes ledger tools when the extension asks', async () => {
    const mock = createMockBackend();
    const session = await launchAndConnect(mock);

    const result = handleDebugStatus(session, { includeLedgerTools: true });
    const { allowedTools } = result.data as { allowedTools: string[] };

    expect(allowedTools).toContain(LEDGER_TOOL);
  });

  it('names debug_set_breakpoints, the name both front ends now register', () => {
    for (const state of Object.values(SessionState)) {
      expect(allowedToolsFor(state)).not.toContain('debug_breakpoints');
    }
  });
});
