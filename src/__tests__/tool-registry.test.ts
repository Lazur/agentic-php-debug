import { describe, it, expect, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools, type ServerMode } from '../tools/index.js';
import type { SessionManager } from '../session.js';
import { createMockBackend, launchAndPause, newSession } from './helpers/mock-backend.js';

/**
 * The 21 core debug tools.
 * Requirements: 13.5, 13.7
 */
const CORE_TOOLS = [
  'debug_launch',
  'debug_terminate',
  'debug_status',
  'debug_continue',
  'debug_next',
  'debug_step_in',
  'debug_step_out',
  'debug_pause',
  'debug_set_breakpoints',
  'debug_set_function_breakpoints',
  'debug_set_exception_breakpoints',
  'debug_evaluate',
  'debug_variables',
  'debug_stack_trace',
  'debug_scopes',
  'debug_set_variable',
  'debug_source',
  'debug_threads',
  'debug_exception_info',
  'debug_import_ide_breakpoints',
  'debug_wait',
] as const;

const PLAN_MODE_TOOLS = ['debug_status', 'debug_plan_validate', 'debug_plan_run', 'debug_plan_report'];

function setup(options?: Parameters<typeof registerAllTools>[2], session = {} as SessionManager) {
  const toolSpy = vi.fn();
  const mockServer = { tool: toolSpy } as unknown as McpServer;
  const returned = registerAllTools(mockServer, session, options);
  const names = toolSpy.mock.calls.map((call: unknown[]) => call[0] as string);
  const handlerOf = (name: string) => {
    const call = toolSpy.mock.calls.find((c: unknown[]) => c[0] === name)!;
    return call[call.length - 1] as (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }>;
  };
  return { toolSpy, names, returned, handlerOf };
}

describe('Tool Registry', () => {
  it('registers the 21 core tools plus debug_snapshot and debug_plan_validate by default (react mode)', () => {
    const { names, returned } = setup();
    expect(names).toHaveLength(23);
    expect(names).toEqual(expect.arrayContaining([...CORE_TOOLS, 'debug_snapshot', 'debug_plan_validate']));
    expect(names).not.toContain('debug_plan_run');
    expect(returned.sort()).toEqual([...names].sort());
  });

  it('still accepts the old boolean third argument', () => {
    expect(setup(true).names).toHaveLength(23);
  });

  it('registers only the plan tools in plan mode, so a plan cannot be revised mid-run', () => {
    const { names } = setup({ mode: 'plan' });
    expect(names.sort()).toEqual([...PLAN_MODE_TOOLS].sort());
    for (const step of ['debug_next', 'debug_continue', 'debug_launch', 'debug_set_breakpoints']) {
      expect(names).not.toContain(step);
    }
  });

  it('registers everything in all mode', () => {
    expect(setup({ mode: 'all' }).names).toHaveLength(25);
  });

  it.each<ServerMode>(['react', 'plan', 'all'])('gives every tool a description and a handler in %s mode', (mode) => {
    const { toolSpy } = setup({ mode });
    for (const call of toolSpy.mock.calls) {
      const [, description] = call as [string, string, ...unknown[]];
      expect(typeof description).toBe('string');
      expect(description.length).toBeGreaterThan(0);
      expect(typeof call[call.length - 1]).toBe('function');
    }
  });

  it('has debug_status advise only tools the mode registered', async () => {
    const mock = createMockBackend();
    const session = newSession(mock);

    const plan = await setup({ mode: 'plan' }, session).handlerOf('debug_status')({});
    const planAdvice = JSON.parse(plan.content[0].text).data.allowedTools as string[];
    expect(planAdvice.sort()).toEqual(['debug_plan_report', 'debug_plan_run', 'debug_plan_validate']);

    const react = await setup({ mode: 'react' }, session).handlerOf('debug_status')({});
    const reactAdvice = JSON.parse(react.content[0].text).data.allowedTools as string[];
    expect(reactAdvice).toEqual(['debug_launch', 'debug_plan_validate']);
  });

  it('advertises debug_snapshot while paused in react mode', async () => {
    const mock = createMockBackend();
    const session = await launchAndPause(mock);
    const result = await setup({ mode: 'react' }, session).handlerOf('debug_status')({});
    expect(JSON.parse(result.content[0].text).data.allowedTools).toContain('debug_snapshot');
  });
});
