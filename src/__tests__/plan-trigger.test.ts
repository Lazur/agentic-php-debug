import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { startTrigger } from '../plan/trigger.js';

const node = process.execPath;

describe('command trigger', () => {
  it('records the exit code and output tails', async () => {
    const h = startTrigger(
      {
        kind: 'command',
        argv: [node, '-e', 'console.log("hello"); console.error("oops"); process.exit(3)'],
        cwd: tmpdir(),
        env: {},
        xdebugEnv: false,
      },
      { port: 9003 },
    );
    const r = await h.done;
    expect(r).toMatchObject({
      kind: 'command',
      settled: true,
      exitCode: 3,
      stdoutTail: 'hello\n',
      stderrTail: 'oops\n',
    });
    expect(h.isSettled()).toBe(true);
  });

  it('points a local PHP process at this session through XDEBUG_* variables', async () => {
    const h = startTrigger(
      {
        kind: 'command',
        argv: [
          node,
          '-e',
          'console.log([process.env.XDEBUG_MODE, process.env.XDEBUG_TRIGGER, process.env.XDEBUG_CONFIG, process.env.EXTRA].join("|"))',
        ],
        cwd: tmpdir(),
        env: { EXTRA: 'x' },
        xdebugEnv: true,
      },
      { port: 9123, hostname: '0.0.0.0' },
    );
    const r = await h.done;
    expect(r.stdoutTail?.trim()).toBe('debug|1|client_host=127.0.0.1 client_port=9123|x');
  });

  it('reports a program that cannot start instead of throwing', async () => {
    const r = await startTrigger(
      { kind: 'command', argv: ['/definitely/not/a/program'], cwd: tmpdir(), env: {}, xdebugEnv: false },
      { port: 9003 },
    ).done;
    expect(r.error).toContain('Could not start /definitely/not/a/program');
  });

  it('can be cancelled', async () => {
    const h = startTrigger(
      { kind: 'command', argv: [node, '-e', 'setTimeout(() => {}, 60000)'], cwd: tmpdir(), env: {}, xdebugEnv: false },
      { port: 9003 },
    );
    expect(h.isSettled()).toBe(false);
    h.cancel();
    const r = await h.done;
    expect(r.signal ?? r.error).toBeTruthy();
  });
});

describe('http trigger', () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  it('sends the Xdebug cookie and records the status', async () => {
    let cookie: string | undefined;
    server = createServer((req, res) => {
      cookie = req.headers.cookie;
      res.statusCode = 500;
      res.end('boom');
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const r = await startTrigger(
      {
        kind: 'http',
        url: `http://127.0.0.1:${port}/cart`,
        method: 'POST',
        headers: { Cookie: 'a=1' },
        body: '{}',
        xdebugCookie: true,
      },
      { port: 9003 },
    ).done;
    expect(r).toMatchObject({ kind: 'http', status: 500, bodyTail: 'boom' });
    expect(cookie).toBe('a=1; XDEBUG_SESSION=plan');
  });

  it('can be cancelled while PHP is paused', async () => {
    server = createServer(() => {
      /* never answers — as when PHP sits at a breakpoint */
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const h = startTrigger(
      { kind: 'http', url: `http://127.0.0.1:${port}/`, method: 'GET', headers: {}, xdebugCookie: false },
      { port: 9003 },
    );
    h.cancel();
    expect((await h.done).error).toBe('cancelled');
    server.closeAllConnections();
  });
});

describe('manual trigger', () => {
  it('shows its instructions and only settles when released', async () => {
    const messages: string[] = [];
    const h = startTrigger(
      { kind: 'manual', instructions: 'Open /cart' },
      { port: 9003, onMessage: (m) => messages.push(m) },
    );
    expect(messages).toEqual(['Open /cart']);
    expect(h.isSettled()).toBe(false);
    h.cancel();
    expect(await h.done).toEqual({ kind: 'manual', settled: true });
  });
});
