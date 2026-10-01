import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JournalEntry } from './invoker.js';
import { normalizeReport, type PlanRunReport } from './report.js';

export interface StoredRun {
  report: PlanRunReport;
  journal: JournalEntry[];
  /** Directory the artifacts were written to, when the store has one. */
  dir?: string;
}

/**
 * Keeps finished plan runs so an agent can drill into one after the compact
 * summary `debug_plan_run` returned — and, with a directory, writes each run's
 * artifacts to disk where a person or a later re-run can diff them.
 *
 * Memory holds the most recent `maxInMemory` runs; older ones are read back
 * from disk on demand.
 */
export class RunStore {
  private readonly runs = new Map<string, StoredRun>();

  constructor(
    private readonly dir?: string,
    private readonly maxInMemory = 20,
  ) {}

  save(report: PlanRunReport, journal: JournalEntry[]): StoredRun {
    const stored: StoredRun = { report, journal };
    if (this.dir) {
      const runDir = join(this.dir, safeName(report.runId));
      try {
        mkdirSync(runDir, { recursive: true });
        writeFileSync(join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
        writeFileSync(join(runDir, 'report.normalized.json'), `${JSON.stringify(normalizeReport(report), null, 2)}\n`);
        writeFileSync(join(runDir, 'journal.jsonl'), journal.map((e) => JSON.stringify(e)).join('\n') + '\n');
        stored.dir = runDir;
      } catch {
        // Artifacts are a convenience; the run itself already happened.
      }
    }
    this.runs.delete(report.runId);
    this.runs.set(report.runId, stored);
    while (this.runs.size > this.maxInMemory) {
      const oldest = this.runs.keys().next().value;
      if (oldest === undefined) break;
      this.runs.delete(oldest);
    }
    return stored;
  }

  /** A run by id, or the most recent one. */
  get(runId?: string): StoredRun | undefined {
    if (runId === undefined) return [...this.runs.values()].at(-1);
    const inMemory = this.runs.get(runId);
    if (inMemory) return inMemory;
    if (!this.dir) return undefined;
    const runDir = join(this.dir, safeName(runId));
    try {
      const report = JSON.parse(readFileSync(join(runDir, 'report.json'), 'utf-8')) as PlanRunReport;
      const journalPath = join(runDir, 'journal.jsonl');
      const journal = existsSync(journalPath)
        ? readFileSync(journalPath, 'utf-8')
            .split('\n')
            .filter((l) => l.trim() !== '')
            .map((l) => JSON.parse(l) as JournalEntry)
        : [];
      return { report, journal, dir: runDir };
    } catch {
      return undefined;
    }
  }

  /** Known run ids, newest last. */
  list(): string[] {
    const ids = new Set<string>();
    if (this.dir && existsSync(this.dir)) {
      for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(join(this.dir, entry.name, 'report.json'))) ids.add(entry.name);
      }
    }
    for (const id of this.runs.keys()) ids.add(id);
    return [...ids].sort();
  }
}

/** Run ids are generated, but a stored id is also a path segment: keep it one. */
function safeName(runId: string): string {
  return runId.replace(/[^A-Za-z0-9._-]/g, '_');
}
