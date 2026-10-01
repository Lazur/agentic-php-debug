import { z } from 'zod';
import { resolve } from 'node:path';
import { loadPlanFile, planBaseDir, validatePlan, type PlanSurface } from '../plan/validate.js';
import { successResult, errorResult, ErrorCodes, type ToolResult } from './types.js';

export const debugPlanValidateSchema = z.object({
  plan: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('The plan object to check. Its format is the input schema of debug_plan_run.'),
  path: z.string().optional().describe('Path of a *.debugplan.json file to check instead of an inline plan'),
});

export type DebugPlanValidateInput = z.infer<typeof debugPlanValidateSchema>;

export const debugPlanValidateDescription = `Check a debug plan without running anything: the schema, that every probe file exists and every line is in range, that ids and references resolve, and that this server provides every tool the plan needs. Warns about lines that are not executable (a breakpoint there never hits), capture expressions that look like they change state, and hypotheses nothing tests.

Pass the plan inline as "plan", or the path of a *.debugplan.json file as "path". Returns ok, errors and warnings with JSON paths, and the plan hash a run report will carry. Use it before debug_plan_run, and after writing a plan file that freezes an interactive finding.`;

/** Where plan tools run, and what they may do there. */
export interface PlanToolContext {
  /** Base for relative plan paths, and for relative probe files of an inline plan. */
  baseDir: string;
  surface: PlanSurface;
  /** Whether plans may spawn processes (trigger kind "command"). */
  allowCommandTrigger: boolean;
  /** Tools the executing surface provides; validation checks the plan against them. */
  availableTools?: ReadonlySet<string>;
}

/** The plan input of a plan tool: exactly one of an inline plan or a file path. */
export function loadPlanInput(
  args: { plan?: unknown; path?: string },
  baseDir: string,
): { input: unknown; baseDir: string } | { error: ToolResult } {
  if (args.plan !== undefined && args.path !== undefined) {
    return { error: errorResult('Pass either "plan" or "path", not both.', ErrorCodes.INVALID_PARAMS) };
  }
  if (args.path !== undefined) {
    const file = resolve(baseDir, args.path);
    try {
      return { input: loadPlanFile(file), baseDir: planBaseDir(file) };
    } catch (err) {
      return { error: errorResult(err instanceof Error ? err.message : String(err), ErrorCodes.INVALID_PARAMS) };
    }
  }
  if (args.plan === undefined) {
    return { error: errorResult('Pass the plan as "plan", or a plan file as "path".', ErrorCodes.INVALID_PARAMS) };
  }
  return { input: args.plan, baseDir };
}

export function handleDebugPlanValidate(args: DebugPlanValidateInput, ctx: PlanToolContext): ToolResult {
  const loaded = loadPlanInput(args, ctx.baseDir);
  if ('error' in loaded) return loaded.error;
  const result = validatePlan(loaded.input, {
    baseDir: loaded.baseDir,
    surface: ctx.surface,
    allowCommandTrigger: ctx.allowCommandTrigger,
    ...(ctx.availableTools ? { availableTools: ctx.availableTools } : {}),
  });
  return successResult({
    ok: result.ok,
    ...(result.planHash ? { planHash: result.planHash } : {}),
    errors: result.errors,
    warnings: result.warnings,
    nextAction: result.ok
      ? 'The plan is valid. Run it with debug_plan_run.'
      : 'Fix every error, then validate again. Nothing has run.',
  });
}
