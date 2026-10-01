#!/usr/bin/env node
/**
 * End-to-end smoke test against a real PHP/Xdebug target over stdio MCP.
 *
 * Drives the full agent workflow — launch, set a breakpoint, trigger an HTTP
 * request, wait for the hit, inspect, continue, terminate — and fails loudly
 * if any step does not reach a paused state.
 *
 * Usage:
 *   node scripts/smoke-http.mjs
 *   SMOKE_CONFIG=... SMOKE_TARGET=... SMOKE_LINE=... SMOKE_URL=... node scripts/smoke-http.mjs
 *
 * SMOKE_LINE must name an EXECUTABLE line — a breakpoint on a closing brace or
 * a comment verifies fine and then never hits.
 */
import { spawn, exec } from 'node:child_process';

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
const CONFIG = process.env.SMOKE_CONFIG ?? '/Users/klazur/Projects/drupal-logger-ai/config.php.json';
const TARGET = process.env.SMOKE_TARGET ?? '/Users/klazur/Projects/drupal-logger-ai/web/index.php';
const LINE = Number(process.env.SMOKE_LINE ?? 16);
const URL = process.env.SMOKE_URL ?? 'https://drupal-logger-ai.ddev.site/';

const VERBOSE = process.env.SMOKE_VERBOSE ?? '0';
const child = spawn('node', [SERVER, '--config', CONFIG, '--verbose', VERBOSE], { stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', (d) => process.stderr.write('[server stderr] ' + d));

let buf = '';
const pending = new Map();
child.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.method && VERBOSE !== '0') {
      console.log('  [notif]', JSON.stringify(msg.params?.data ?? msg.params).slice(0, 400));
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

let nextId = 1;
function rpc(method, params, timeout = 60000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${method}`)), timeout);
    pending.set(id, (m) => {
      clearTimeout(t);
      resolve(m);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}
async function call(name, args) {
  const r = await rpc('tools/call', { name, arguments: args });
  const text = r.result?.content?.[0]?.text ?? JSON.stringify(r.error ?? r.result);
  return text;
}

/** Call a tool and fail the run if it did not succeed. */
async function callOk(name, args) {
  const text = await call(name, args);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${name}: unparseable result ${text}`);
  }
  if (parsed.success !== true) throw new Error(`${name} failed: ${text}`);
  return text;
}

const step = (n, s) => console.log(`\n=== ${n} ${s} ===`);

try {
  step(1, 'initialize');
  const init = await rpc(
    'initialize',
    {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'smoke', version: '0' },
    },
    15000,
  );
  console.log('serverInfo:', JSON.stringify(init.result.serverInfo));
  notify('notifications/initialized', {});

  step(2, 'tools/list');
  const tools = await rpc('tools/list', {}, 15000);
  const names = tools.result.tools.map((t) => t.name);
  console.log(`${names.length} tools:`, names.join(', '));

  step(3, 'debug_launch');
  console.log(await callOk('debug_launch', {}));

  step(4, 'debug_set_breakpoints');
  console.log(await callOk('debug_set_breakpoints', { path: TARGET, breakpoints: [{ line: LINE }] }));

  step(5, 'trigger HTTP request');
  exec(`curl -sk -o /dev/null -m 60 ${URL}`, () => {});

  step(6, 'debug_wait (loop until paused)');
  let paused = false;
  for (let i = 0; i < 6 && !paused; i++) {
    const w = await call('debug_wait', { timeout: 20000 });
    console.log(`  wait[${i}]:`, w.slice(0, 400));
    const parsed = JSON.parse(w);
    paused = parsed.data?.status?.state === 'paused' || parsed.data?.reason === 'already_paused';
    if (parsed.data?.reason === 'timeout' && parsed.data?.status?.state === 'listening') break;
  }
  if (!paused) throw new Error('never reached paused state');

  step(7, 'debug_stack_trace');
  const st = await callOk('debug_stack_trace', { threadId: 1 });
  console.log(st.slice(0, 1200));

  step(8, 'debug_evaluate (no frameId -> top frame)');
  console.log(await callOk('debug_evaluate', { expression: 'PHP_VERSION' }));

  step('8b', 'debug_variables (Locals scope)');
  const scopes = await callOk('debug_scopes', { frameId: 1 });
  console.log('  scopes:', scopes.slice(0, 400));
  const scopeRef = JSON.parse(scopes).data?.scopes?.[0]?.variablesReference;
  if (scopeRef) console.log('  vars:', (await call('debug_variables', { variablesReference: scopeRef })).slice(0, 400));

  step(9, 'debug_continue');
  console.log(await callOk('debug_continue', { threadId: 1 }));

  step(10, 'debug_terminate');
  console.log(await callOk('debug_terminate', {}));

  console.log('\nSMOKE TEST OK');
} catch (e) {
  console.error('\nSMOKE TEST FAILED:', e.message);
  process.exitCode = 1;
} finally {
  child.kill('SIGTERM');
}
