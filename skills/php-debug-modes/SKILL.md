---
name: php-debug-modes
description: >-
  Debug running PHP with the Xdebug MCP tools in the right mode — plan mode (write a *.debugplan.json
  up front, run it whole with debug_plan_run, reason from the report) or ReAct mode (step with
  debug_next/debug_continue and observe with debug_wait {"snapshot": true}). Use this whenever a PHP
  value, exception or code path has to be explained at runtime rather than guessed from source:
  writing, validating or fixing a debug plan, running php-debug-plan, reading a run report or golden
  diff, deciding why a breakpoint never hit or why Xdebug never connected, or picking between the two
  modes. Use it even when the request only says "why is $x wrong", "debug this failing request" or
  "step through this function" and never mentions plans or modes.
---

# Debugging PHP: plan mode and ReAct mode

Two ways to drive the same debug session. Choosing deliberately is most of the value here: plan mode
buys reproducibility and costs a round of writing; ReAct mode buys adaptivity and costs a model call
per step, with PHP sitting paused the whole time (php-fpm timeouts keep ticking).

## Pick a mode

**Plan mode** — you can name a trigger (a command or an HTTP request) *and* at least one suspect
line. The plan runs with nobody in the loop, so hundreds of breakpoint hits cost nothing, and the
same file re-runs later to prove a fix or to catch a regression.

**ReAct mode** — you do not know where to look yet and need to walk the code, the trigger is a
person clicking in a browser, or you are following a value across frames and each step depends on
the last.

A good default: reach for plan mode, and drop to ReAct when a run comes back inconclusive about
*where* to look. When ReAct finds the answer, freeze it into a plan so the finding survives.

The server decides which tools exist, so let the surface tell you the mode: no `debug_plan_run`
means ReAct mode; no `debug_next`/`debug_continue` means plan mode. In plan mode there is no way to
revise a plan mid-run, by design — that is what makes the run reproducible. Call `debug_status`
first if you are unsure; its `allowedTools` names what is registered.

## Plan mode

Four phases, in order. The skeleton never changes; only the plan's content does.

### 1. Write the plan

Read the code first, then write `*.debugplan.json` (the editor validates it against the schema).
A compact example:

```jsonc
{
  "version": 1,
  "name": "cart-rounding",
  "goal": "Is 1.115 × 3 rounded up to 3.35 or down to 3.34 before it is summed?",
  "hypotheses": [
    { "id": "H1", "basis": "lineTotal() rounds each line with round($raw, 2)",
      "claim": "the first line rounds half up to 3.35",
      "predicts": [{ "probe": "line-total", "hit": 1, "expr": "$rounded", "equals": "3.35" }] },
    { "id": "H2", "basis": "in binary 1.115 × 3 is 3.3449999…, just under the midpoint",
      "claim": "it rounds down to 3.34",
      "predicts": [{ "probe": "line-total", "hit": 1, "expr": "$rounded", "equals": "3.34" }] }
  ],
  "trigger": { "kind": "command", "argv": ["php", "bin/cart.php", "3"] },
  "probes": [
    { "id": "line-total", "file": "src/Cart.php", "line": 26, "tests": ["H1", "H2"],
      "capture": { "stack": 3, "evaluate": ["$price", "$qty", "$raw", "$rounded"] } }
  ],
  "expect": [{ "probe": "line-total", "hits": 3 }, { "outcome": "completed" }]
}
```

What earns its place in a plan:

- **Two or more competing hypotheses**, each with the evidence behind it (`basis`), the belief
  (`claim`), and `predicts` the run can check. A probe is worth setting when its observation would
  confirm one hypothesis and refute another — link them with `tests`. One hypothesis and a probe
  that "has a look around" produces a report nobody can draw a conclusion from.
- **Probes on executable statements.** A breakpoint on a blank line, a comment, a lone brace or a
  `function` signature is accepted by the adapter and then never hits. Validation warns; believe it.
- **The line *after* the assignment you care about.** A breakpoint stops *before* its line runs, so
  probing `$rounded = round(...)` captures `$rounded` from the previous iteration, or nothing at all.
- **Narrow captures.** `evaluate` the handful of expressions your predictions need. Reach for
  `locals` only when you cannot name what to ask for; it is a dump, and dumps are where runs get
  slow and reports get unreadable.
- **A trigger the run owns.** `{"kind": "command", "argv": [...]}` or `{"kind": "http", "url": ...}`.
  `manual` waits for a person — legitimate when only a human can reproduce it, but that run cannot
  be repeated, so do not build a regression test on it.
- **Budgets on hot paths.** `maxCaptures` counts further hits without inspecting them; `condition`
  and `hitCondition` keep a loop body from stopping 500 times.
- **`expect` lines** for the facts that should hold. They turn the plan into a regression test and
  give the analysis phase an objective yes/no.

Two rendering details that cause most false "wrong value" conclusions: strings come back in double
quotes (`"n/a"`, so `"equals": "\"n/a\""`), and an object renders as its class name — evaluate a
property, or `var_export($x, true)`, to see inside it.

`references/plan-schema.md` has every field, its default and more examples (HTTP triggers, exception
and function probes, path mappings, redaction).

### 2. Validate

`debug_plan_validate` with the inline plan or `{"path": "..."}`. Fix every error — nothing has run
yet. Read the warnings too: a non-executable line or an untested hypothesis is usually a real
mistake, not noise.

### 3. Run

`debug_plan_run`, once, and nothing else while it runs. It launches, arms every probe *before* PHP
starts, fires the trigger, captures each hit, continues, and tears the session down.

### 4. Analyse

Reason only from the report. `debug_plan_report` fetches what the summary left out: one stop in full
(`{"stop": 3}`), every hit of a probe (`{"probe": "line-total"}`), or the `journal` of tool calls.

Answer with the verdict table first, because it shows what the evidence settled:

| Hypothesis | Prediction | Observed | Verdict |
|---|---|---|---|
| H1 | `$rounded` = 3.35 at hit 1 | 3.34 | refuted |
| H2 | `$rounded` = 3.34 at hit 1 | 3.34 | supported |

Then the root cause with the stop numbers and values that prove it, and then either the fix or a
**new** plan targeting what is still unknown. Never ask to change a run in progress; there is no
such thing. If the question now needs line-by-line walking, say so and switch to ReAct.

## ReAct mode

Arm first, trigger second: breakpoints registered while the session is `listening` are replayed onto
the Xdebug connection before PHP executes a line, so `debug_launch` → `debug_set_breakpoints` →
trigger → `debug_wait` is the order that reliably catches the first hit.

Then loop:

1. **Expect** — one line: what you think the next observation will show, and why.
2. **Act** — exactly one of `debug_next`, `debug_step_in`, `debug_step_out`, `debug_continue`, or
   move the breakpoints.
3. **Observe** — `debug_wait {"snapshot": true}` (or `debug_snapshot` when already paused). Read
   `delta` first: where execution moved, which locals and watches changed, whether `frameChanged`
   says you entered or left a function.
4. **Compare** — expectation against observation. A mismatch is the most valuable event in the loop;
   say what it implies before acting again.

Add the expressions you care about once with `"watch": [...]`; they stay for the session. Snapshots
re-read frames for you, which matters because `frameId` and `variablesReference` die at every resume
— reusing one is rejected as `STALE_REFERENCE`, and that guard is working as intended.

Budget: after about three stops that are not on the failure path, stop stepping and reconsider where
the breakpoints are. Stepping through a hot loop to reach a failure is the most common way to burn a
session. When an exception is involved and the throw site is unknown, `debug_set_exception_breakpoints`
with `["Exception"]` reaches it in one trigger instead of a bisect.

When you have the answer, write the decisive observation as a plan (probes on the lines that proved
it, `expect` lines for the values) and check it with `debug_plan_validate`. That is how an
interactive session becomes something anyone can re-run.

## When a run does not do what you expected

Read the outcome before the stops — it says what ended the run:

| Outcome | What it means | First thing to check |
|---|---|---|
| `completed` | the trigger finished and every connection closed | — |
| `no_connection` | PHP never dialled in | does the trigger really run PHP with Xdebug, at this port? |
| `timeout` / `max_stops` | the run hit `limits` | a loop stopping more than expected, or a trigger that never finishes |
| `failed` | it stopped before or during execution | `errors[]`: `BREAKPOINT_NOT_ARMED`, `NOT_LISTENING`, `SESSION_BUSY`, `ADAPTER_EXITED` |
| `cancelled` | somebody cancelled it | — |

A probe with `hits: 0` in an otherwise healthy run is nearly always a non-executable line, a path
that never ran, or a condition that was never true. `references/troubleshooting.md` covers each code
and the fixes, plus what to do when a re-run no longer matches its golden file.

## Where the modes live

- **MCP server** — `--mode react` (default), `--mode plan`, `--mode all`. Plans may spawn processes
  only when the server was started with `--allow-command-trigger`. The prompts `debug_plan` and
  `debug_react` carry the same workflow as this skill; the plan schema is published as the resource
  `php-debug://schemas/debug-plan.v1.json`.
- **Terminal, no agent** — `php-debug-plan run plan.json [--via in-process|mcp-stdio] [--golden f]`.
  Exit codes: 0 pass, 1 expectation or golden mismatch, 2 invalid plan, 3 run failed. `--via
  mcp-stdio` drives the MCP server itself, which is how the same plan tests the server.
- **VS Code** — the `DebugPlanner` and `DebugAgent` custom agents, and the command
  *Agentic Debug: Run Debug Plan…* for running a plan file with no agent at all.
