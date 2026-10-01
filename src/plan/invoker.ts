import type { SessionManager } from '../session.js';
import { coreToolDefinitions, type ToolContext, type ToolDefinition } from '../tools/registry.js';
import { errorResult, ErrorCodes, type ToolResult } from '../tools/types.js';
import type { PlanSurface } from './validate.js';

/**
 * Something that executes debug tools by name.
 *
 * The plan runner only ever talks to this, which is what makes a plan "just
 * tools": the same run executes against the core handlers in-process, against a
 * spawned MCP server (every call crosses the real transport and schema
 * validation), or against the VS Code extension's session.
 */
export interface ToolInvoker {
  readonly surface: PlanSurface;
  /** Names of the tools this invoker can execute. */
  tools(): Promise<Set<string>>;
  invoke(name: string, args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult>;
}

/**
 * Executes the core handlers directly on a SessionManager.
 *
 * Arguments go through each tool's own Zod schema first, as they would over
 * MCP, so a plan run in-process still catches a schema the runner no longer
 * satisfies.
 */
export class InProcessInvoker implements ToolInvoker {
  readonly surface = 'in-process' as const;
  private readonly defs: Map<string, ToolDefinition>;

  constructor(
    private readonly session: SessionManager,
    definitions: ToolDefinition[] = coreToolDefinitions(),
  ) {
    this.defs = new Map(definitions.map((d) => [d.name, d]));
  }

  async tools(): Promise<Set<string>> {
    return new Set(this.defs.keys());
  }

  async invoke(name: string, args: Record<string, unknown>, ctx: ToolContext = {}): Promise<ToolResult> {
    const def = this.defs.get(name);
    if (!def) return errorResult(`Unknown tool "${name}"`, ErrorCodes.INVALID_PARAMS);

    let parsed: unknown = args;
    if (def.schema) {
      const result = def.schema.safeParse(args);
      if (!result.success) {
        return errorResult(
          `Invalid arguments for ${name}: ${result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
          ErrorCodes.INVALID_PARAMS,
        );
      }
      parsed = result.data;
    }
    return def.run(this.session, parsed, ctx);
  }
}

/** One recorded tool call. */
export interface JournalEntry {
  seq: number;
  tool: string;
  args: Record<string, unknown>;
  result: ToolResult;
  /** Epoch ms when the call started. */
  at: number;
  ms: number;
}

/**
 * Records every call that passes through it.
 *
 * The journal is the raw material for debugging the MCP server itself: when a
 * re-run's report differs from its golden file, the journal shows exactly which
 * tool answered differently. A thrown error (a dead transport) is converted to
 * an error result, so the runner degrades rather than crashing mid-teardown.
 */
export class JournalingInvoker implements ToolInvoker {
  readonly entries: JournalEntry[] = [];
  private seq = 0;

  constructor(
    private readonly inner: ToolInvoker,
    private readonly onEntry?: (entry: JournalEntry) => void,
    private readonly now: () => number = Date.now,
  ) {}

  get surface(): PlanSurface {
    return this.inner.surface;
  }

  tools(): Promise<Set<string>> {
    return this.inner.tools();
  }

  async invoke(name: string, args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const at = this.now();
    let result: ToolResult;
    try {
      result = await this.inner.invoke(name, args, ctx);
    } catch (err) {
      result = errorResult(
        `${name} failed in the invoker: ${err instanceof Error ? err.message : String(err)}`,
        'INVOKER_ERROR',
      );
    }
    const entry: JournalEntry = { seq: ++this.seq, tool: name, args, result, at, ms: this.now() - at };
    this.entries.push(entry);
    this.onEntry?.(entry);
    return result;
  }
}
