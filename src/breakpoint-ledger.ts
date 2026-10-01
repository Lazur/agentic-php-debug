import type { DebugBackend } from './debug-backend.js';
import type { PathMapper } from './path-mapper.js';

// --- Types ---

export type BreakpointSource = 'ide' | 'agent' | 'agent-untagged';

export interface LedgerEntry {
  file: string;
  line: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
  source: BreakpointSource;
  hypothesisId?: number;
  annotation?: string;
  verified?: boolean;
  verificationMessage?: string;
}

export interface IdeBreakpointInput {
  file: string;
  line: number;
  condition?: string;
  annotation?: string;
}

export interface TargetLocation {
  file: string;
  line: number;
  condition?: string;
}

export interface BreakpointContext {
  ideBreakpoints: BreakpointContextEntry[];
  agentBreakpoints: BreakpointContextEntry[];
  untaggedBreakpoints: BreakpointContextEntry[];
}

export interface BreakpointContextEntry {
  file: string;
  line: number;
  condition?: string;
  annotation?: string;
  hypothesisId?: number;
  verified?: boolean;
  verificationMessage?: string;
}

/**
 * Tracks all breakpoints by source (IDE, agent, untagged) and handles
 * merging before sending to DAP. Solves the "DAP replaces all breakpoints
 * per file" problem by maintaining a unified ledger.
 *
 * The full implementation will be completed in the interactive-debug-session
 * spec. This provides the core structure and the methods needed by
 * BreakpointSyncManager in vscode-debug-bridge.
 */
export class BreakpointLedger {
  private entries: Map<string, LedgerEntry[]> = new Map(); // keyed by file path

  constructor(
    private readonly backend: DebugBackend,
    private readonly pathMapper: PathMapper,
  ) {}

  /** Add breakpoints from agent hypothesis. */
  addAgentBreakpoints(hypothesisId: number, locations: TargetLocation[]): void {
    for (const loc of locations) {
      const fileEntries = this.entries.get(loc.file) ?? [];
      fileEntries.push({
        file: loc.file,
        line: loc.line,
        condition: loc.condition,
        source: 'agent',
        hypothesisId,
      });
      this.entries.set(loc.file, fileEntries);
    }
  }

  /** Add breakpoints from IDE (user gutter clicks). */
  addIdeBreakpoints(breakpoints: IdeBreakpointInput[]): void {
    for (const bp of breakpoints) {
      const fileEntries = this.entries.get(bp.file) ?? [];
      // Avoid duplicates at the same line from IDE source
      const existing = fileEntries.findIndex(
        (e) => e.line === bp.line && e.source === 'ide',
      );
      if (existing !== -1) {
        fileEntries[existing] = {
          file: bp.file,
          line: bp.line,
          condition: bp.condition,
          annotation: bp.annotation,
          source: 'ide',
        };
      } else {
        fileEntries.push({
          file: bp.file,
          line: bp.line,
          condition: bp.condition,
          annotation: bp.annotation,
          source: 'ide',
        });
      }
      this.entries.set(bp.file, fileEntries);
    }
  }

  /**
   * Remove a single IDE-originated breakpoint by file and line.
   * Used by BreakpointSyncManager when the user removes a breakpoint
   * from the VS Code gutter.
   *
   * Requirements: 3.3
   */
  removeIdeBreakpoint(file: string, line: number): void {
    const fileEntries = this.entries.get(file);
    if (!fileEntries) return;
    const idx = fileEntries.findIndex(
      (e) => e.line === line && e.source === 'ide',
    );
    if (idx !== -1) {
      fileEntries.splice(idx, 1);
      if (fileEntries.length === 0) {
        this.entries.delete(file);
      }
    }
  }

  /** Remove all breakpoints for a given hypothesis. Returns affected file paths. */
  removeByHypothesis(hypothesisId: number): string[] {
    const affected: string[] = [];
    for (const [file, entries] of this.entries) {
      const before = entries.length;
      const filtered = entries.filter((e) => e.hypothesisId !== hypothesisId);
      if (filtered.length !== before) {
        affected.push(file);
        if (filtered.length === 0) {
          this.entries.delete(file);
        } else {
          this.entries.set(file, filtered);
        }
      }
    }
    return affected;
  }

  /** Remove all agent-originated breakpoints. Returns affected file paths. */
  removeAllAgentBreakpoints(): string[] {
    const affected: string[] = [];
    for (const [file, entries] of this.entries) {
      const filtered = entries.filter((e) => e.source === 'ide');
      if (filtered.length !== entries.length) {
        affected.push(file);
        if (filtered.length === 0) {
          this.entries.delete(file);
        } else {
          this.entries.set(file, filtered);
        }
      }
    }
    return affected;
  }

  /** Clear all IDE breakpoints for a file. */
  clearIdeBreakpoints(file: string): void {
    const fileEntries = this.entries.get(file);
    if (!fileEntries) return;
    const filtered = fileEntries.filter((e) => e.source !== 'ide');
    if (filtered.length === 0) {
      this.entries.delete(file);
    } else {
      this.entries.set(file, filtered);
    }
  }

  /** Get all entries for a file. */
  getForFile(file: string): LedgerEntry[] {
    return this.entries.get(file) ?? [];
  }

  /** Get all entries across all files. */
  getAll(): LedgerEntry[] {
    const all: LedgerEntry[] = [];
    for (const entries of this.entries.values()) {
      all.push(...entries);
    }
    return all;
  }

  /** Get entries for a specific hypothesis. */
  getByHypothesis(hypothesisId: number): LedgerEntry[] {
    return this.getAll().filter((e) => e.hypothesisId === hypothesisId);
  }

  /** Get breakpoint context grouped by source. */
  getContext(): BreakpointContext {
    const all = this.getAll();
    const toEntry = (e: LedgerEntry): BreakpointContextEntry => ({
      file: e.file,
      line: e.line,
      condition: e.condition,
      annotation: e.annotation,
      hypothesisId: e.hypothesisId,
      verified: e.verified,
      verificationMessage: e.verificationMessage,
    });
    return {
      ideBreakpoints: all.filter((e) => e.source === 'ide').map(toEntry),
      agentBreakpoints: all.filter((e) => e.source === 'agent').map(toEntry),
      untaggedBreakpoints: all.filter((e) => e.source === 'agent-untagged').map(toEntry),
    };
  }

  /** Find a ledger entry at a specific file and line. */
  findEntryAt(file: string, line: number): LedgerEntry | undefined {
    const fileEntries = this.entries.get(file);
    if (!fileEntries) return undefined;
    return fileEntries.find((e) => e.line === line);
  }

  /**
   * Sync all ledger entries to DAP. Merges entries per file,
   * deduplicates by line, and sends setBreakpoints.
   *
   * When a VS Code breakpoint sync callback is provided, it will be
   * used to add/remove breakpoints via the VS Code API instead of
   * sending DAP setBreakpoints directly. This is used by the
   * vscode-debug-bridge extension.
   */
  async syncToDAP(
    files?: string[],
    vsCodeSync?: {
      addBreakpoints: (breakpoints: { file: string; line: number; condition?: string }[]) => void;
      removeBreakpoints: (breakpoints: { file: string; line: number }[]) => void;
    },
  ): Promise<void> {
    const filesToSync = files ?? [...this.entries.keys()];

    for (const file of filesToSync) {
      const entries = this.getForFile(file);
      // Deduplicate by line (last entry wins)
      const byLine = new Map<number, LedgerEntry>();
      for (const entry of entries) {
        byLine.set(entry.line, entry);
      }
      const merged = [...byLine.values()];

      if (vsCodeSync) {
        // VS Code mode: use addBreakpoints/removeBreakpoints API
        vsCodeSync.addBreakpoints(
          merged.map((e) => ({ file: e.file, line: e.line, condition: e.condition })),
        );
      } else {
        // Standard DAP mode: send setBreakpoints request
        const remotePath = this.pathMapper.toRemote(file);
        await this.backend.sendRequest('setBreakpoints', {
          source: { path: remotePath },
          breakpoints: merged.map((e) => ({
            line: e.line,
            condition: e.condition,
            hitCondition: e.hitCondition,
            logMessage: e.logMessage,
          })),
        });
      }
    }
  }
}
