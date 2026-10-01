import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NotificationSender } from './session.js';

/**
 * Options every McpServer that carries an McpNotificationSender must be built with.
 *
 * Without the `logging` capability the SDK's sendLoggingMessage is a silent
 * no-op, so every state line and debugEvent is dropped (progress still works —
 * it goes through server.notification()). Declaring it also makes the SDK
 * answer `logging/setLevel`.
 */
export const MCP_SERVER_OPTIONS = { capabilities: { logging: {} } };

/**
 * Wraps the MCP SDK's notification API to implement the NotificationSender interface.
 * Sends progress and logging notifications through the MCP server's transport.
 * Debug events (breakpoint hits, thread events, etc.) are sent as structured
 * logging notifications so clients with an active SSE stream receive them in real time.
 */
export class McpNotificationSender implements NotificationSender {
  constructor(private readonly server: McpServer) {}

  /** Send a progress notification (notifications/progress). */
  async sendProgress(token: string | number, progress: number, total?: number, message?: string): Promise<void> {
    await this.server.server.notification({
      method: 'notifications/progress',
      params: {
        progressToken: token,
        progress,
        ...(total !== undefined && { total }),
        ...(message !== undefined && { message }),
      },
    });
  }

  /** Send a log notification (notifications/message). */
  async sendLog(level: string, message: string, data?: unknown): Promise<void> {
    await this.server.sendLoggingMessage({
      level: level as 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency',
      logger: 'agentic-php-debug',
      data: data !== undefined ? data : message,
    });
  }

  /**
   * Send a structured debug event notification.
   * Uses the logging channel with a well-known logger name so clients can
   * distinguish debug events from generic log messages.
   */
  async sendDebugEvent(event: string, details: Record<string, unknown>): Promise<void> {
    await this.server.sendLoggingMessage({
      level: event === 'stopped' ? 'warning' : 'info',
      logger: 'agentic-php-debug/debugEvent',
      data: { event, ...details },
    });
  }
}
