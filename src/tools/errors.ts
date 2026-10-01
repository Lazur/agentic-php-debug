import { DAPRequestError, DAPTimeoutError } from '../dap-client.js';
import { SessionStateError } from '../session.js';
import { ErrorCodes, errorResult, type ErrorCode, type ToolErrorDetail, type ToolResult } from './types.js';

/**
 * A `frameId` or `variablesReference` the agent obtained during an earlier
 * suspension.
 *
 * DAP is explicit that these die on resume: "Once execution resumes, object
 * references become invalid and DAP clients must not use them." vscode-php-debug
 * does NOT enforce that — `stackTraceRequest` (phpDebug.ts:1026-1029) has its
 * `_stackFrames`/`_contexts`/`_properties` `clear()` calls commented out — so a
 * stale id stays resolvable and re-issues `context_get -d <old level>` against
 * the NEW stack. The adapter answers with plausible but wrong data instead of an
 * error, which is why this has to be caught here.
 */
export class StaleReferenceError extends Error {
  readonly name = 'StaleReferenceError';
  readonly kind: 'frameId' | 'variablesReference';
  readonly reference: number;
  readonly issuedInSuspension: number;
  readonly currentSuspension: number;

  constructor(
    kind: 'frameId' | 'variablesReference',
    reference: number,
    issuedInSuspension: number,
    currentSuspension: number,
  ) {
    super(
      `${kind} ${reference} was issued during suspension ${issuedInSuspension}; ` +
      `the session is now in suspension ${currentSuspension}. Object references do not ` +
      'survive a resume, and this adapter does not invalidate them, so reusing this id ' +
      'would return values from a different frame rather than an error. ' +
      'Call debug_stack_trace, then debug_scopes, for fresh references.',
    );
    this.kind = kind;
    this.reference = reference;
    this.issuedInSuspension = issuedInSuspension;
    this.currentSuspension = currentSuspension;
  }
}

/** Options for {@link toolError}. */
export interface ToolErrorOptions {
  /** Code to use for a state-guard rejection. Defaults to SESSION_NOT_PAUSED. */
  stateCode?: ErrorCode;
  /** Code to use when nothing more specific applies. Defaults to DAP_ERROR. */
  defaultCode?: ErrorCode;
}

/**
 * Convert a thrown value into a structured `ToolResult`.
 *
 * Dispatches on the error's CLASS. The handlers previously sniffed
 * `message.includes('Invalid session state')`, which silently misclassified any
 * adapter error whose text happened to contain that phrase.
 */
export function toolError(err: unknown, opts: ToolErrorOptions = {}): ToolResult {
  const stateCode = opts.stateCode ?? ErrorCodes.SESSION_NOT_PAUSED;
  const defaultCode = opts.defaultCode ?? ErrorCodes.DAP_ERROR;

  if (err instanceof SessionStateError) {
    return errorResult(err.message, stateCode);
  }

  if (err instanceof StaleReferenceError) {
    return errorResult(err.message, ErrorCodes.STALE_REFERENCE, {
      kind: err.kind,
      reference: err.reference,
      issuedInSuspension: err.issuedInSuspension,
      currentSuspension: err.currentSuspension,
    });
  }

  if (err instanceof DAPTimeoutError) {
    return errorResult(
      `${err.message}. The request was abandoned but the target may still be executing it, ` +
      'so the session state may be stale. Call debug_status to check the session survived. ' +
      'If the target itself is slow, retry with a larger timeout; if this timeout is already ' +
      'above your PHP-FPM read timeout, the request was likely killed underneath the debugger.',
      ErrorCodes.DAP_TIMEOUT,
      { command: err.command },
    );
  }

  const detail = dapErrorDetail(err);
  const message = err instanceof Error ? err.message : String(err);
  return errorResult(message, defaultCode, detail);
}

/**
 * Pull the adapter's structured `body.error` off a failed DAP response, if this
 * is one. Kept separate from the class check so `dap-client.ts` stays the only
 * module that knows the wire shape.
 */
function dapErrorDetail(err: unknown): ToolErrorDetail | undefined {
  if (!(err instanceof DAPRequestError)) return undefined;
  const m = err.dapMessage;
  const detail: ToolErrorDetail = {
    ...(err.command !== undefined ? { command: err.command } : {}),
    ...(m?.id !== undefined ? { id: m.id } : {}),
    ...(m?.format !== undefined ? { format: m.format } : {}),
    ...(m?.variables !== undefined ? { variables: m.variables } : {}),
    ...(m?.showUser !== undefined ? { showUser: m.showUser } : {}),
    ...(m?.url !== undefined ? { url: m.url } : {}),
    ...(m?.urlLabel !== undefined ? { urlLabel: m.urlLabel } : {}),
  };
  return Object.keys(detail).length > 0 ? detail : undefined;
}
