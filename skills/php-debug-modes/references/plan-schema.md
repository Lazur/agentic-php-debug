# Debug plan format (`*.debugplan.json`, version 1)

Every field, its default, and what it is for. The authoritative schema is
`schemas/debug-plan.v1.schema.json` in `ts-php-debug-mcp` (generated from `src/plan/schema.ts`, and
published by the MCP server as `php-debug://schemas/debug-plan.v1.json`). Unknown fields are
rejected rather than ignored, so a typo fails validation instead of silently doing nothing.

- [Top level](#top-level)
- [session](#session)
- [trigger](#trigger)
- [probes](#probes)
- [exceptions and functions](#exceptions-and-functions)
- [capture](#capture)
- [hypotheses and expect](#hypotheses-and-expect)
- [limits, onUnmatchedStop, redact](#limits-onunmatchedstop-redact)
- [Interpolation and paths](#interpolation-and-paths)
- [Worked examples](#worked-examples)

## Top level

| Field | Required | Default | Notes |
|---|---|---|---|
| `version` | yes | — | `1` |
| `name` | yes | — | letters, digits, `_`, `-`. Names the run directory and the golden file |
| `goal` | no | — | the question the run answers; carried into the report |
| `root` | no | the plan file's directory | base for every relative path |
| `session` | no | server config | see below |
| `trigger` | yes | — | how PHP starts |
| `probes` | no | `[]` | line breakpoints |
| `exceptions` | no | — | break on throw |
| `functions` | no | `[]` | break on entry to a function |
| `hypotheses` | no | `[]` | competing explanations with predictions |
| `expect` | no | `[]` | assertions checked after the run |
| `limits` | no | see below | budgets |
| `onUnmatchedStop` | no | `"record"` | `record` \| `ignore` \| `abort` |
| `redact` | no | see below | what never leaves the debugger |

At least one of `probes`, `exceptions` or `functions` must be present — a plan with nothing to stop
on is rejected.

## session

Maps onto `debug_launch`.

| Field | Default | Notes |
|---|---|---|
| `port` | server config (9003) | Xdebug **listen** port. Pin it when two servers or two plans could run at once |
| `stopOnEntry` | `false` | an entry stop is recorded and continued, never captured |
| `hostname` | server config | honoured where the session is built per run (CLI, VS Code); a running MCP server keeps its own |
| `pathMappings` | server config | `{"<server path>": "<local path>"}`, e.g. `{"/app": "${root}"}` for a container |
| `backendMode` | `"ui"` in VS Code | VS Code only: `ui` shows the debugger moving, `headless` hides it |

`program` is **not** accepted. The adapter starts a `program` during launch, before any breakpoint
can be armed, so plans start PHP with their own trigger instead.

## trigger

The run owns execution: it starts the trigger *after* the probes are armed, and the trigger runs
concurrently because it blocks while PHP sits at a breakpoint.

```jsonc
{ "kind": "command", "argv": ["php", "bin/console", "cart:total", "42"],
  "cwd": ".",            // relative to root
  "env": {},             // extra environment variables
  "xdebugEnv": true }    // inject XDEBUG_MODE/XDEBUG_TRIGGER/XDEBUG_CONFIG for a local PHP process

{ "kind": "http", "url": "${env:APP_URL}/cart", "method": "POST",
  "headers": {}, "body": "{}", "xdebugCookie": true }   // sends XDEBUG_SESSION

{ "kind": "manual", "instructions": "Open /cart in the browser" }
```

`xdebugEnv` only helps a PHP process started on this machine. When the command runs PHP elsewhere
(`docker exec`, `ddev`, ssh), set it to `false` and make the remote side point at the listen port —
the container's `xdebug.client_host` must reach the host (`host.docker.internal` on Docker Desktop).

A `command` trigger runs only if the MCP server allows it (`--allow-command-trigger`); the CLI and
VS Code always allow it, because a person chose the file or approved the dialog.

## probes

```jsonc
{ "id": "line-total",                  // unique; referenced by expect/predicts/sequence
  "file": "src/Cart.php",              // LOCAL path, relative to root or absolute
  "line": 26,                          // 1-based, an executable statement
  "condition": "$qty > 1",             // optional PHP condition
  "hitCondition": ">= 3",              // optional: ">= N", "== N", "% N", or "N"
  "tests": ["H1", "H2"],               // hypotheses this probe discriminates
  "capture": { },                      // see below
  "maxCaptures": 10 }                  // later hits are counted, not inspected
```

Two probes may not share a `file:line`. Re-sending a file's breakpoints would reset its hit
counters, so the runner sends each file exactly once — which is also why `hitCondition` behaves.

If Xdebug moves a breakpoint to a nearby line, the run matches stops on both the requested and the
resolved line.

## exceptions and functions

```jsonc
"exceptions": { "id": "exception",        // default "exception"
                "filters": ["Exception"], // "Exception", "Error", "Warning", "Notice", "Deprecated", "*"
                "capture": { "stack": 10 } }

"functions": [ { "id": "total-entry", "name": "App\\Cart::total", "capture": { "stack": 2 } } ]
```

A filter matches subclasses, so `["Exception"]` on wrapped exceptions stops twice: once where the
inner exception is thrown, once where the wrapper is. Exception stops capture the class, the
message and the break mode automatically.

Function probes match on the frame name and tolerate `::` vs `->`.

## capture

What to record at each captured hit.

| Field | Default | Notes |
|---|---|---|
| `stack` | `1` | frames to record (the stopped frame is 1) |
| `evaluate` | `[]` | expressions, evaluated in the stopped frame |
| `locals` | omitted | `{ "depth": 1, "maxItems": 40, "scopes": ["Locals"] }` |
| `exception` | `false` | automatic on an exception stop |

`evaluate` entries are either a string or an object:

```jsonc
"evaluate": ["$total", { "expr": "$order->id", "frame": 1 }, { "expr": "microtime(true)", "volatile": true }]
```

`frame` picks a caller (0 is the stopped frame). `volatile` marks a value that differs between runs
— it is captured but excluded from golden comparison, which is how clocks, random values and object
ids stay out of a regression diff.

Expressions run inside the live request, so keep them free of side effects: assignments, `++`, `--`
and writing calls change the program you are measuring. Validation warns about the obvious ones.

## hypotheses and expect

```jsonc
"hypotheses": [
  { "id": "H1",
    "basis": "the evidence that suggested it — a code read, a log line, the report",
    "claim": "what you believe is wrong",
    "predicts": [ { "probe": "line-total", "hit": 1, "expr": "$rounded", "equals": "3.35" } ] }
]
```

The run checks each prediction and returns a verdict per hypothesis: `supported` (all held),
`refuted` (an observed value contradicted one), `untested` (nothing was observed to judge by — the
probe never hit, or the value was never captured).

`expect` entries take the same shapes, plus run-level ones:

```jsonc
{ "probe": "line-total", "hits": 3 }                                  // exact hit count
{ "probe": "line-total", "hit": 2, "expr": "$total", "equals": "5.84" } // omit "hit" to require it at every captured hit
{ "probe": "line-total", "expr": "$total", "matches": "^\\d+\\.\\d{2}$", "type": "float" }
{ "sequence": ["line-total", "sum", "line-total", "sum"] }            // ordered matched stops
{ "outcome": "completed" }                                            // completed | no_connection | max_stops | timeout | cancelled | failed
{ "trigger": { "exitCode": 0 } }                                      // or { "status": 200 } for http
```

Any expression named in `expect` or `predicts` is added to that probe's captures automatically, so
you do not have to repeat it under `capture.evaluate`.

Values are compared as the debugger renders them: strings in double quotes (`"\"n/a\""`), floats as
PHP prints them (`3.3449999999999998`), objects as their class name.

## limits, onUnmatchedStop, redact

```jsonc
"limits": {
  "timeoutMs": 120000,        // whole run
  "waitMs": 10000,            // longest single wait
  "connectTimeoutMs": 30000,  // give up if Xdebug never connects — raise it for a manual trigger
  "idleMs": 1500,             // quiet time after the trigger finished and connections closed
  "maxStops": 200,
  "evaluateTimeoutMs": 5000
}
```

`onUnmatchedStop` decides what happens at a stop no probe explains — usually a developer's own
editor breakpoint. `record` (default) keeps its location and continues, `ignore` continues silently,
`abort` ends the run.

`redact` replaces values whose names look like secrets with `[redacted]`, and dumps some scopes with
names and types only:

```jsonc
"redact": {
  "names": ["password", "passwd", "pwd", "secret", "token", "apikey", "api_key", "app_key",
            "private_key", "authorization", "auth_pw", "cookie", "credential"],
  "scopes": ["Superglobals"]
}
```

Listing either field replaces the default list. An expression whose text matches a name fragment is
not even sent to the debugger. To read one superglobal value deliberately, evaluate it by name
(`$_GET['id']`) — that is checked against the name list on its own.

## Interpolation and paths

`${env:NAME}` and `${root}` are interpolated in `trigger` and `session` strings; a missing variable
fails validation rather than expanding to nothing. Probe paths are resolved against `root` and
symlinks are followed, so they match what PHP reports.

## Worked examples

A web request through a container, breaking on the throw:

```jsonc
{
  "version": 1,
  "name": "checkout-500",
  "goal": "Which exception produces the 500 on /checkout, and what does the wrapper hide?",
  "session": { "port": 9003, "pathMappings": { "/var/www/html": "${root}" } },
  "trigger": { "kind": "http", "url": "${env:APP_URL}/checkout", "method": "POST", "body": "{\"id\":42}" },
  "exceptions": { "filters": ["Exception"], "capture": { "stack": 8, "evaluate": ["$e->getMessage()"] } },
  "limits": { "connectTimeoutMs": 60000 },
  "expect": [{ "outcome": "completed" }, { "trigger": { "status": 500 } }]
}
```

A hot loop, sampled:

```jsonc
{
  "version": 1,
  "name": "slow-import",
  "trigger": { "kind": "command", "argv": ["php", "bin/import.php", "big.csv"] },
  "probes": [
    { "id": "row", "file": "src/Import.php", "line": 88,
      "hitCondition": "% 100",
      "maxCaptures": 20,
      "capture": { "evaluate": ["$rowNumber", "count($batch)", "memory_get_usage(true)"] } }
  ],
  "limits": { "timeoutMs": 300000, "maxStops": 500 }
}
```
