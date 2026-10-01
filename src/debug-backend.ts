import type { DebugProtocol } from '@vscode/debugprotocol';

/** Callback for DAP events. */
export type EventHandler = (event: DebugProtocol.Event) => void;

/**
 * Shared interface for debug backends.
 * Both DAPClient (child-process DAP over stdio) and VsCodeDebugBackend
 * (VS Code debug API) implement this interface so that SessionManager
 * and all tool handlers work with either backend without modification.
 */
export interface DebugBackend {
  /** Start the backend and send DAP initialize request. */
  initialize(): Promise<DebugProtocol.InitializeResponse>;

  /** Send launch request with configuration. */
  launch(config: DebugProtocol.LaunchRequestArguments): Promise<DebugProtocol.LaunchResponse>;

  /** Send configurationDone request. */
  configurationDone(): Promise<DebugProtocol.ConfigurationDoneResponse>;

  /** Send a generic DAP request and wait for response. */
  sendRequest<T extends DebugProtocol.Response>(command: string, args?: object, timeout?: number): Promise<T>;

  /** Disconnect and clean up. */
  disconnect(): Promise<void>;

  /** Register an event handler for a specific DAP event type. */
  onEvent(eventName: string, handler: EventHandler): void;

  /** Remove a previously registered event handler. */
  offEvent(eventName: string, handler: EventHandler): void;

  /** Register a handler for all events. */
  onAnyEvent(handler: EventHandler): void;

  /** Wait for a specific event, with timeout. */
  waitForEvent(eventName: string, timeout?: number): Promise<DebugProtocol.Event>;

  /** Check if the backend is alive. */
  isAlive(): boolean;

  /** Get backend status details. */
  getStatus(): { alive: boolean; pid?: number; exitCode?: number; sessionId?: string };

  /** Get the current sequence counter. */
  getSeq(): number;

  /** Optional trace callback. */
  onTrace: ((direction: 'send' | 'recv', msg: DebugProtocol.ProtocolMessage) => void) | null;

  /** Optional stderr callback (DAPClient only, no-op for VsCodeDebugBackend). */
  onStderr: ((text: string) => void) | null;

  /**
   * Optional: called when a request exceeds its timeout. A timeout does not
   * cancel the in-flight command, so the session's view of the target may be
   * stale afterwards. Only backends that impose their own timeout provide this.
   */
  onRequestTimeout?: ((command: string, timeoutMs: number) => void) | null;

  /** Optional: called if a timed-out request's response arrives later. */
  onLateResponse?: ((command: string, seq: number) => void) | null;
}
