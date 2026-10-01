import { describe, it, expect } from 'vitest';
import { FakePhp, type FakeStop } from './helpers/fake-php.js';
import { handleDebugSnapshot, diffSnapshots, type Snapshot } from '../tools/debug-snapshot.js';
import { handleDebugWait } from '../tools/debug-wait.js';
import { handleDebugNext } from '../tools/debug-next.js';
import { handleDebugSetBreakpoints } from '../tools/debug-set-breakpoints.js';
import { SessionState, type SessionManager } from '../session.js';

const FILE = '/app/src/Cart.php';

function stop(line: number, extra: Partial<FakeStop> = {}): FakeStop {
  return { file: FILE, line, function: 'App\\Cart->total', ...extra };
}

/** Launch against the fake, arm a breakpoint, and play one connection through `stops`. */
async function pausedSession(stops: FakeStop[]): Promise<{ session: SessionManager; fake: FakePhp }> {
  const fake = new FakePhp();
  const session = fake.session();
  await session.launch();
  await handleDebugSetBreakpoints(session, { path: FILE, breakpoints: [{ line: stops[0].line }] });
  fake.trigger([{ stops }])({ kind: 'manual' });
  // The connection's `thread` event arrives before the stop.
  for (let i = 0; i < 5 && session.state !== SessionState.Paused; i++) {
    await handleDebugWait(session, { timeout: 1000 });
  }
  expect(session.state).toBe(SessionState.Paused);
  return { session, fake };
}

describe('debug_snapshot', () => {
  it('observes location, frames, watches and locals in one call', async () => {
    const { session } = await pausedSession([
      stop(10, {
        callers: [{ file: '/app/index.php', line: 3, function: '{main}' }],
        evaluate: { '$this->total': { result: '0', type: 'int' } },
        locals: [
          { name: '$qty', value: '3', type: 'int' },
          { name: '$apiToken', value: "'s3cr3t'", type: 'string' },
        ],
      }),
    ]);
    const r = await handleDebugSnapshot(session, { watch: ['$this->total'] });
    expect(r.success).toBe(true);
    const d = r.data as Snapshot & { delta: unknown; watchList: string[] };
    expect(d.location).toEqual({ file: FILE, line: 10, function: 'App\\Cart->total' });
    expect(d.frames.map((f) => f.line)).toEqual([10, 3]);
    expect(d.totalFrames).toBe(2);
    expect(d.watches?.['$this->total']).toMatchObject({ value: '0', type: 'int' });
    expect(d.locals?.['$qty'].value).toBe('3');
    expect(d.locals?.['$apiToken'].value).toBe('[redacted]');
    expect(d.delta).toEqual({ first: true });
    expect(d.watchList).toEqual(['$this->total']);
  });

  it('rejects when nothing is paused', async () => {
    const fake = new FakePhp();
    const session = fake.session();
    await session.launch();
    const r = await handleDebugSnapshot(session, {});
    expect(r.success).toBe(false);
    expect(r.error?.code).toBe('SESSION_NOT_PAUSED');
  });

  it('attaches to debug_wait and reports how the frame evolved after a step', async () => {
    const { session } = await pausedSession([
      stop(10, {
        evaluate: { '$total': { result: '0', type: 'int' } },
        locals: [
          { name: '$i', value: '0', type: 'int' },
          { name: '$gone', value: 'true', type: 'bool' },
        ],
      }),
      stop(11, {
        evaluate: { '$total': { result: '1.115', type: 'float' } },
        locals: [
          { name: '$i', value: '1', type: 'int' },
          { name: '$new', value: "'x'", type: 'string' },
        ],
      }),
    ]);

    // The first stop was already consumed by pausedSession; observe it with a watch.
    const first = await handleDebugWait(session, { snapshot: { watch: ['$total'] } });
    expect((first.data as { reason: string }).reason).toBe('already_paused');
    expect((first.data as { snapshot: { delta: unknown } }).snapshot.delta).toEqual({ first: true });

    await handleDebugNext(session, {});
    const second = await handleDebugWait(session, { timeout: 1000, snapshot: true });
    const snap = (second.data as { snapshot: Snapshot & { delta: Record<string, unknown> } }).snapshot;
    expect(snap.location?.line).toBe(11);
    expect(snap.delta).toEqual({
      moved: { from: `App\\Cart->total @ ${FILE}:10`, to: `App\\Cart->total @ ${FILE}:11` },
      changed: [{ name: '$i', from: '0', to: '1' }],
      added: ["$new = 'x'"],
      removed: ['$gone'],
      watchChanged: [{ expr: '$total', from: '0', to: '1.115' }],
    });
  });
});

describe('diffSnapshots', () => {
  const base: Snapshot = {
    threadId: 1,
    suspensionId: 1,
    location: { file: FILE, line: 10, function: 'App\\Cart->total' },
    frames: [],
    totalFrames: 2,
    locals: { $i: { value: '0' } },
  };

  it('does not diff locals across a step into another function', () => {
    const next: Snapshot = {
      ...base,
      suspensionId: 2,
      location: { file: FILE, line: 30, function: 'App\\Cart->lineTotal' },
      totalFrames: 3,
      locals: { $price: { value: '1.115' } },
    };
    expect(diffSnapshots(base, next)).toEqual({
      moved: { from: `App\\Cart->total @ ${FILE}:10`, to: `App\\Cart->lineTotal @ ${FILE}:30` },
      depth: { from: 2, to: 3 },
      frameChanged: { from: 'App\\Cart->total', to: 'App\\Cart->lineTotal' },
    });
  });

  it('says so when the same stop is observed twice', () => {
    expect(diffSnapshots(base, { ...base })).toEqual({ sameStop: true });
  });
});
