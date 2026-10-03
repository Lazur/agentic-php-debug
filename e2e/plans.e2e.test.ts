/**
 * Every plan in e2e/plans runs against real PHP + Xdebug twice — in-process and
 * through the MCP server over stdio — and both normalized reports must equal
 * the plan's golden file. The second run is what tests the MCP layer itself:
 * transport, argument validation, tool registration and serialization all sit
 * between the runner and the handlers there, and none of it may change what
 * the run observes.
 *
 * Needs `npm run build`, and either a host PHP with Xdebug or Docker with the
 * image e2e/php.sh uses (E2E_PHP_IMAGE, default ddev/ddev-webserver:v1.25.4).
 * Re-record goldens with UPDATE_GOLDEN=1 after an intended behaviour change.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'dist', 'plan', 'cli.js');
const plansDir = join(root, 'e2e', 'plans');

function phpWithXdebug(): string | undefined {
  const host = spawnSync('php', ['-m'], { encoding: 'utf-8' });
  if (host.status === 0 && /^xdebug$/im.test(host.stdout)) return 'host php';
  const image = process.env.E2E_PHP_IMAGE ?? 'ddev/ddev-webserver:v1.25.4';
  const docker = spawnSync('docker', ['image', 'inspect', image], { encoding: 'utf-8' });
  return docker.status === 0 ? `docker ${image}` : undefined;
}

const php = phpWithXdebug();
const plans = readdirSync(plansDir).filter((f) => f.endsWith('.debugplan.json'));

describe.skipIf(!php)(`plans against real Xdebug (${php ?? 'unavailable'})`, () => {
  it('has a build to run', () => {
    expect(existsSync(cli), 'run `npm run build` first').toBe(true);
  });

  for (const file of plans) {
    const name = basename(file, '.debugplan.json');
    const golden = join(root, 'e2e', 'golden', `${name}.golden.json`);

    for (const via of ['in-process', 'mcp-stdio']) {
      it(`${name} via ${via} matches its golden`, () => {
        const out = mkdtempSync(join(tmpdir(), `e2e-${name}-`));
        const update = process.env.UPDATE_GOLDEN === '1' && via === 'in-process';
        const args = [cli, 'run', join(plansDir, file), '--via', via, '--golden', golden, '--json', '--out', out];
        if (update) args.push('--update-golden');

        let stdout: string;
        let status = 0;
        try {
          stdout = execFileSync(process.execPath, args, {
            cwd: root,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch (err) {
          const e = err as { status: number; stdout: string };
          status = e.status;
          stdout = e.stdout;
        }
        const summary = JSON.parse(stdout) as {
          outcome: string;
          expectations: { failed: number; failures?: unknown[] };
          golden?: { equal: boolean; diffs: string[] };
        };
        expect(summary.outcome).toBe('completed');
        expect(summary.expectations.failures ?? []).toEqual([]);
        if (!update) expect(summary.golden?.diffs ?? ['no golden recorded']).toEqual([]);
        expect(status).toBe(0);
      });
    }
  }
});

describe.skipIf(!php)('plan mode as an agent sees it', () => {
  it('exposes only the plan tools, runs a plan server-side, and reports the same run as the golden', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-plan-mode-'));
    const config = join(dir, 'config.json');
    writeFileSync(config, JSON.stringify({}));

    const client = new Client({ name: 'e2e', version: '0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          join(root, 'dist', 'index.js'),
          '--config',
          config,
          '--mode',
          'plan',
          '--allow-command-trigger',
          '--runs-dir',
          join(dir, 'runs'),
        ],
        cwd: root,
        stderr: 'ignore',
      }),
    );
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        'debug_plan_report',
        'debug_plan_run',
        'debug_plan_validate',
        'debug_status',
      ]);

      const { prompts } = await client.listPrompts();
      expect(prompts.map((p) => p.name)).toEqual(['debug_plan']);
      const prompt = await client.getPrompt({
        name: 'debug_plan',
        arguments: { problem: 'cart total is off by a cent' },
      });
      expect(JSON.stringify(prompt.messages)).toContain('cart total is off by a cent');

      const schema = await client.readResource({ uri: 'php-debug://schemas/debug-plan.v1.json' });
      expect(JSON.parse((schema.contents[0] as { text: string }).text).properties.probes).toBeDefined();

      const run = await client.callTool(
        { name: 'debug_plan_run', arguments: { path: 'e2e/plans/cart-rounding.debugplan.json' } },
        undefined,
        { timeout: 120_000 },
      );
      const summary = JSON.parse((run.content as Array<{ text: string }>)[0].text).data;
      expect(summary.outcome).toBe('completed');
      expect(summary.predictions.map((p: { verdict: string }) => p.verdict)).toEqual(['refuted', 'supported']);

      const normalized = await client.callTool({
        name: 'debug_plan_report',
        arguments: { runId: summary.runId, section: 'normalized' },
      });
      const report = JSON.parse((normalized.content as Array<{ text: string }>)[0].text).data.normalized;
      expect(report).toEqual(
        JSON.parse(readFileSync(join(root, 'e2e', 'golden', 'cart-rounding.golden.json'), 'utf-8')),
      );
    } finally {
      await client.close();
    }
  });
});

describe.skipIf(!php)('react mode as an agent sees it', () => {
  it('observes a real step through debug_wait {snapshot}', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-react-'));
    const config = join(dir, 'config.json');
    writeFileSync(config, JSON.stringify({ port: 9013 }));
    const client = new Client({ name: 'e2e', version: '0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(root, 'dist', 'index.js'), '--config', config],
        cwd: root,
        stderr: 'ignore',
      }),
    );
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
      return JSON.parse((r.content as Array<{ text: string }>)[0].text) as {
        success: boolean;
        data: any;
        error?: unknown;
      };
    };
    let php: ReturnType<typeof spawn> | undefined;
    try {
      expect((await call('debug_launch', { port: 9013 })).success).toBe(true);
      const file = join(root, 'e2e', 'fixtures', 'cart.php');
      expect((await call('debug_set_breakpoints', { path: file, breakpoints: [{ line: 24 }] })).success).toBe(true);

      // Launch first, then PHP: the connection arrives after the breakpoint is armed.
      // Started earlier, a fast PHP finds nothing listening and runs undebugged.
      php = spawn('sh', ['e2e/php.sh', 'e2e/fixtures/cart.php'], {
        cwd: root,
        env: {
          ...process.env,
          XDEBUG_MODE: 'debug',
          XDEBUG_TRIGGER: '1',
          XDEBUG_CONFIG: 'client_host=127.0.0.1 client_port=9013',
        },
        stdio: 'ignore',
      });
      let first: any;
      for (let i = 0; i < 5; i++) {
        first = (await call('debug_wait', { timeout: 30_000, snapshot: { watch: ['$raw'], locals: { depth: 0 } } }))
          .data;
        if (first.status.state === 'paused') break;
      }
      expect(first.status.state, JSON.stringify(first)).toBe('paused');
      expect(first.snapshot.location).toMatchObject({ file, line: 24, function: 'Cart->lineTotal' });
      expect(first.snapshot.locals.$price.value).toBe('1.115');
      expect(first.snapshot.delta).toEqual({ first: true });

      expect((await call('debug_next')).success).toBe(true);
      const second = (await call('debug_wait', { timeout: 30_000, snapshot: true })).data;
      expect(second.snapshot.location.line).toBe(25);
      expect(second.snapshot.delta.moved.to).toContain(':25');
      expect(second.snapshot.delta.watchChanged).toEqual([
        expect.objectContaining({ expr: '$raw', to: '3.3449999999999998' }),
      ]);

      expect((await call('debug_terminate')).success).toBe(true);
    } finally {
      php?.kill();
      await client.close();
    }
  });
});
