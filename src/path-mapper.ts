export interface PathMapping {
  local: string;
  remote: string;
}

/**
 * Bidirectional path translator using longest-prefix matching.
 * Standalone module with no MCP or DAP dependencies (Requirement 14.3).
 */
export class PathMapper {
  /** Mappings sorted by local prefix length descending (for toRemote). */
  private readonly byLocal: PathMapping[];
  /** Mappings sorted by remote prefix length descending (for toLocal). */
  private readonly byRemote: PathMapping[];

  constructor(mappings: PathMapping[]) {
    // Normalize: ensure prefixes end with '/' for directory matching,
    // but keep originals for replacement so we don't double-slash.
    this.byLocal = [...mappings].sort((a, b) => b.local.length - a.local.length);
    this.byRemote = [...mappings].sort((a, b) => b.remote.length - a.remote.length);
  }

  /** Translate a local path to its remote equivalent. */
  toRemote(localPath: string): string {
    for (const m of this.byLocal) {
      if (localPath.startsWith(m.local)) {
        return m.remote + localPath.slice(m.local.length);
      }
    }
    return localPath;
  }

  /** Translate a remote path to its local equivalent. */
  toLocal(remotePath: string): string {
    for (const m of this.byRemote) {
      if (remotePath.startsWith(m.remote)) {
        return m.local + remotePath.slice(m.remote.length);
      }
    }
    return remotePath;
  }
}
