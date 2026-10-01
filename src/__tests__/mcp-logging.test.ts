/**
 * The push channel, end to end through the real MCP SDK.
 *
 * The unit tests in tool-responses-notifications.test.ts mock McpServer, so
 * they could not see that SDK 1.26's sendLoggingMessage silently drops every
 * message unless the server declared the `logging` capability.
 */
import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LoggingMessageNotificationSchema, type LoggingMessageNotification } from '@modelcontextprotocol/sdk/types.js';
import { McpNotificationSender, MCP_SERVER_OPTIONS } from '../notifications.js';

async function connectedPair() {
  const server = new McpServer({ name: 'test', version: '0.0.0' }, MCP_SERVER_OPTIONS);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const received: LoggingMessageNotification['params'][] = [];
  client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
    received.push(n.params);
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client, received };
}

/** In-memory delivery is async; let queued messages land. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('MCP push notifications reach a real client', () => {
  it('advertises the logging capability', async () => {
    const { client } = await connectedPair();
    expect(client.getServerCapabilities()?.logging).toBeDefined();
  });

  it('delivers state lines and debug events as notifications/message', async () => {
    const { server, received } = await connectedPair();
    const sender = new McpNotificationSender(server);

    await sender.sendLog('info', 'Session state: connected → paused');
    await sender.sendDebugEvent('stopped', { reason: 'breakpoint', threadId: 1, state: 'paused' });
    await sender.sendDebugEvent('thread', { reason: 'started', threadId: 1, state: 'connected' });
    await flush();

    expect(received).toEqual([
      { level: 'info', logger: 'ts-php-debug-mcp', data: 'Session state: connected → paused' },
      {
        level: 'warning',
        logger: 'ts-php-debug-mcp/debugEvent',
        data: { event: 'stopped', reason: 'breakpoint', threadId: 1, state: 'paused' },
      },
      {
        level: 'info',
        logger: 'ts-php-debug-mcp/debugEvent',
        data: { event: 'thread', reason: 'started', threadId: 1, state: 'connected' },
      },
    ]);
  });
});
