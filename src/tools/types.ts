/**
 * Machine-readable detail attached to an error result.
 *
 * Populated from a DAP `ErrorResponse.body.error` (a `Message`) when the
 * adapter supplied one, or from a stale-reference rejection. Every field is
 * optional: the VS Code backends fabricate `success: true` around
 * `vscode.DebugSession.customRequest()`, which returns only the response body,
 * so no envelope — and therefore no `Message` — survives on that path.
 */
export interface ToolErrorDetail {
  /**
   * DAP `Message.id`. ADAPTER-SCOPED, not a protocol-wide code — the DAP spec
   * defines it as "unique (within a debug adapter implementation)". Do not
   * switch on it. See `DAPRequestError` in `dap-client.ts` for what
   * vscode-php-debug happens to put here.
   */
  id?: number;
  /** The DAP request that failed, e.g. "evaluate". */
  command?: string;
  /** The adapter's unsubstituted format string, for machine matching. */
  format?: string;
  variables?: Record<string, string>;
  showUser?: boolean;
  url?: string;
  urlLabel?: string;
  /** Stale-reference rejections only. */
  kind?: 'frameId' | 'variablesReference';
  reference?: number;
  issuedInSuspension?: number;
  currentSuspension?: number;
}

/** Structured tool response envelope (Requirements 11.1, 11.2, 11.3). */
export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: { message: string; code: string; detail?: ToolErrorDetail };
}

/** Error code constants for machine-readable error identification. */
export const ErrorCodes = {
  SESSION_NOT_STARTED: 'SESSION_NOT_STARTED',
  SESSION_NOT_PAUSED: 'SESSION_NOT_PAUSED',
  SESSION_TERMINATED: 'SESSION_TERMINATED',
  ADAPTER_NOT_FOUND: 'ADAPTER_NOT_FOUND',
  ADAPTER_CRASHED: 'ADAPTER_CRASHED',
  DAP_ERROR: 'DAP_ERROR',
  /** A request exceeded its timeout. The target may still be executing it. */
  DAP_TIMEOUT: 'DAP_TIMEOUT',
  CONFIG_INVALID: 'CONFIG_INVALID',
  CONFIG_NOT_FOUND: 'CONFIG_NOT_FOUND',
  INVALID_PARAMS: 'INVALID_PARAMS',
  /**
   * A frameId or variablesReference issued during an earlier suspension. DAP:
   * "Once execution resumes, object references become invalid and DAP clients
   * must not use them."
   */
  STALE_REFERENCE: 'STALE_REFERENCE',
  /** The session must be running (connected), but is not. */
  SESSION_NOT_RUNNING: 'SESSION_NOT_RUNNING',
  /** Xdebug cannot honour a pause on this platform / engine version. */
  PAUSE_UNSUPPORTED: 'PAUSE_UNSUPPORTED',
  /** A debug plan failed validation; nothing was run. */
  PLAN_INVALID: 'PLAN_INVALID',
  /** A plan run needs an idle session, and one is running. */
  SESSION_BUSY: 'SESSION_BUSY',
  /** No stored plan run has that id. */
  RUN_NOT_FOUND: 'RUN_NOT_FOUND',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/** Create a success result with the given data payload. */
export function successResult(data: unknown): ToolResult {
  return { success: true, data };
}

/**
 * Create an error result with a descriptive message and error code.
 *
 * `detail` is spread conditionally on purpose: assigning it unconditionally
 * would put a `detail: undefined` key into every error payload the agent reads.
 */
export function errorResult(
  message: string,
  code: string,
  detail?: ToolErrorDetail,
): ToolResult {
  return {
    success: false,
    error: { message, code, ...(detail !== undefined ? { detail } : {}) },
  };
}
