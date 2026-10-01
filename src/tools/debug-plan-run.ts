import { z } from 'zod';
import { DebugPlanSchema } from '../plan/schema.js';
import { validatePlan } from '../plan/validate.js';
import { JournalingInvoker, type ToolInvoker } from '../plan/invoker.js';
import { runPlan, type RunPlanOptions } from '../plan/runner.js';
import { summarizeReport } from '../plan/report.js';
import type { RunStore } from '../plan/store.js';
import { successResult, errorResult, ErrorCodes, type ToolResult } from './types.js';
import { loadPlanInput, type PlanToolContext } from './debug-plan-validate.js';

export const debugPlanRunSchema = z.object({
  plan: DebugPlanSchema.optional().describe(
    'The plan to execute. It is frozen when the run starts: nothing in it can change until the run ends.',
  ),
  path: z.string().optional().describe('Path of a *.debugplan.json file to run instead of an inline plan'),
});

export type DebugPlanRunInput = z.infer<typeof debugPlanRunSchema>;

export const debugPlanRunDescription = `Execute a debug plan deterministically — nothing consults a model until it has finished.

1. initialize — launch the session, register every probe as a breakpoint, and confirm each one is armed BEFORE PHP starts.
2. execute — start the trigger (a command or an HTTP request); at every stop, capture exactly what the plan asks for, then continue.
3. teardown — terminate the session and collect the trigger's result.

The plan cannot be revised mid-run: to learn more, write a new plan and run it. Returns a compact summary — outcome, hit counts per probe, the first stops with their captured values, expectation and hypothesis verdicts — and a runId; call debug_plan_report with it for full frames, locals and the tool-call journal.

Needs an idle session (not_started or terminated): a run never takes over a live one. Analyse the result from the report alone.`;

export interface PlanRunContext extends PlanToolContext {
  invoker: ToolInvoker;
  store: RunStore;
  signal?: AbortSignal;
  reportProgress?: (message: string) => void;
  adapterVersion?: string;
  backend?: string;
  /** Test seam: replaces the real trigger. */
  startTrigger?: RunPlanOptions['startTrigger'];
}

export async function handleDebugPlanRun(args: DebugPlanRunInput, ctx: PlanRunContext): Promise<ToolResult> {
  const loaded = loadPlanInput(args, ctx.baseDir);
  if ('error' in loaded) return loaded.error;

  const availableTools = ctx.availableTools ?? (await ctx.invoker.tools());
  const validation = validatePlan(loaded.input, {
    baseDir: loaded.baseDir,
    surface: ctx.surface,
    allowCommandTrigger: ctx.allowCommandTrigger,
    availableTools,
  });
  if (!validation.ok || !validation.plan) {
    return errorResult(
      `The plan is invalid; nothing was run.\n${validation.errors.map((e) => `- ${e.path || '(plan)'}: ${e.message}`).join('\n')}`,
      ErrorCodes.PLAN_INVALID,
    );
  }

  const invoker = new JournalingInvoker(ctx.invoker);
  const report = await runPlan(validation.plan, {
    invoker,
    warnings: validation.warnings,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(ctx.adapterVersion !== undefined ? { adapterVersion: ctx.adapterVersion } : {}),
    ...(ctx.backend !== undefined ? { backend: ctx.backend } : {}),
    ...(ctx.startTrigger ? { startTrigger: ctx.startTrigger } : {}),
    onProgress: (p) => ctx.reportProgress?.(`[${p.phase}] ${p.message}`),
  });

  const busy = report.errors.find((e) => e.code === ErrorCodes.SESSION_BUSY);
  if (busy) return errorResult(busy.message, ErrorCodes.SESSION_BUSY);

  const stored = ctx.store.save(report, invoker.entries);
  return successResult({
    ...summarizeReport(report),
    ...(stored.dir ? { artifacts: stored.dir } : {}),
    nextAction:
      report.outcome === 'completed'
        ? 'Analyse from this report: for each hypothesis, prediction vs observed, then the root cause. ' +
          `Use debug_plan_report {"runId": "${report.runId}"} for frames, locals or the journal. Nothing is running now.`
        : `The run ended "${report.outcome}". Read outcomeDetail and errors, fix the plan or the environment, and run a new plan.`,
  });
}
