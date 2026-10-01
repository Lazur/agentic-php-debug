#!/usr/bin/env node
/**
 * php-debug-plan — run a debug plan with no agent involved.
 *
 *   php-debug-plan schema
 *   php-debug-plan validate <plan.json> [--json]
 *   php-debug-plan run <plan.json> [--config <cfg.json>] [--via in-process|mcp-stdio|mcp-http=<url>]
 *                                   [--out <dir>] [--golden <file> [--update-golden]] [--json] [--verbose]
 *
 * Exit codes: 0 pass · 1 expectation or golden mismatch · 2 invalid plan or usage · 3 run failed.
 *
 * `--via mcp-stdio` spawns this package's MCP server and drives it tool by tool,
 * so a plan doubles as an end-to-end test of the server. The default,
 * `in-process`, calls the same handlers directly.
 */
import { parseArgs } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigSchema, loadConfig, type Config } from '../config.js';
import { DAPClient } from '../dap-client.js';
import { PathMapper } from '../path-mapper.js';
import { SessionManager, type NotificationSender } from '../session.js';
import { InProcessInvoker, JournalingInvoker, type JournalEntry, type ToolInvoker } from './invoker.js';
import { loadPlanFile, planBaseDir, validatePlan, type ValidationResult } from './validate.js';
import { planJsonSchema } from './schema.js';
import { runPlan } from './runner.js';
import {
  compareToGolden,
  normalizeReport,
  summarizeReport,
  type GoldenComparison,
  type PlanRunReport,
} from './report.js';

const EXIT = { ok: 0, mismatch: 1, invalid: 2, failed: 3 } as const;

const USAGE = `Usage:
  php-debug-plan schema
  php-debug-plan validate <plan.json> [--json]
  php-debug-plan run <plan.json> [--config <cfg.json>] [--via in-process|mcp-stdio|mcp-http=<url>]
                                 [--out <dir>] [--golden <file> [--update-golden]] [--json] [--verbose]`;

class ConsoleNotifier implements NotificationSender {
  constructor(private readonly verbose: boolean) {}
  async sendProgress(): Promise<void> {}
  async sendLog(level: string, message: string): Promise<void> {
    if (this.verbose || level === 'error' || level === 'warning') process.stderr.write(`[${level}] ${message}\n`);
  }
  async sendDebugEvent(event: string, details: Record<string, unknown>): Promise<void> {
    if (this.verbose) process.stderr.write(`[event:${event}] ${JSON.stringify(details)}\n`);
  }
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c' },
      via: { type: 'string', default: 'in-process' },
      out: { type: 'string', short: 'o' },
      golden: { type: 'string', short: 'g' },
      'update-golden': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      verbose: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, planArg] = positionals;

  if (values.help || !command) {
    process.stdout.write(`${USAGE}\n`);
    return values.help ? EXIT.ok : EXIT.invalid;
  }

  if (command === 'schema') {
    process.stdout.write(`${JSON.stringify(planJsonSchema(), null, 2)}\n`);
    return EXIT.ok;
  }

  if (command !== 'validate' && command !== 'run') {
    process.stderr.write(`Unknown command "${command}".\n${USAGE}\n`);
    return EXIT.invalid;
  }
  if (!planArg) {
    process.stderr.write(`Missing <plan.json>.\n${USAGE}\n`);
    return EXIT.invalid;
  }

  const planPath = resolve(planArg);
  let input: unknown;
  try {
    input = loadPlanFile(planPath);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return EXIT.invalid;
  }

  if (command === 'validate') {
    const result = validatePlan(input, { baseDir: planBaseDir(planPath) });
    if (values.json) {
      process.stdout.write(
        `${JSON.stringify({ ok: result.ok, planHash: result.planHash, errors: result.errors, warnings: result.warnings }, null, 2)}\n`,
      );
    } else {
      printValidation(result);
    }
    return result.ok ? EXIT.ok : EXIT.invalid;
  }

  return run(planPath, input, values);
}

interface RunFlags {
  config?: string;
  via?: string;
  out?: string;
  golden?: string;
  'update-golden'?: boolean;
  json?: boolean;
  verbose?: boolean;
}

async function run(planPath: string, input: unknown, flags: RunFlags): Promise<number> {
  const via = flags.via ?? 'in-process';
  // A server spawned by --via mcp-stdio is given this run's config, plan
  // overrides included, so per-run session fields do take effect there. Only
  // an already-running server (mcp-http) has fixed them at startup.
  const surface = via.startsWith('mcp-http=') ? 'mcp' : 'in-process';

  // Validate against the surface's actual tool list, once it is connected.
  const precheck = validatePlan(input, { baseDir: planBaseDir(planPath), surface });
  if (!precheck.ok || !precheck.plan) {
    printValidation(precheck);
    return EXIT.invalid;
  }
  const plan = precheck.plan;

  let baseConfig: Config;
  try {
    baseConfig = flags.config ? loadConfig(flags.config) : ConfigSchema.parse({});
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return EXIT.invalid;
  }
  if (baseConfig.program !== undefined || baseConfig.runtimeArgs !== undefined) {
    process.stderr.write(
      'The config sets "program"/"runtimeArgs", which makes the adapter start PHP during launch — before any ' +
        'breakpoint is armed. Plans need listen mode: remove them and run the script from the plan trigger.\n',
    );
    return EXIT.invalid;
  }
  const config: Config = {
    ...baseConfig,
    ...(plan.session.hostname !== undefined ? { hostname: plan.session.hostname } : {}),
    ...(plan.session.pathMappings !== undefined ? { pathMappings: plan.session.pathMappings } : {}),
  };

  const connection = await connect(via, config, flags.verbose ?? false);
  if ('error' in connection) {
    process.stderr.write(`${connection.error}\n`);
    return EXIT.failed;
  }

  const abort = new AbortController();
  const onSignal = () => {
    process.stderr.write('\nCancelling — tearing the session down…\n');
    abort.abort();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  let report: PlanRunReport;
  let journal: JournalEntry[];
  try {
    const available = await connection.invoker.tools();
    const checked = validatePlan(input, { baseDir: planBaseDir(planPath), surface, availableTools: available });
    if (!checked.ok) {
      printValidation(checked);
      return EXIT.invalid;
    }
    const journaling = new JournalingInvoker(connection.invoker);
    report = await runPlan(plan, {
      invoker: journaling,
      signal: abort.signal,
      warnings: checked.warnings,
      adapterVersion: adapterVersion(config.adapterPath),
      backend: 'headless',
      onProgress: (p) => {
        if (!flags.json) process.stderr.write(`[${p.phase}] ${p.message}\n`);
      },
    });
    journal = journaling.entries;
  } finally {
    await connection.close();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }

  const normalized = normalizeReport(report);
  const outDir = resolve(flags.out ?? join(process.cwd(), '.php-debug-plan', 'runs', report.runId));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(outDir, 'report.normalized.json'), `${JSON.stringify(normalized, null, 2)}\n`);
  writeFileSync(join(outDir, 'journal.jsonl'), journal.map((e) => JSON.stringify(e)).join('\n') + '\n');

  let golden: GoldenComparison | undefined;
  if (flags.golden) {
    const goldenPath = resolve(flags.golden);
    if (flags['update-golden'] || !existsSync(goldenPath)) {
      mkdirSync(dirname(goldenPath), { recursive: true });
      writeFileSync(goldenPath, `${JSON.stringify(normalized, null, 2)}\n`);
      if (!flags.json) process.stderr.write(`Golden written: ${goldenPath}\n`);
    } else {
      golden = compareToGolden(normalized, JSON.parse(readFileSync(goldenPath, 'utf-8')));
    }
  }

  const expectationsOk = report.expectations.every((r) => r.pass);
  const outcomeAsserted = report.expectations.some((r) => 'outcome' in r.expect && r.pass);
  const outcomeOk = report.outcome === 'completed' || outcomeAsserted;
  const goldenOk = golden === undefined || golden.equal;

  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify({ ...summarizeReport(report), artifacts: outDir, ...(golden ? { golden } : {}) }, null, 2)}\n`,
    );
  } else {
    printReport(report, outDir, golden);
  }

  if (report.outcome === 'failed' && !outcomeAsserted) return EXIT.failed;
  return expectationsOk && outcomeOk && goldenOk ? EXIT.ok : EXIT.mismatch;
}

interface Connection {
  invoker: ToolInvoker;
  close(): Promise<void>;
}

/** Build the tool surface a run executes against. */
async function connect(via: string, config: Config, verbose: boolean): Promise<Connection | { error: string }> {
  if (via === 'in-process') {
    const backend = new DAPClient(config.adapterPath);
    if (verbose) backend.onStderr = (text) => process.stderr.write(`[adapter] ${text}`);
    const pathMapper = new PathMapper(
      Object.entries(config.pathMappings).map(([remote, local]) => ({ remote, local })),
    );
    const session = new SessionManager(config, backend, pathMapper, new ConsoleNotifier(verbose));
    return {
      invoker: new InProcessInvoker(session),
      close: async () => {
        await session.terminate().catch(() => {});
      },
    };
  }

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { McpClientInvoker } = await import('./mcp-invoker.js');
  const client = new Client({ name: 'php-debug-plan', version: '0.1.0' });

  try {
    if (via === 'mcp-stdio') {
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
      // The server reads its own config; hand it this run's, plan overrides included.
      const dir = mkdtempSync(join(tmpdir(), 'php-debug-plan-'));
      const configPath = join(dir, 'config.json');
      writeFileSync(configPath, JSON.stringify(config));
      const serverPath = fileURLToPath(new URL('../index.js', import.meta.url));
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [serverPath, '--config', configPath, ...(verbose ? ['--verbose', '1'] : [])],
        stderr: verbose ? 'inherit' : 'ignore',
      });
      await client.connect(transport);
    } else if (via.startsWith('mcp-http=')) {
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
      await client.connect(new StreamableHTTPClientTransport(new URL(via.slice('mcp-http='.length))));
    } else {
      return { error: `Unknown --via "${via}". Use in-process, mcp-stdio or mcp-http=<url>.` };
    }
  } catch (err) {
    return {
      error: `Could not connect to the MCP server (${via}): ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    invoker: new McpClientInvoker(client),
    close: () => client.close(),
  };
}

function adapterVersion(adapterPath: string): string | undefined {
  try {
    return readFileSync(join(dirname(adapterPath), 'VERSION'), 'utf-8').trim();
  } catch {
    return undefined;
  }
}

function printValidation(result: ValidationResult): void {
  for (const e of result.errors) process.stderr.write(`error   ${e.path || '(plan)'}: ${e.message}\n`);
  for (const w of result.warnings) process.stderr.write(`warning ${w.path || '(plan)'}: ${w.message}\n`);
  process.stderr.write(result.ok ? `Plan is valid (${result.planHash?.slice(0, 12)}).\n` : 'Plan is invalid.\n');
}

function printReport(report: PlanRunReport, outDir: string, golden?: GoldenComparison): void {
  const out: string[] = [];
  out.push(`\n${report.plan.name}: ${report.outcome}${report.outcomeDetail ? ` — ${report.outcomeDetail}` : ''}`);
  for (const [id, p] of Object.entries(report.probes)) {
    out.push(`  probe ${id} (${p.kind}): ${p.hits} hit(s), ${p.captured} captured`);
  }
  if (report.unmatchedStops > 0) out.push(`  unmatched stops: ${report.unmatchedStops}`);
  for (const s of report.stops.slice(0, 20)) {
    const where = s.location ? `${s.location.file ?? '?'}:${s.location.line ?? '?'}` : '?';
    out.push(`  #${s.seq} ${s.probe ?? s.kind}${s.hit ? ` hit ${s.hit}` : ''} at ${where}`);
    for (const [expr, v] of Object.entries(s.evaluate ?? {})) {
      out.push(
        `      ${expr} = ${v.error ? `!${v.error.code}` : v.redacted ? '[redacted]' : `${v.value}${v.type ? ` (${v.type})` : ''}`}`,
      );
    }
  }
  if (report.stops.length > 20) out.push(`  … ${report.stops.length - 20} more stop(s) in report.json`);
  for (const r of report.expectations) {
    out.push(`  ${r.pass ? '✓' : '✗'} ${JSON.stringify(r.expect)}${r.message ? ` — ${r.message}` : ''}`);
  }
  for (const p of report.predictions) out.push(`  hypothesis ${p.hypothesis}: ${p.verdict}`);
  if (report.trigger) {
    const t = report.trigger;
    out.push(
      `  trigger: ${t.kind}${t.exitCode !== undefined ? ` exit ${t.exitCode}` : ''}${t.status !== undefined ? ` HTTP ${t.status}` : ''}${t.error ? ` (${t.error})` : ''}`,
    );
  }
  for (const e of report.errors) out.push(`  error [${e.phase}${e.tool ? ` ${e.tool}` : ''}] ${e.code}: ${e.message}`);
  if (golden) {
    out.push(
      golden.equal
        ? '  golden: match'
        : `  golden: ${golden.diffs.length} difference(s)${golden.planChanged ? ' (the plan changed since the golden was recorded)' : ''}`,
    );
    for (const d of golden.diffs.slice(0, 20)) out.push(`    ${d}`);
  }
  out.push(`  artifacts: ${outDir}`);
  process.stdout.write(`${out.join('\n')}\n`);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`php-debug-plan: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = EXIT.failed;
  },
);
