import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ToolContext } from '../tools/registry.js';
import { errorResult, type ToolResult } from '../tools/types.js';
import type { ToolInvoker } from './invoker.js';

/**
 * Executes tools on an MCP server through a connected client.
 *
 * Running a plan through this is what tests the MCP server itself: every call
 * crosses the real transport, the SDK's argument validation, the tool
 * registration and the JSON serialization — none of which the in-process
 * invoker touches. The two must produce the same normalized report.
 *
 * Kept out of invoker.ts so the VS Code extension bundle never pulls in the
 * MCP client.
 */
export class McpClientInvoker implements ToolInvoker {
  readonly surface = 'mcp' as const;

  constructor(
    private readonly client: Client,
    /** The SDK's default (60s) would cut long waits; the plan's own limits bound the run. */
    private readonly requestTimeoutMs = 3_600_000,
  ) {}

  async tools(): Promise<Set<string>> {
    const { tools } = await this.client.listTools();
    return new Set(tools.map((t) => t.name));
  }

  async invoke(name: string, args: Record<string, unknown>, ctx: ToolContext = {}): Promise<ToolResult> {
    try {
      const r = await this.client.callTool({ name, arguments: args }, undefined, {
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        timeout: this.requestTimeoutMs,
        resetTimeoutOnProgress: true,
      });
      const content = (r.content ?? []) as Array<{ type: string; text?: string }>;
      const text = content.find((c) => c.type === 'text')?.text;
      if (text === undefined) return errorResult(`${name} returned no text content`, 'INVOKER_ERROR');
      try {
        return JSON.parse(text) as ToolResult;
      } catch {
        // SDK-level failures (e.g. argument validation) arrive as plain text.
        return errorResult(text, r.isError ? 'MCP_ERROR' : 'INVOKER_ERROR');
      }
    } catch (err) {
      // The SDK rejects a cancelled request client-side, without a payload.
      if (ctx.signal?.aborted) return errorResult(`${name} was cancelled`, 'CANCELLED');
      return errorResult(err instanceof Error ? err.message : String(err), 'MCP_ERROR');
    }
  }
}
