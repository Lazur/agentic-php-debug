/**
 * Shared contract between the core's Zod schemas and the VS Code extension's
 * `contributes.languageModelTools` manifest.
 *
 * check-schemas.ts and sync-schemas.ts previously carried byte-identical copies
 * of this map and of the normalizers below. They live here so the checker and
 * the writer cannot disagree about what "in sync" means.
 */
import { z } from 'zod';

/** Map a Zod schema export name to the LM tool it backs in the extension. */
export const schemaToToolName: Record<string, string> = {
  debugLaunchSchema: 'debug_launch',
  debugWaitSchema: 'debug_wait',
  debugEvaluateSchema: 'debug_evaluate',
  debugThreadsSchema: 'debug_threads',
  debugContinueSchema: 'debug_continue',
  debugNextSchema: 'debug_next',
  debugStepInSchema: 'debug_step_in',
  debugStepOutSchema: 'debug_step_out',
  debugPauseSchema: 'debug_pause',
  debugSetBreakpointsSchema: 'debug_set_breakpoints',
  debugVariablesSchema: 'debug_variables',
  debugStackTraceSchema: 'debug_stack_trace',
  debugScopesSchema: 'debug_scopes',
  debugSetExceptionBreakpointsSchema: 'debug_set_exception_breakpoints',
  debugExceptionInfoSchema: 'debug_exception_info',
  debugSnapshotSchema: 'debug_snapshot',
  debugPlanValidateSchema: 'debug_plan_validate',
  debugPlanRunSchema: 'debug_plan_run',
  debugPlanReportSchema: 'debug_plan_report',
};

/** Map an LM tool name to the core description constant the model should read. */
export const toolNameToDescriptionExport: Record<string, string> = {
  debug_launch: 'debugLaunchDescription',
  debug_terminate: 'debugTerminateDescription',
  debug_status: 'debugStatusDescription',
  debug_wait: 'debugWaitDescription',
  debug_evaluate: 'debugEvaluateDescription',
  debug_threads: 'debugThreadsDescription',
  debug_continue: 'debugContinueDescription',
  debug_next: 'debugNextDescription',
  debug_step_in: 'debugStepInDescription',
  debug_step_out: 'debugStepOutDescription',
  debug_pause: 'debugPauseDescription',
  debug_set_breakpoints: 'debugSetBreakpointsDescription',
  debug_variables: 'debugVariablesDescription',
  debug_stack_trace: 'debugStackTraceDescription',
  debug_scopes: 'debugScopesDescription',
  debug_set_exception_breakpoints: 'debugSetExceptionBreakpointsDescription',
  debug_exception_info: 'debugExceptionInfoDescription',
  debug_snapshot: 'debugSnapshotDescription',
  debug_plan_validate: 'debugPlanValidateDescription',
  debug_plan_run: 'debugPlanRunDescription',
  debug_plan_report: 'debugPlanReportDescription',
};

/**
 * Properties that legitimately exist only in the extension's manifest.
 *
 * `SessionFactory.buildConfig` consumes these to assemble the Config BEFORE the
 * core handler runs; `handleDebugLaunch` forwards only stopOnEntry and port to
 * `session.launch()`. Adding them to debugLaunchSchema would be a lie — the MCP
 * server would accept and silently ignore them, and pathMappings could not work
 * as a launch override at all because PathMapper is constructed once and
 * injected. So the checker tolerates them and the writer preserves them.
 */
export const extensionOnlyProperties: Record<string, string[]> = {
  debug_launch: ['backendMode', 'hostname', 'pathMappings', 'log'],
};

/** LM tools the extension owns outright, with no core schema behind them. */
export const extensionOnlyTools = new Set(['debug_breakpoints_get']);

// ── JSON Schema normalization ────────────────────────────────────────────────

/** Strip metadata keys that package.json inputSchema doesn't include. */
export function normalizeGenerated(jsonSchema: Record<string, unknown>): Record<string, unknown> {
  const { $schema, additionalProperties, ...rest } = jsonSchema;
  const result: Record<string, unknown> = { ...rest };
  if (result.properties && typeof result.properties === 'object') {
    result.properties = normalizeProperties(result.properties as Record<string, unknown>);
  }
  return result;
}

function normalizeProperties(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(props)) {
    out[key] = val && typeof val === 'object' ? normalizeProperty(val as Record<string, unknown>) : val;
  }
  return out;
}

function normalizeProperty(prop: Record<string, unknown>): Record<string, unknown> {
  const { minimum, maximum, ...rest } = prop;
  const result: Record<string, unknown> = { ...rest };
  if (result.type === 'integer') {
    result.type = 'number';
  }
  if (result.items && typeof result.items === 'object') {
    const items = result.items as Record<string, unknown>;
    const { additionalProperties: _ap, ...itemRest } = items;
    result.items = normalizeProperty(itemRest);
  }
  if (result.properties && typeof result.properties === 'object') {
    result.properties = normalizeProperties(result.properties as Record<string, unknown>);
  }
  return result;
}

/** A Zod schema paired with the tool it backs. */
export interface SchemaEntry {
  exportName: string;
  toolName: string;
  schema: z.ZodType;
}

/** Every exported *Schema that maps to an LM tool, in manifest order. */
export function collectSchemaEntries(allSchemas: Record<string, unknown>): SchemaEntry[] {
  const entries: SchemaEntry[] = [];
  for (const [exportName, value] of Object.entries(allSchemas)) {
    if (!exportName.endsWith('Schema')) continue;
    if (!value || typeof (value as { safeParse?: unknown }).safeParse !== 'function') continue;
    const toolName = schemaToToolName[exportName];
    if (!toolName) continue;
    entries.push({ exportName, toolName, schema: value as z.ZodType });
  }
  return entries;
}

/**
 * Generate the manifest inputSchema for one tool, carrying over any
 * extension-only properties the existing entry declares.
 */
export function generateInputSchema(
  entry: SchemaEntry,
  existing: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const generated = normalizeGenerated(z.toJSONSchema(entry.schema) as Record<string, unknown>);

  const preserved = extensionOnlyProperties[entry.toolName] ?? [];
  if (preserved.length === 0 || !existing) return generated;

  const existingProps = (existing.properties ?? {}) as Record<string, unknown>;
  const generatedProps = (generated.properties ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...generatedProps };
  for (const name of preserved) {
    if (name in existingProps) merged[name] = existingProps[name];
  }
  return { ...generated, properties: merged };
}

/** Collect every description constant exported anywhere under src/tools. */
export function collectDescriptions(modules: Array<Record<string, unknown>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const mod of modules) {
    for (const [name, value] of Object.entries(mod)) {
      if (name.endsWith('Description') && typeof value === 'string') {
        out[name] = value;
      }
    }
  }
  return out;
}
