# When a debug run does not do what you expected

Read the outcome first, then `errors[]`, then the stops. Every failure below reports itself — none
of them require guessing.

- [Run outcomes](#run-outcomes)
- [Errors during initialize](#errors-during-initialize)
- [Errors during execute](#errors-during-execute)
- [A probe never hit](#a-probe-never-hit)
- [Values that look wrong](#values-that-look-wrong)
- [Golden mismatches](#golden-mismatches)
- [Artifacts](#artifacts)
- [ReAct-mode symptoms](#react-mode-symptoms)

## Run outcomes

| Outcome | Meaning |
|---|---|
| `completed` | the trigger finished, every Xdebug connection closed, and the session was torn down |
| `no_connection` | the trigger ran (or the wait elapsed) and Xdebug never dialled in |
| `timeout` | `limits.timeoutMs` elapsed first |
| `max_stops` | `limits.maxStops` stops were handled |
| `cancelled` | the caller cancelled; teardown still ran |
| `failed` | the run stopped before or during execution; `errors[]` says why |

`outcomeDetail` is a sentence explaining the outcome — read it before theorising.

## Errors during initialize

**`SESSION_BUSY`** — a debug session is already live, and a plan run never takes one over (it could
be a developer's interactive session). Terminate it, or run the plan against a server in plan mode
that has its own process.

**`NOT_LISTENING`** — an Xdebug connection already existed when the probes were armed, so the run
would be racing a script that is already executing. The usual cause is a server config with
`program`/`runtimeArgs`: that makes the adapter start PHP during launch, before any breakpoint
exists. Remove it and start PHP from the plan's trigger.

**`BREAKPOINT_NOT_ARMED`** — a breakpoint did not come back `pending_connection`, so it was not
registered before PHP started. The message names the probe and the status the adapter returned.
Treat it as a hard stop: a run that continued here would report "0 hits" for a line that does
execute, which is worse than failing.

**`DAP_ERROR` from `debug_launch`** — usually the listen port. "Port 9003 is already in use" means
another session (or another plan server) holds it; pick a different `session.port`, or stop the
other one.

## Errors during execute

**`no_connection`** — work down this list:

1. Does the trigger actually run PHP? Check `trigger.exitCode` and `stderrTail` in the report.
2. Does that PHP have Xdebug loaded? `php -m | grep xdebug`. Many images ship it installed but not
   enabled, and need `-dzend_extension=xdebug.so`.
3. Does it start a debug session? Either `xdebug.start_with_request=yes`, or `XDEBUG_TRIGGER` /
   `XDEBUG_SESSION` (the runner injects these for a local `command` trigger with `xdebugEnv`).
4. Can it reach the listen port? A container needs a routable host (`host.docker.internal` on
   Docker Desktop) and the matching `client_port`; `xdebugEnv` cannot help across that boundary.
5. For an HTTP trigger, does the request carry the `XDEBUG_SESSION` cookie (`xdebugCookie`), and
   does the web server run the PHP you think it does?

**`ADAPTER_EXITED`** — the debug adapter died mid-run. Look at the run's `output` (the adapter's own
channel) and at the Node version; this is an adapter or environment problem, not a plan problem.

**`NOT_RESUMED`** — a thread stayed suspended after two `debug_continue` attempts. Rare: it means
the adapter accepted the continuation and the engine did not move. The session is torn down; re-run.

**`UNMATCHED_STOP`** — only with `onUnmatchedStop: "abort"`. Something stopped execution that no
probe explains, nearly always an editor breakpoint left in a probed file. Switch to `record` (the
default) to keep going and see it in the timeline.

## A probe never hit

`probes.<id>.hits` is 0 in an otherwise healthy run:

- **The line is not executable.** Blank lines, comments, `}`, attribute lines and `function`
  signatures verify and never fire. Validation warns about this — check the warnings in the report.
- **The path never ran.** Confirm with a probe higher up the call chain, or an exception probe.
- **A `condition` was never true**, or `hitCondition` skipped every hit.
- **Path mapping.** If the run stops nowhere at all and the trigger runs PHP somewhere else (a
  container, a VM), `session.pathMappings` is the first suspect: without it the adapter registers
  breakpoints for paths the engine never sees.

## Values that look wrong

- **`[redacted]`** — the name matched the redaction list. Rename the variable in the expression, or
  narrow `redact.names` in the plan.
- **A value from the previous iteration, or nothing.** A breakpoint stops *before* its line runs.
  Probe the line after the assignment.
- **`!DAP_ERROR` or `error` on an evaluated expression** — the expression did not evaluate in that
  frame. Check the frame (`"frame": 1` evaluates in the caller) and that the variable is in scope
  there.
- **An object shows only a class name.** That is the rendering; evaluate a property or
  `var_export($x, true)`.
- **A string comparison fails on quotes.** Strings render in double quotes: `"equals": "\"n/a\""`.

## Golden mismatches

`--golden` compares the *normalized* report: ids, timings, thread numbers, the surface it ran on,
`volatile` expressions and paths under the plan root are removed, so what remains is behaviour.

- **`planChanged: true`** in the comparison means the golden was recorded from a different version
  of the plan (the hash differs). Re-record it deliberately (`--update-golden`) rather than reading
  the diff as a behaviour change.
- **A diff in `stops[...]`** is a real behavioural difference: the application, the adapter or the
  MCP layer now does something else. The `journal.jsonl` for the run shows every tool call and its
  result, which is where you find out which of the three changed.
- **Non-deterministic values** (a clock, a random id, a timestamp in a payload) belong in
  `{"expr": "...", "volatile": true}` so they stay captured but out of the comparison.

## Artifacts

Each run writes `report.json`, `report.normalized.json` and `journal.jsonl`:

- MCP server: under `--runs-dir` (default `$TMPDIR/agentic-php-debug/runs`), and readable as
  `php-debug://runs/{runId}/{report,journal,normalized}`.
- CLI: `--out`, else `./.php-debug-plan/runs/<runId>/`.
- VS Code: `<workspace>/.agentic-debug/runs/<runId>/`.

`debug_plan_report` reads the same data through tools: `{"stop": 3}`, `{"probe": "id"}`, or
`{"section": "journal" | "breakpoints" | "trigger" | "expectations" | "output" | "errors" |
"normalized"}` with `offset`/`limit`.

## ReAct-mode symptoms

- **`STALE_REFERENCE`** — a `frameId` or `variablesReference` from an earlier suspension. The guard
  is doing its job: object references die at every resume. Take a snapshot, which re-reads frames.
- **`debug_wait` returns `already_paused` immediately** — something is still suspended, possibly
  another thread. `debug_status` lists `stoppedThreads`; act on one explicitly with `threadId`.
- **`debug_wait` times out while the editor shows a pause** — check `debug_status`: a timeout is not
  an error, and buffered events are replayed one per call.
- **Several threads stop at once** — one Xdebug connection is one "thread", and parallel requests
  (AJAX, queue workers) each get one. Continue the ones that are not on the failure path quickly, or
  set `maxConnections: 1` in the server config.
- **`debug_pause` fails** — Xdebug can only honour it through its control socket: Linux or Windows
  with Xdebug ≥ 3.5, never macOS. Use a breakpoint or an exception breakpoint instead.
