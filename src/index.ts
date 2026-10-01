#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.js';
import { PathMapper, type PathMapping } from './path-mapper.js';
import { DAPClient } from './dap-client.js';
import type { DebugBackend } from './debug-backend.js';
import { SessionManager } from './session.js';
import { McpNotificationSender, MCP_SERVER_OPTIONS } from './notifications.js';
import { registerAllTools, SERVER_MODES, type ServerMode } from './tools/index.js';
import { registerPlanResources, registerPrompts } from './prompts/index.js';
import { RunStore } from './plan/store.js';

// --- CLI argument parsing ---
const { values } = parseArgs({
  options: {
    config: { type: 'string', short: 'c' },
    transport: { type: 'string', short: 't', default: 'stdio' },
    port: { type: 'string', short: 'p', default: '3000' },
    verbose: { type: 'string', short: 'v', default: '0' },
    // react (default): interactive tools · plan: write-then-run plans only · all: both
    mode: { type: 'string', short: 'm', default: 'react' },
    // Plans may spawn processes (trigger kind "command") only when this is set.
    'allow-command-trigger': { type: 'boolean', default: false },
    'runs-dir': { type: 'string' },
  },
  strict: true,
});

if (!values.config) {
  console.error('Error: --config <path> is required');
  process.exit(1);
}

const transportType = values.transport ?? 'stdio';
const httpPort = parseInt(values.port ?? '3000', 10);
const verbosity = parseInt(values.verbose ?? '0', 10);

if (!SERVER_MODES.includes(values.mode as ServerMode)) {
  console.error(`Error: --mode must be one of ${SERVER_MODES.join(', ')}`);
  process.exit(1);
}
const mode = values.mode as ServerMode;

// --- Load and validate config ---
const config = loadConfig(values.config);

// --- Build path mappings from config ---
const mappings: PathMapping[] = Object.entries(config.pathMappings).map(([remote, local]) => ({ remote, local }));
const pathMapper = new PathMapper(mappings);

// One store for the process: run ids are unique, and in HTTP mode a run made in
// one MCP session can still be read from another.
const runStore = new RunStore(resolve(values['runs-dir'] ?? join(tmpdir(), 'php-debug-mcp', 'runs')));

function readAdapterVersion(): string | undefined {
  try {
    return readFileSync(join(dirname(config.adapterPath), 'VERSION'), 'utf-8').trim();
  } catch {
    return undefined;
  }
}
const adapterVersion = readAdapterVersion();

// --- Create core components (factory for per-session instances in HTTP mode) ---
function createMcpStack() {
  const dapClient: DebugBackend = new DAPClient(config.adapterPath);
  const mcpServer = new McpServer(
    {
      name: 'agentic-php-debug',
      version: '0.1.0',
    },
    MCP_SERVER_OPTIONS,
  );
  const notifier = new McpNotificationSender(mcpServer);
  const session = new SessionManager(config, dapClient, pathMapper, notifier);
  registerAllTools(mcpServer, session, {
    mode,
    plan: {
      store: runStore,
      baseDir: process.cwd(),
      allowCommandTrigger: values['allow-command-trigger'] ?? false,
      backend: 'headless',
      ...(adapterVersion !== undefined ? { adapterVersion } : {}),
    },
  });
  registerPrompts(mcpServer, mode);
  registerPlanResources(mcpServer, runStore, mode);

  // --- Wire verbose logging ---
  if (verbosity >= 1) {
    dapClient.onStderr = (text) => {
      notifier.sendLog('debug', `[adapter stderr] ${text.trimEnd()}`).catch(() => {});
    };
  }
  if (verbosity >= 2) {
    dapClient.onTrace = (direction, msg) => {
      const arrow = direction === 'send' ? '→ DAP' : '← DAP';
      notifier.sendLog('debug', `${arrow} ${JSON.stringify(msg)}`).catch(() => {});
    };
  }

  return { mcpServer, session };
}

// --- Graceful shutdown ---
// Each session owns an adapter child process holding the Xdebug port. Leaking
// one is not cosmetic: the port stays bound and the next launch cannot listen.
// process.exit() skips 'beforeExit' entirely, so shutdown must be explicit here.
const liveSessions = new Set<SessionManager>();
let shuttingDown = false;

async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  const terminations = [...liveSessions].map((s) => s.terminate().catch(() => {}));
  // A wedged adapter must not hold shutdown open indefinitely; the 'exit'
  // handler below kills whatever is left.
  await Promise.race([Promise.all(terminations), new Promise((resolve) => setTimeout(resolve, 3000).unref())]);
  process.exit(code);
}

process.on('SIGINT', () => {
  void shutdown(0);
});
process.on('SIGTERM', () => {
  void shutdown(0);
});

// Last resort, synchronous: nothing async runs during 'exit'. After a clean
// terminate() the adapter pid is already gone, so this only fires for the
// stragglers.
process.on('exit', () => {
  for (const session of liveSessions) {
    const pid = session.status.adapterPid;
    if (pid === undefined) continue;
    try {
      process.kill(pid);
    } catch {
      /* already gone */
    }
  }
});

// --- Start transport ---
async function main() {
  if (transportType === 'http') {
    await startHttpTransport();
  } else {
    await startStdioTransport();
  }
}

// --- Stdio transport (single session) ---
async function startStdioTransport() {
  const { mcpServer, session } = createMcpStack();
  liveSessions.add(session);

  process.on('beforeExit', async () => {
    try {
      await session.terminate();
    } catch {
      /* already terminated */
    }
    liveSessions.delete(session);
    await mcpServer.close();
  });

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}

// --- Streamable HTTP transport (multi-session) ---
async function startHttpTransport() {
  // Map of session ID -> { transport, mcpServer, session }
  const sessions = new Map<
    string,
    {
      transport: StreamableHTTPServerTransport;
      mcpServer: McpServer;
      session: SessionManager;
    }
  >();

  /**
   * Parse JSON body from an IncomingMessage.
   * Returns the parsed body, or undefined on failure.
   */
  function parseJsonBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(undefined);
        }
      });
      req.on('error', () => resolve(undefined));
    });
  }

  async function handlePost(req: IncomingMessage, res: ServerResponse) {
    const body = await parseJsonBody(req);
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && sessions.has(sessionId)) {
      // Existing session — forward to its transport
      const entry = sessions.get(sessionId)!;
      await entry.transport.handleRequest(req, res, body);
      return;
    }

    if (!sessionId && isInitializeRequest(body)) {
      // New initialization request — create a fresh session
      const { mcpServer, session } = createMcpStack();
      liveSessions.add(session);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (sid) => {
          console.error(`[http] Session initialized: ${sid}`);
          sessions.set(sid, { transport, mcpServer, session });
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && sessions.has(sid)) {
          console.error(`[http] Session closed: ${sid}`);
          sessions.delete(sid);
          session
            .terminate()
            .catch(() => {})
            .finally(() => liveSessions.delete(session));
        }
      };

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    // Invalid — no session and not an initialize request
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
        id: null,
      }),
    );
  }

  async function handleGet(req: IncomingMessage, res: ServerResponse) {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid or missing session ID');
      return;
    }
    await sessions.get(sessionId)!.transport.handleRequest(req, res);
  }

  async function handleDelete(req: IncomingMessage, res: ServerResponse) {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid or missing session ID');
      return;
    }
    const entry = sessions.get(sessionId)!;
    await entry.transport.handleRequest(req, res);
  }

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found — MCP endpoint is at /mcp');
      return;
    }

    try {
      switch (req.method) {
        case 'POST':
          await handlePost(req, res);
          break;
        case 'GET':
          await handleGet(req, res);
          break;
        case 'DELETE':
          await handleDelete(req, res);
          break;
        default:
          res.writeHead(405, { 'Content-Type': 'text/plain' });
          res.end('Method Not Allowed');
      }
    } catch (err) {
      console.error('[http] Error handling request:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          }),
        );
      }
    }
  });

  // Cleanup all sessions on server shutdown
  process.on('beforeExit', async () => {
    for (const [sid, entry] of sessions) {
      console.error(`[http] Cleaning up session ${sid}`);
      try {
        await entry.session.terminate();
      } catch {
        /* ignore */
      }
      try {
        await entry.transport.close();
      } catch {
        /* ignore */
      }
    }
    sessions.clear();
  });

  httpServer.listen(httpPort, () => {
    console.error(`MCP Streamable HTTP server listening on http://127.0.0.1:${httpPort}/mcp`);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
