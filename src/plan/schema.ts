import { z } from 'zod';

/**
 * Debug plan, schema version 1.
 *
 * A plan is written BEFORE a run and never changes during one. It is declarative:
 * which lines to break on, what to capture at each hit, how to trigger PHP, and
 * when to stop. The runner (runner.ts) compiles it into ordinary tool calls, so a
 * plan runs identically in-process, over MCP, or inside VS Code, with or without
 * an agent.
 *
 * No `.default()` anywhere: the parsed type stays identical to what the author
 * wrote, which keeps the plan hash stable. Defaults are applied by
 * validate.ts when it resolves the plan.
 *
 * The `.describe()` texts are model-facing — they end up in the JSON Schema that
 * `debug_plan_run` publishes as its input, which is how the agent learns the
 * format. Keep the operational traps in them.
 */

export const PLAN_SCHEMA_VERSION = 1;

const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'ids use letters, digits, "_", "." and "-"')
  .max(64);

const evaluateItemSchema = z.union([
  z.string().min(1).describe('PHP expression evaluated in the top frame, e.g. "$total" or "count($items)"'),
  z
    .object({
      expr: z.string().min(1).describe('PHP expression to evaluate'),
      frame: z
        .number()
        .int()
        .min(0)
        .max(99)
        .optional()
        .describe('Stack frame index to evaluate in: 0 = the stopped frame (default), 1 = its caller, ...'),
      volatile: z
        .boolean()
        .optional()
        .describe(
          'The value differs between runs (time, random, object ids). Captured, but excluded from golden comparison.',
        ),
    })
    .strict(),
]);

export const CaptureSpecSchema = z
  .object({
    stack: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('How many stack frames to record (default 1: just the stopped frame)'),
    evaluate: z
      .array(evaluateItemSchema)
      .max(50)
      .optional()
      .describe(
        'Expressions to evaluate at every captured hit. Must be side-effect free — they run inside the ' +
          'live request. Prefer this over locals: one targeted expression is cheaper than a variable dump. ' +
          'An object renders as its class name; evaluate a property, or var_export($x, true), for its contents.',
      ),
    locals: z
      .union([
        z.literal(false),
        z
          .object({
            depth: z
              .number()
              .int()
              .min(0)
              .max(4)
              .optional()
              .describe('How deep to expand arrays/objects (0 = names and scalar values only; default 1)'),
            maxItems: z
              .number()
              .int()
              .min(1)
              .max(500)
              .optional()
              .describe('Maximum variables recorded per scope or container (default 40)'),
            scopes: z
              .array(z.string().min(1))
              .max(5)
              .optional()
              .describe(
                'Scope names to dump (default ["Locals"]), e.g. ["Locals", "Superglobals"]. See redact.scopes.',
              ),
          })
          .strict(),
      ])
      .optional()
      .describe('Dump variables of the stopped frame. Omit or false to skip (the default).'),
    exception: z.boolean().optional().describe('Also record debug_exception_info. Automatic for exception stops.'),
  })
  .strict();

const probeCommon = {
  tests: z.array(idSchema).optional().describe('Ids of the hypotheses whose outcome this probe discriminates'),
  capture: CaptureSpecSchema.optional().describe('What to record at each hit (default: the stopped frame only)'),
  maxCaptures: z
    .number()
    .int()
    .min(0)
    .max(1000)
    .optional()
    .describe('Capture at most this many hits (default 10). Later hits are still counted, then continued at once.'),
};

export const ProbeSchema = z
  .object({
    id: idSchema.describe('Unique probe id, referenced by expect/predicts/sequence'),
    file: z
      .string()
      .min(1)
      .describe(
        'LOCAL path of the PHP file, relative to the plan root or absolute. Path mappings are applied by the server.',
      ),
    line: z
      .number()
      .int()
      .min(1)
      .describe(
        '1-based line of an EXECUTABLE statement. A breakpoint on a blank line, a comment, or a lone ' +
          'brace is accepted by the adapter and then never hits.',
      ),
    condition: z.string().min(1).optional().describe('PHP condition; the probe only stops when it is truthy'),
    hitCondition: z.string().min(1).optional().describe('Xdebug hit condition, e.g. ">= 3" or "% 10"'),
    ...probeCommon,
  })
  .strict();

export const FunctionProbeSchema = z
  .object({
    id: idSchema,
    name: z
      .string()
      .min(1)
      .describe('Function or method to break on at entry, e.g. "App\\\\Cart::total" or "array_sum"'),
    condition: z.string().min(1).optional(),
    hitCondition: z.string().min(1).optional(),
    ...probeCommon,
  })
  .strict();

export const ExceptionProbeSchema = z
  .object({
    id: idSchema.optional().describe('Probe id for exception stops (default "exception")'),
    filters: z
      .array(z.string().min(1))
      .min(1)
      .describe(
        'Exception filters, as the adapter offers them: "Exception" (and its subclasses), "Error", ' +
          '"Warning", "Notice", "Deprecated", or "*" for everything',
      ),
    ...probeCommon,
  })
  .strict();

const CommandTriggerSchema = z
  .object({
    kind: z.literal('command'),
    argv: z
      .array(z.string())
      .min(1)
      .describe('Program and arguments, spawned without a shell, e.g. ["php", "bin/console", "cart:total"]'),
    cwd: z.string().optional().describe('Working directory, relative to the plan root (default: the root)'),
    env: z.record(z.string(), z.string()).optional().describe('Extra environment variables'),
    xdebugEnv: z
      .boolean()
      .optional()
      .describe(
        'Inject XDEBUG_MODE, XDEBUG_TRIGGER and XDEBUG_CONFIG so a local PHP process connects to this ' +
          'session (default true). Set false when the command runs PHP elsewhere, e.g. inside a container.',
      ),
  })
  .strict();

const HttpTriggerSchema = z
  .object({
    kind: z.literal('http'),
    url: z.string().min(1).describe('Request URL; "${env:NAME}" is interpolated'),
    method: z.string().min(1).optional().describe('HTTP method (default GET)'),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string().optional(),
    xdebugCookie: z
      .boolean()
      .optional()
      .describe('Send an XDEBUG_SESSION cookie so Xdebug starts a session (default true)'),
  })
  .strict();

const ManualTriggerSchema = z
  .object({
    kind: z.literal('manual'),
    instructions: z
      .string()
      .optional()
      .describe('Shown to the person who triggers the request. Manual runs are not reproducible.'),
  })
  .strict();

export const TriggerSchema = z
  .discriminatedUnion('kind', [CommandTriggerSchema, HttpTriggerSchema, ManualTriggerSchema])
  .describe(
    'How PHP is started once breakpoints are in place. The run owns the trigger, so re-running the ' +
      'plan reproduces the execution.',
  );

export const PlanSessionSchema = z
  .object({
    port: z.number().int().min(1).max(65535).optional().describe('Xdebug listen port (default: server config)'),
    stopOnEntry: z
      .boolean()
      .optional()
      .describe('Stop on the first line of each connection (default false); the runner records and continues it'),
    hostname: z.string().optional().describe('Listen host. Honoured where the session is built per run.'),
    pathMappings: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Server path → local path. Honoured where the session is built per run; a running MCP server keeps its own.',
      ),
    backendMode: z
      .enum(['ui', 'headless'])
      .optional()
      .describe('VS Code only: drive the editor debug UI ("ui", default) or a hidden adapter ("headless")'),
  })
  .strict();

export const LimitsSchema = z
  .object({
    timeoutMs: z.number().int().min(1000).max(3_600_000).optional().describe('Whole-run deadline (default 120000)'),
    waitMs: z.number().int().min(10).max(600_000).optional().describe('Longest single debug_wait (default 10000)'),
    connectTimeoutMs: z
      .number()
      .int()
      .min(10)
      .max(3_600_000)
      .optional()
      .describe('Give up when Xdebug has not connected this long after the trigger started (default 30000)'),
    idleMs: z
      .number()
      .int()
      .min(0)
      .max(600_000)
      .optional()
      .describe('Quiet time after the trigger finished and every connection closed before the run ends (default 1500)'),
    maxStops: z
      .number()
      .int()
      .min(1)
      .max(10_000)
      .optional()
      .describe('Stop the run after this many stops (default 200)'),
    evaluateTimeoutMs: z
      .number()
      .int()
      .min(10)
      .max(600_000)
      .optional()
      .describe('Per-expression evaluate timeout (default 5000)'),
  })
  .strict();

export const RedactSchema = z
  .object({
    names: z
      .array(z.string())
      .optional()
      .describe(
        'Case-insensitive name fragments whose values are replaced by "[redacted]". Replaces the default list.',
      ),
    scopes: z
      .array(z.string())
      .optional()
      .describe(
        'Scopes dumped with names and types only, values replaced by "[redacted]" (default ["Superglobals"]). ' +
          'Evaluate one expression, e.g. "$_GET[\'id\']", to read a single value.',
      ),
  })
  .strict();

const ProbeHitsExpectationSchema = z
  .object({
    probe: idSchema,
    hits: z.number().int().min(0).describe('Exact number of times the probe stopped'),
  })
  .strict();

const ValueExpectationSchema = z
  .object({
    probe: idSchema,
    hit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Which captured hit (1-based). Omitted: the assertion must hold at every captured hit.'),
    expr: z
      .string()
      .min(1)
      .describe('Expression whose value is checked; it is added to the probe capture automatically'),
    equals: z
      .string()
      .optional()
      .describe('Exact value as the debugger renders it, e.g. "3.35", "true", "\\"abc\\"" (strings in double quotes)'),
    matches: z.string().optional().describe('JavaScript regular expression the rendered value must match'),
    type: z.string().optional().describe('Expected PHP type as reported, e.g. "float", "int", "string"'),
  })
  .strict();

const SequenceExpectationSchema = z
  .object({
    sequence: z
      .array(idSchema)
      .min(1)
      .describe('Exact order of matched stops by probe id (unmatched and entry stops excluded)'),
  })
  .strict();

export const RUN_OUTCOMES = ['completed', 'no_connection', 'max_stops', 'timeout', 'cancelled', 'failed'] as const;

const OutcomeExpectationSchema = z.object({ outcome: z.enum(RUN_OUTCOMES) }).strict();

const TriggerExpectationSchema = z
  .object({
    trigger: z
      .object({
        exitCode: z.number().int().optional().describe('Exit code of a command trigger'),
        status: z.number().int().optional().describe('HTTP status of an http trigger'),
      })
      .strict(),
  })
  .strict();

export const ExpectationSchema = z.union([
  ProbeHitsExpectationSchema,
  ValueExpectationSchema,
  SequenceExpectationSchema,
  OutcomeExpectationSchema,
  TriggerExpectationSchema,
]);

export const PredictionSchema = z.union([ProbeHitsExpectationSchema, ValueExpectationSchema]);

export const HypothesisSchema = z
  .object({
    id: idSchema,
    basis: z
      .string()
      .min(1)
      .describe('Evidence behind the hypothesis (code read, log line, bug report). Write this first.'),
    claim: z.string().min(1).describe('What you believe is wrong'),
    predicts: z
      .array(PredictionSchema)
      .optional()
      .describe('Observations that hold if the claim is true; the runner checks each one'),
  })
  .strict();

export const DebugPlanSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(PLAN_SCHEMA_VERSION),
    name: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'name uses letters, digits, "_" and "-"')
      .max(80)
      .describe('Plan name; names the run directory and the golden file'),
    goal: z.string().optional().describe('The question this run answers; carried into the report for analysis'),
    hypotheses: z
      .array(HypothesisSchema)
      .optional()
      .describe('Competing explanations, each with predictions the run can confirm or refute'),
    root: z
      .string()
      .optional()
      .describe('Base directory for relative paths (default: the plan file directory, or the working directory)'),
    session: PlanSessionSchema.optional(),
    trigger: TriggerSchema,
    probes: z
      .array(ProbeSchema)
      .optional()
      .describe('Line breakpoints with what to capture at each hit. Each file is sent once, before PHP starts.'),
    exceptions: ExceptionProbeSchema.optional().describe('Break when an exception is thrown'),
    functions: z.array(FunctionProbeSchema).optional().describe('Break on entry to named functions'),
    limits: LimitsSchema.optional(),
    onUnmatchedStop: z
      .enum(['record', 'ignore', 'abort'])
      .optional()
      .describe(
        'A stop no probe explains (e.g. a gutter breakpoint): "record" its location and continue (default), ' +
          '"ignore" it silently, or "abort" the run',
      ),
    redact: RedactSchema.optional(),
    expect: z
      .array(ExpectationSchema)
      .optional()
      .describe('Assertions checked after the run; they make the plan a regression test'),
  })
  .strict();

export type CaptureSpec = z.infer<typeof CaptureSpecSchema>;
export type EvaluateItem = z.infer<typeof evaluateItemSchema>;
export type Probe = z.infer<typeof ProbeSchema>;
export type FunctionProbe = z.infer<typeof FunctionProbeSchema>;
export type ExceptionProbe = z.infer<typeof ExceptionProbeSchema>;
export type Trigger = z.infer<typeof TriggerSchema>;
export type PlanSession = z.infer<typeof PlanSessionSchema>;
export type Limits = z.infer<typeof LimitsSchema>;
export type Expectation = z.infer<typeof ExpectationSchema>;
export type Prediction = z.infer<typeof PredictionSchema>;
export type Hypothesis = z.infer<typeof HypothesisSchema>;
export type DebugPlan = z.infer<typeof DebugPlanSchema>;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/** The plan schema as JSON Schema, for editors, MCP resources and the VS Code manifest. */
export function planJsonSchema(): Record<string, unknown> {
  return {
    ...(z.toJSONSchema(DebugPlanSchema) as Record<string, unknown>),
    $id: 'https://github.com/Lazur/agentic-php-debug/schemas/debug-plan.v1.schema.json',
    title: 'PHP debug plan (v1)',
  };
}
