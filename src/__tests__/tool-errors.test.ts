import { describe, it, expect } from 'vitest';
import { DAPRequestError, DAPTimeoutError, formatDapMessage } from '../dap-client.js';
import { SessionManager, SessionState, SessionStateError } from '../session.js';
import { toolError, StaleReferenceError } from '../tools/errors.js';
import { ErrorCodes } from '../tools/types.js';

describe('toolError', () => {
  it('maps a SessionStateError to the caller-supplied state code', () => {
    const err = new SessionStateError([SessionState.Paused], SessionState.Listening);
    expect(toolError(err).error?.code).toBe(ErrorCodes.SESSION_NOT_PAUSED);
    expect(toolError(err, { stateCode: ErrorCodes.SESSION_NOT_STARTED }).error?.code).toBe(
      ErrorCodes.SESSION_NOT_STARTED,
    );
  });

  it('preserves the exact assertState message text', () => {
    // Several handlers and tests still match on this string.
    const session = new SessionManager({} as any, {} as any, {} as any, {} as any);
    expect(() => session.assertState(SessionState.Paused)).toThrow(
      'Invalid session state: expected one of [paused], but current state is "not_started"',
    );
  });

  it('maps a DAPTimeoutError to DAP_TIMEOUT and keeps the command in detail', () => {
    const result = toolError(new DAPTimeoutError('stackTrace', 30000));
    expect(result.error?.code).toBe(ErrorCodes.DAP_TIMEOUT);
    expect(result.error?.detail).toEqual({ command: 'stackTrace' });
  });

  it('maps a StaleReferenceError to STALE_REFERENCE with full detail', () => {
    const result = toolError(new StaleReferenceError('variablesReference', 7, 3, 5));
    expect(result.error?.code).toBe(ErrorCodes.STALE_REFERENCE);
    expect(result.error?.detail).toEqual({
      kind: 'variablesReference',
      reference: 7,
      issuedInSuspension: 3,
      currentSuspension: 5,
    });
  });

  it("carries the adapter's structured body.error through to detail", () => {
    const err = new DAPRequestError('evaluate', 12, 'Undefined variable $nope', {
      id: 206,
      format: 'Undefined variable {name}',
      variables: { name: '$nope' },
      showUser: true,
    });
    const result = toolError(err);
    expect(result.error?.code).toBe(ErrorCodes.DAP_ERROR);
    expect(result.error?.detail).toEqual({
      command: 'evaluate',
      id: 206,
      format: 'Undefined variable {name}',
      variables: { name: '$nope' },
      showUser: true,
    });
  });

  it('OMITS the detail key entirely when there is nothing structured', () => {
    // A `detail: undefined` key would leak into every error payload the agent reads.
    const result = toolError(new Error('something generic'));
    expect(result.error).toEqual({ message: 'something generic', code: ErrorCodes.DAP_ERROR });
    expect('detail' in result.error!).toBe(false);
  });

  it('falls back to the caller-supplied default code', () => {
    const result = toolError(new Error('x'), { defaultCode: ErrorCodes.ADAPTER_CRASHED });
    expect(result.error?.code).toBe(ErrorCodes.ADAPTER_CRASHED);
  });

  it('stringifies a non-Error throw', () => {
    expect(toolError('plain string').error?.message).toBe('plain string');
  });
});

describe('formatDapMessage', () => {
  it('substitutes {name} placeholders from variables', () => {
    expect(formatDapMessage({ id: 1, format: 'no {thing} here', variables: { thing: 'frog' } })).toBe('no frog here');
  });

  it('leaves unknown placeholders untouched rather than printing undefined', () => {
    expect(formatDapMessage({ id: 1, format: 'a {missing} b', variables: {} })).toBe('a {missing} b');
  });

  it('handles a format with no variables at all', () => {
    expect(formatDapMessage({ id: 1, format: 'flat text' })).toBe('flat text');
  });
});
