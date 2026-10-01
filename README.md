# ts-php-debug-mcp

MCP server for PHP/Xdebug debugging via the [vscode-php-debug](https://github.com/xdebug/vscode-php-debug) DAP adapter. Exposes debug tools over the Model Context Protocol so an AI agent can launch, step through, inspect, and control PHP debug sessions — interactively (ReAct mode), or by writing a plan that runs whole, reproducibly, with or without an agent (plan mode). See [Run modes](#run-modes).

This package is also **the shared core**: the session state machine, the 21 tool handlers, path mapping and the breakpoint ledger live here and are reused by the [`vscode-agentic-debug`](../vscode-agentic-debug/) extension through the `DebugBackend` interface. See [DESIGN.md](./DESIGN.md) for the class diagrams.

## Prerequisites

- Node.js ≥ 18
- PHP with Xdebug 3 configured (`xdebug.mode=debug`, `xdebug.start_with_request=yes`)

### Bundled DAP adapter

The [vscode-php-debug](https://github.com/xdebug/vscode-php-debug) adapter (MIT) ships inside this package — there is nothing to clone or build separately. `vscode-php-debug` is a VS Code extension, not an npm package, so it is pinned as a git devDependency (`php-debug` in `package.json`, currently v1.40.1) and `npm run build` bundles its `src/phpDebug.ts` with esbuild into `dist/adapter/phpDebug.js` (see [scripts/build-adapter.mjs](scripts/build-adapter.mjs)). `dist/adapter/VERSION` records the exact upstream commit.

The MCP server runs it via `node dist/adapter/phpDebug.js` and communicates over DAP (Debug Adapter Protocol) on stdio. To try a different adapter build, point `adapterPath` at it in your config.

To upgrade: change the commit SHA of `php-debug` in `package.json`, `npm install`, `npm run build`.

### Architecture

```
MCP Client ──► ts-php-debug-mcp ──► node phpDebug.js (DAP) ──► Xdebug (PHP)
```

In the VS Code extension the same core runs with `VsCodeDebugBackend` in place of `DAPClient`, so
VS Code owns the adapter and the developer sees the native debug UI.

## Quick start

```bash
curl -fsSL https://raw.githubusercontent.com/Lazur/php-debug-mcp/main/install.sh | bash
```

This builds the server, registers it with Claude Code and Codex, and checks Xdebug. Docker
projects, VS Code, other MCP clients and every option are covered in [INSTALL.md](INSTALL.md).

From a clone:

```bash
npm install
npm run build
```

### stdio transport (default)

```bash
node dist/index.js --config config.php.local.json
```

### Streamable HTTP transport

```bash
node dist/index.js --config config.php.local.json --transport http --port 3000
```

The HTTP transport uses `StreamableHTTPServerTransport` which supports Server-Sent Events (SSE). This enables the server to push notifications to the client in real time — the agent doesn't need to poll for state changes.

#### How the agent reacts to session events

The server emits MCP log notifications (`notifications/message`) on two loggers:

| Logger | Level | `data` |
|---|---|---|
| `ts-php-debug-mcp` | `info` | One line per state transition, e.g. `Session state: listening → connected`, `Session state: connected → paused` |
| `ts-php-debug-mcp/debugEvent` | `warning` for `stopped`, `info` for the rest | A structured payload, e.g. `{ "event": "stopped", "reason": "breakpoint", "threadId": 1, "allThreadsStopped": false, "state": "paused" }` |

Debug events are sent for `stopped`, `continued`, `thread` (started / exited), `terminated`, `exited`, `output` and `breakpoint` (resolution results). The server declares the `logging` capability, so clients can also filter by level with `logging/setLevel`.

With stdio transport, these notifications are sent over stdout as JSON-RPC messages — the MCP client receives them inline. With HTTP transport, they're streamed via SSE, so the client gets them pushed without polling.

The recommended agent workflow:

1. Call `debug_launch` — returns when the adapter is listening
2. Trigger PHP execution (HTTP request, CLI script, etc.)
3. The agent calls `debug_wait`, which blocks until Xdebug connects or a breakpoint is hit (events that fired in between are replayed)
4. Meanwhile the server pushes a notification for each of these events; if the MCP client supports notification handlers, it can wake the agent on them
5. `debug_status` reports the current state and guidance at any time

Progress notifications (`notifications/progress`) are also sent during `debug_launch` with a 5-step progress sequence, useful for clients that render progress bars.

## Run modes

Two ways for an agent to debug, chosen with `--mode`:

| | `--mode react` (default) | `--mode plan` |
|---|---|---|
| The agent… | chooses every next step from the paused frame | writes a plan before anything runs, then analyses the report |
| Tools | the 21 debug tools, `debug_snapshot`, `debug_plan_validate` | `debug_plan_validate`, `debug_plan_run`, `debug_plan_report`, `debug_status` |
| MCP prompt | `debug_react` | `debug_plan` |
| Model calls while PHP runs | one per step | none |
| Reproducible | no | yes: re-run the plan, compare the report |

The mode is enforced by the tool surface: a plan-mode server registers no step tools, so a plan cannot be revised mid-run. `--mode all` registers both, for development. Plans may spawn processes (trigger kind `command`) only with `--allow-command-trigger`. Finished runs are kept under `--runs-dir` (default `$TMPDIR/php-debug-mcp/runs`) and exposed as `php-debug://runs/{runId}/{report,journal,normalized}` resources; the plan schema is `php-debug://schemas/debug-plan.v1.json`.

Both modes side by side, as client configuration: [`mcp.example.json`](mcp.example.json), explained
under [MCP client configuration](#mcp-client-configuration).

### Plan mode

A plan (`*.debugplan.json`, JSON Schema in [schemas/debug-plan.v1.schema.json](schemas/debug-plan.v1.schema.json), generated from [src/plan/schema.ts](src/plan/schema.ts)) is declarative: **probes** (a breakpoint plus what to capture at each hit), a **trigger** that starts PHP, **limits**, and optionally competing **hypotheses** with predictions and **expect** assertions. Trimmed from [e2e/plans/cart-rounding.debugplan.json](e2e/plans/cart-rounding.debugplan.json):

```jsonc
{
  "version": 1,
  "name": "cart-rounding",
  "hypotheses": [
    { "id": "H1", "basis": "round() to 2 decimals; 1.115 × 3 is 3.345 on paper", "claim": "rounds up to 3.35",
      "predicts": [{ "probe": "line-total", "hit": 1, "expr": "$rounded", "equals": "3.35" }] },
    { "id": "H2", "basis": "in binary 1.115 × 3 is 3.3449999…", "claim": "rounds down to 3.34",
      "predicts": [{ "probe": "line-total", "hit": 1, "expr": "$rounded", "equals": "3.34" }] }
  ],
  "trigger": { "kind": "command", "argv": ["php", "e2e/fixtures/cart.php"] },
  "probes": [
    { "id": "line-total", "file": "e2e/fixtures/cart.php", "line": 26, "tests": ["H1", "H2"],
      "capture": { "stack": 3, "evaluate": ["$price", "$qty", "$raw", "$rounded"] } }
  ],
  "expect": [{ "probe": "line-total", "hits": 3 }, { "outcome": "completed" }]
}
```

A run is fixed in four phases:

1. **validate** — schema, files and lines, references, and that the surface provides every tool the plan needs. Nothing starts on an invalid plan.
2. **initialize** — `debug_launch`, then each file's probes in one `debug_set_breakpoints` while the session is *listening*. Every breakpoint must come back `pending_connection` — registered before PHP starts, so the adapter replays it onto the connection before a single line runs — and no Xdebug connection may exist yet. Otherwise the run stops here.
3. **execute** — start the trigger (it runs concurrently: it blocks while PHP sits at a breakpoint), then loop on `debug_wait`: match each stop to a probe by `file:line` (the adapter's stops carry no breakpoint ids), capture, `debug_continue`. The run ends when the trigger has finished and every connection has closed, or on `timeoutMs`, `maxStops`, cancellation, or no connection within `connectTimeoutMs`.
4. **teardown** — `debug_terminate` and the trigger's result, always. The report then carries expectation results and a verdict per hypothesis (`supported` / `refuted` / `untested`).

Plans run PHP through their own trigger, never through the config's `program`: the adapter starts a `program` during launch, before any breakpoint can be armed.

### Running a plan without an agent

There are three ways to run a plan by hand. None of them consults a model, and all three give the
same stops, values and verdicts as an agent's `debug_plan_run` call.

| Route | What it runs | Use it for |
|---|---|---|
| `php-debug-plan run` (CLI) | the plan runner, in the CLI process | CI, goldens, re-running a plan from the terminal |
| `debug_plan_run` via an MCP client | the `debug_plan_run` tool of a `--mode plan` server | checking what an agent gets from that tool |
| *Agentic Debug: Run Debug Plan…* (VS Code) | the extension's runner | running a plan from the editor (see [vscode-agentic-debug](../vscode-agentic-debug/README.md)) |

#### CLI

```bash
php-debug-plan validate plan.json
php-debug-plan run plan.json [--config cfg.json] [--via in-process|mcp-stdio|mcp-http=<url>] \
                             [--out dir] [--golden golden.json [--update-golden]] [--json]
php-debug-plan schema
```

`php-debug-plan` is on `PATH` only after the package is installed (for example `npm link` in this
directory). Before that, run `node dist/plan/cli.js` with the same arguments:

```bash
cd /path/to/php-project
node /path/to/ts-php-debug-mcp/dist/plan/cli.js run .claude/debug-plans/my.debugplan.json \
  --config config.php.json --out /tmp/plan-run
```

Each run writes `report.json`, `report.normalized.json` and `journal.jsonl` (every tool call and its result). The normalized report drops everything that legitimately differs between two runs — ids, timings, thread numbers, the surface, `volatile` expressions, paths under the plan root — so two runs of the same plan against the same code compare equal. `--golden` turns a plan into a regression test; `--via mcp-stdio` drives this MCP server tool by tool, so the same plan and golden test the server itself. Exit codes: 0 pass, 1 expectation or golden mismatch, 2 invalid plan, 3 run failed.

#### Calling `debug_plan_run` from an MCP client

The CLI does not call the `debug_plan_run` tool. To call that tool by hand, use a generic MCP client
such as the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) CLI. Put the plan
server in a config file with the same shape as [`mcp.example.json`](mcp.example.json):

```json
{
  "mcpServers": {
    "php-debug-plan": {
      "command": "node",
      "args": [
        "/path/to/ts-php-debug-mcp/dist/index.js",
        "--config", "/path/to/php-project/config.php.json",
        "--mode", "plan", "--allow-command-trigger",
        "--runs-dir", "/path/to/php-project/.php-debug-plan/runs"
      ]
    }
  }
}
```

Then call the tool:

```bash
npx @modelcontextprotocol/inspector --cli \
  --config inspector.mcp.json --server php-debug-plan \
  --cwd /path/to/php-project \
  --method tools/call --tool-name debug_plan_run \
  --tool-arg path=.claude/debug-plans/my.debugplan.json \
  | jq -r '.content[0].text' | jq '.data | {runId, outcome, expectations, predictions}'
```

- A relative plan path resolves against the server's working directory, which `--cwd` sets.
- Give the server in a config file. Do not give it as a command after the Inspector options: the
  Inspector reads the server's `--config` as its own option and stops with an error.
- Each Inspector call starts a new server process. Only the files in `--runs-dir` stay between
  calls, so a later call can still read the run:
  `--method tools/call --tool-name debug_plan_report --tool-arg runId=<runId>`.
- The same form works for `debug_plan_validate` (`--tool-arg path=…`) and `--method tools/list`.

#### Not available

- **No manual tool call inside Claude Code or Copilot Chat.** Neither client lets you call an MCP
  tool or LM tool yourself: `/mcp` in Claude Code only manages servers, and `#debugPlanRun` in
  Copilot Chat only offers the tool to the model. From those clients, use the CLI (in Claude Code,
  `!node …/dist/plan/cli.js run …`) or the VS Code command.
- **`--via mcp-stdio` and `--via mcp-http` do not call `debug_plan_run`.** They start a normal
  server and send it the step tools one at a time (`debug_launch`, `debug_set_breakpoints`,
  `debug_wait`, `debug_continue`, …). The plan runner stays in the CLI. These options test the
  server's step tools, not its `debug_plan_run` tool.

### Agent skill

[`skills/php-debug-modes/`](skills/php-debug-modes/) is an agent skill that teaches the whole
workflow: choosing a mode, writing and validating a plan, running it, reading the report, and the
traps that actually bite (a breakpoint stops *before* its line; strings render in double quotes; a
plan owns its trigger). Its `references/` carry the full plan schema and a troubleshooting guide for
every outcome and error code.

Install it by copying or symlinking the directory into the project you debug:

```bash
ln -s /absolute/path/to/ts-php-debug-mcp/skills/php-debug-modes \
      your-php-project/.claude/skills/php-debug-modes
```

It works for any surface — the MCP server, the CLI or VS Code — because it teaches the tools and the
plan format, not one client. The MCP prompts `debug_plan` and `debug_react` cover the same ground in
short form for clients that use prompts instead of skills.

### ReAct mode

`debug_snapshot` — and `debug_wait {"snapshot": true}` — observe the paused frame in one call: location, top frames, sticky watch expressions, locals, and a `delta` against the thread's previous snapshot (moved from→to, changed/added/removed locals, changed watches). A step is then two calls: `debug_next`, `debug_wait {"snapshot": true}`. When the agent has its answer it can freeze the decisive observation into a plan and check it with `debug_plan_validate`.

## MCP client configuration

[`mcp.example.json`](mcp.example.json) registers both modes as separate servers — copy it into your
client's config and replace the absolute paths:

```json
{
  "mcpServers": {
    "php-debug": {
      "command": "node",
      "args": [
        "/absolute/path/to/ts-php-debug-mcp/dist/index.js",
        "--config",
        "/absolute/path/to/ts-php-debug-mcp/config.php.local.json"
      ]
    },
    "php-debug-plan": {
      "command": "node",
      "args": [
        "/absolute/path/to/ts-php-debug-mcp/dist/index.js",
        "--config",
        "/absolute/path/to/ts-php-debug-mcp/config.php.local.json",
        "--mode",
        "plan",
        "--allow-command-trigger",
        "--runs-dir",
        "/absolute/path/to/your-php-project/.php-debug-plan/runs"
      ]
    },
    "php-debug-http": {
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

- **`php-debug`** is [ReAct mode](#react-mode): `--mode react` is the default, so the entry is the
  same one as before this feature existed.
- **`php-debug-plan`** is [plan mode](#plan-mode). `--allow-command-trigger` lets a plan spawn the
  process that reproduces the bug — leave it out to allow only HTTP triggers. `--runs-dir` keeps
  each run's `report.json`, `report.normalized.json` and `journal.jsonl` next to the project
  instead of in `$TMPDIR`; committing them (or just the goldens) makes runs reviewable.
- **`php-debug-http`** is the same server over Streamable HTTP, for a client that speaks URLs or a
  server you start yourself (`--transport http --port 3000`, plus `--mode` as needed). Drop this
  entry unless you run one.

Register only the modes you want. Two stdio entries mean two server processes, each with its own
session — they do not share state, and **only one of them can hold the Xdebug port at a time**. If
you want to keep an interactive session open while running plans, give the plan server its own port:
either a second config file with a different `port`, or `"session": { "port": 9013 }` in the plans
themselves.

Where the file goes: `.mcp.json` in the project root for Claude Code, `.kiro/settings/mcp.json` for
Kiro, `claude_desktop_config.json` for Claude Desktop. VS Code's own MCP config uses a different
shape — `servers` instead of `mcpServers`, with an explicit type:

```json
{
  "servers": {
    "php-debug-plan": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/ts-php-debug-mcp/dist/index.js", "--config", "/absolute/path/to/config.php.local.json", "--mode", "plan", "--allow-command-trigger"]
    }
  }
}
```

## Configuration

The server takes a `--config <path>` argument pointing to a JSON file. All fields have defaults.

| Field | Type | Default | Description |
|---|---|---|---|
| `adapterPath` | `string` | bundled `dist/adapter/phpDebug.js` | Override the DAP adapter, e.g. a local vscode-php-debug checkout's `out/phpDebug.js` |
| `port` | `number` | `9003` | Xdebug listen port |
| `hostname` | `string` | `127.0.0.1` | Xdebug listen host |
| `stopOnEntry` | `boolean` | `false` | Break on first line |
| `pathMappings` | `Record<string, string>` | `{}` | Remote → local path map (keys are remote, values are local) |
| `program` | `string` | — | PHP script to execute (CLI debugging) |
| `cwd` | `string` | — | Working directory for CLI script |
| `args` | `string[]` | — | Arguments passed to the PHP script |
| `runtimeExecutable` | `string` | `php` | PHP binary path |
| `runtimeArgs` | `string[]` | — | Extra args for the PHP runtime |
| `env` | `Record<string, string>` | — | Environment variables |
| `envFile` | `string` | — | Path to `.env` file |
| `xdebugSettings` | `object` | — | Xdebug DBGp settings (`max_children`, `max_data`, `max_depth`, etc.) |
| `maxConnections` | `number` | `0` | Max simultaneous Xdebug connections (0 = unlimited) |
| `skipFiles` | `string[]` | — | Glob patterns for files to skip |
| `skipEntryPaths` | `string[]` | — | Entry paths to skip |
| `ignore` | `string[]` | — | Patterns to ignore |
| `ignoreExceptions` | `string[]` | — | Exception classes to ignore |
| `log` | `boolean` | `false` | Enable adapter logging |

## Verbose mode

Use `--verbose <level>` (or `-v <level>`) to control diagnostic output. Verbose messages are sent as MCP log notifications (`notifications/message`) at `debug` level, so they show up in your MCP client's log panel.

| Level | What it shows |
|---|---|
| `0` | (default) Session state changes only |
| `1` | + DAP adapter stderr output |
| `2` | + Full DAP protocol message trace (every request, response, and event) |

```bash
# Adapter stderr forwarding
node dist/index.js --config config.php.local.json --verbose 1

# Full DAP wire trace
node dist/index.js --config config.php.local.json --verbose 2
```

In your MCP client config:

```json
{
  "servers": {
    "php-debug": {
      "command": "node",
      "args": [
        "/path/to/dist/index.js",
        "--config", "/path/to/config.php.local.json",
        "--verbose", "2"
      ]
    }
  }
}
```

Level 2 trace output looks like:

```
→ DAP {"seq":1,"type":"request","command":"initialize","arguments":{...}}
← DAP {"seq":1,"type":"response","command":"initialize","success":true,"body":{...}}
← DAP {"seq":0,"type":"event","event":"initialized"}
→ DAP {"seq":2,"type":"request","command":"launch","arguments":{...}}
```
| `proxy` | `object` | — | DBGp proxy settings (`enable`, `host`, `port`, `key`, etc.) |
| `stream` | `object` | — | Stream settings (`stdout`: 0/1/2) |
| `xdebugCloudToken` | `string` | — | Xdebug Cloud token |

## Example configs

Several example configs are included for common scenarios:

### Local PHP development (`config.php.local.json`)

Simplest setup — PHP and Xdebug run directly on your machine, no path mapping needed.

```json
{
  "port": 9003,
  "stopOnEntry": false,
  "pathMappings": {}
}
```

### Remote / web server (`config.php.json`)

PHP runs on a remote server or VM where paths differ from your local filesystem.

```json
{
  "port": 9003,
  "stopOnEntry": false,
  "pathMappings": {
    "/var/www/html": "/Users/dev/myproject"
  }
}
```

### Docker (`config.php.docker.json`)

Multiple path mappings for a containerized app where source and vendor directories are mounted separately.

```json
{
  "port": 9003,
  "stopOnEntry": false,
  "pathMappings": {
    "/var/www/html/web": "/Users/dev/myproject/web",
    "/var/www/html/vendor": "/Users/dev/myproject/vendor"
  }
}
```

### CLI script (`config.php.cli.json`)

Debug a PHP CLI command (e.g. Symfony console). Uses `program` and `cwd` instead of waiting for an HTTP request.

```json
{
  "port": 9003,
  "stopOnEntry": false,
  "program": "/Users/dev/myproject/bin/console",
  "cwd": "/Users/dev/myproject",
  "pathMappings": {}
}
```

### Test / CI (`config.php.test.json`)

Minimal config for automated testing or CI pipelines.

```json
{
  "port": 9003,
  "stopOnEntry": false,
  "pathMappings": {}
}
```

## Available tools

| Tool | Description |
|---|---|
| `debug_launch` | Start a debug session (initialize → launch → configurationDone) |
| `debug_terminate` | End the debug session |
| `debug_status` | Get current session state, stop reason, adapter status |
| `debug_continue` | Resume execution |
| `debug_next` | Step over (next line) |
| `debug_step_in` | Step into function call |
| `debug_step_out` | Step out of current function |
| `debug_pause` | Pause execution |
| `debug_set_breakpoints` | Set line breakpoints in a source file |
| `debug_set_function_breakpoints` | Set breakpoints on function names |
| `debug_set_exception_breakpoints` | Configure exception breakpoints |
| `debug_evaluate` | Evaluate an expression in the current context |
| `debug_variables` | List variables in a scope |
| `debug_stack_trace` | Get the call stack |
| `debug_scopes` | Get scopes for a stack frame |
| `debug_set_variable` | Modify a variable value |
| `debug_source` | Retrieve source code for a stack frame |
| `debug_threads` | List active threads |
| `debug_exception_info` | Get details about the current exception |
| `debug_import_ide_breakpoints` | Import breakpoints from the IDE (automatic when the VS Code backend is active) |
| `debug_wait` | Block until the next debug event, instead of polling `debug_status`; `snapshot` attaches the stopped frame |
| `debug_snapshot` | Observe the paused frame — location, frames, watches, locals — with a delta against the previous stop (react mode) |
| `debug_plan_validate` | Check a plan without running anything (every mode) |
| `debug_plan_run` | Execute a plan deterministically and return a summary (plan mode) |
| `debug_plan_report` | Read a finished run: one stop, one probe, a section, or the tool-call journal (plan mode) |

`debug_wait` is framework-agnostic (`WaitSignal { aborted, onAbort }`, no `vscode` import), so each front end supplies its own cancellation adapter: an `AbortSignal` over MCP, a `CancellationToken` in the editor. See [`DESIGN.md` §5.4](./DESIGN.md) for the five resolution paths and the buffered-event replay.

> `debug_status`'s `allowedToolsByState` also names `debug_breakpoints_get`, which is backed by the `BreakpointLedger` and therefore exists only in the extension. `handleDebugStatus` filters it out unless the caller passes `{ includeLedgerTools: true }`, so each surface is advertised only the tools it actually registered.

## Development

```bash
npm run build             # compile TypeScript, bundle the adapter
npm test                  # unit and property tests (vitest)
npm run test:watch        # run tests in watch mode
npm run test:e2e          # e2e/plans against real PHP + Xdebug, in-process and over MCP stdio
npm run emit-plan-schema  # regenerate schemas/debug-plan.v1.schema.json after changing src/plan/schema.ts
```

`test:e2e` needs a build and either a host PHP with Xdebug or Docker: [e2e/php.sh](e2e/php.sh) falls back to `ddev/ddev-webserver:v1.25.4` (override with `E2E_PHP_IMAGE`) and maps the container's `/app` back to this package. Each plan must match its golden in `e2e/golden/` on both surfaces; re-record after an intended change with `UPDATE_GOLDEN=1 npm run test:e2e`. [e2e/smoke/drupal.debugplan.json](e2e/smoke/drupal.debugplan.json) is the plan form of `scripts/smoke-http.mjs`, for a ddev Drupal site (`SMOKE_ROOT`, `SMOKE_URL`).

## License

MIT
