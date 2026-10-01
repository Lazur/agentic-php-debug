import { z } from 'zod';
import { normalizeReport, summarizeReport } from '../plan/report.js';
import type { RunStore } from '../plan/store.js';
import { successResult, errorResult, ErrorCodes, type ToolResult } from './types.js';

const SECTIONS = [
  'summary',
  'stops',
  'breakpoints',
  'trigger',
  'expectations',
  'output',
  'errors',
  'journal',
  'normalized',
] as const;

export const debugPlanReportSchema = z.object({
  runId: z.string().optional().describe('Run to read (default: the most recent run)'),
  stop: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('One stop, by its seq number, in full: frames, values, locals, exception'),
  probe: z.string().optional().describe('Every stop of one probe, in full'),
  section: z.enum(SECTIONS).optional().describe('Part of the report to return (default "summary")'),
  offset: z.number().int().min(0).optional().describe('First item to return from stops/journal (default 0)'),
  limit: z.number().int().min(1).max(200).optional().describe('Maximum items from stops/journal (default 20)'),
});

export type DebugPlanReportInput = z.infer<typeof debugPlanReportSchema>;

export const debugPlanReportDescription = `Read a finished plan run in detail. debug_plan_run returns only a summary; this returns one stop in full ("stop": seq), every stop of a probe ("probe"), or a section: "stops" (paged), "breakpoints" (what was armed and how the adapter verified it), "trigger" (exit code or HTTP status, output tails), "expectations" (with observed values), "output" (adapter output), "errors", "journal" (every tool call the run made, paged) or "normalized" (the form compared against golden files).

Reads the latest run unless "runId" is given. Read-only: nothing is executed.`;

export function handleDebugPlanReport(args: DebugPlanReportInput, ctx: { store: RunStore }): ToolResult {
  const run = ctx.store.get(args.runId);
  if (!run) {
    const known = ctx.store.list();
    return errorResult(
      args.runId
        ? `No run "${args.runId}". Known runs: ${known.slice(-10).join(', ') || 'none'}.`
        : 'No plan has been run yet. Call debug_plan_run first.',
      ErrorCodes.RUN_NOT_FOUND,
    );
  }
  const { report, journal } = run;
  const offset = args.offset ?? 0;
  const limit = args.limit ?? 20;
  const page = <T>(items: T[]) => ({
    items: items.slice(offset, offset + limit),
    total: items.length,
    offset,
    ...(offset + limit < items.length ? { nextOffset: offset + limit } : {}),
  });

  if (args.stop !== undefined) {
    const stop = report.stops.find((s) => s.seq === args.stop);
    if (!stop) {
      return errorResult(
        `Run ${report.runId} has no stop #${args.stop} (it has ${report.stops.length}).`,
        ErrorCodes.INVALID_PARAMS,
      );
    }
    return successResult({ runId: report.runId, stop });
  }
  if (args.probe !== undefined) {
    if (!(args.probe in report.probes)) {
      return errorResult(
        `Run ${report.runId} has no probe "${args.probe}" (probes: ${Object.keys(report.probes).join(', ')}).`,
        ErrorCodes.INVALID_PARAMS,
      );
    }
    return successResult({
      runId: report.runId,
      probe: args.probe,
      ...page(report.stops.filter((s) => s.probe === args.probe)),
    });
  }

  switch (args.section ?? 'summary') {
    case 'summary':
      return successResult({ ...summarizeReport(report), ...(run.dir ? { artifacts: run.dir } : {}) });
    case 'stops':
      return successResult({ runId: report.runId, ...page(report.stops) });
    case 'journal':
      return successResult({ runId: report.runId, ...page(journal) });
    case 'normalized':
      return successResult({ runId: report.runId, normalized: normalizeReport(report) });
    case 'breakpoints':
      return successResult({ runId: report.runId, breakpoints: report.breakpoints });
    case 'trigger':
      return successResult({ runId: report.runId, trigger: report.trigger ?? null });
    case 'expectations':
      return successResult({ runId: report.runId, expectations: report.expectations, predictions: report.predictions });
    case 'output':
      return successResult({ runId: report.runId, output: report.output ?? null });
    case 'errors':
      return successResult({ runId: report.runId, errors: report.errors, warnings: report.warnings });
  }
}
