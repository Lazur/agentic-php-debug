import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerMode } from '../tools/index.js';
import type { RunStore } from '../plan/store.js';
import { planJsonSchema } from '../plan/schema.js';
import { normalizeReport } from '../plan/report.js';
import { debugPlanPrompt, debugPlanPromptDescription } from './plan.js';
import { debugReactPrompt, debugReactPromptDescription } from './react.js';

export const PLAN_SCHEMA_URI = 'php-debug://schemas/debug-plan.v1.json';

const problemArg = {
  problem: z.string().describe('The bug to investigate: symptom, where it shows, how to reproduce it'),
};

/**
 * The mode prompts — how an MCP client (e.g. a slash command) starts a
 * session in one mode or the other. Only the prompts whose tools this server
 * mode registers are offered.
 */
export function registerPrompts(server: McpServer, mode: ServerMode): void {
  if (mode !== 'react') {
    server.registerPrompt(
      'debug_plan',
      { title: 'Debug with a plan', description: debugPlanPromptDescription, argsSchema: problemArg },
      ({ problem }) => ({ messages: [{ role: 'user', content: { type: 'text', text: debugPlanPrompt(problem) } }] }),
    );
  }
  if (mode !== 'plan') {
    server.registerPrompt(
      'debug_react',
      { title: 'Debug interactively', description: debugReactPromptDescription, argsSchema: problemArg },
      ({ problem }) => ({ messages: [{ role: 'user', content: { type: 'text', text: debugReactPrompt(problem) } }] }),
    );
  }
}

/**
 * The plan schema (every mode: ReAct freezes findings into plans) and, where
 * plans run, each stored run's report, journal and normalized form.
 */
export function registerPlanResources(server: McpServer, store: RunStore, mode: ServerMode): void {
  server.registerResource(
    'debug-plan-schema',
    PLAN_SCHEMA_URI,
    {
      title: 'Debug plan schema (v1)',
      description: 'JSON Schema of a *.debugplan.json file — the input of debug_plan_run.',
      mimeType: 'application/schema+json',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/schema+json', text: JSON.stringify(planJsonSchema(), null, 2) }],
    }),
  );

  if (mode === 'react') return;

  server.registerResource(
    'debug-plan-run',
    new ResourceTemplate('php-debug://runs/{runId}/{part}', {
      list: async () => ({
        resources: store.list().flatMap((runId) =>
          (['report', 'journal', 'normalized'] as const).map((part) => ({
            uri: `php-debug://runs/${runId}/${part}`,
            name: `${runId} ${part}`,
            mimeType: part === 'journal' ? 'application/x-ndjson' : 'application/json',
          })),
        ),
      }),
    }),
    {
      title: 'Plan run artifacts',
      description: 'A finished plan run: report, tool-call journal (one JSON object per line), or normalized report.',
    },
    async (uri, variables) => {
      const runId = String(variables.runId);
      const part = String(variables.part);
      const run = store.get(runId);
      if (!run) throw new Error(`No plan run "${runId}"`);
      const text =
        part === 'journal'
          ? run.journal.map((e) => JSON.stringify(e)).join('\n')
          : JSON.stringify(part === 'normalized' ? normalizeReport(run.report) : run.report, null, 2);
      return {
        contents: [{ uri: uri.href, mimeType: part === 'journal' ? 'application/x-ndjson' : 'application/json', text }],
      };
    },
  );
}
