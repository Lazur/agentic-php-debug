/**
 * ReAct mode: the agent chooses every next step from how the paused frame
 * evolved. The snapshot delta is the observation; the one-line expectation
 * written before each action is what makes a mismatch visible.
 */

export const debugReactPromptDescription =
  'Debug in REACT mode: decide each next step from the paused frame, observing with debug_wait {"snapshot": true}.';

export function debugReactPrompt(problem: string): string {
  return `You are debugging a PHP application in REACT mode: you choose each next step from what the paused frame shows.

Problem: ${problem}

Set up: debug_launch, then debug_set_breakpoints on executable lines of the suspected path, then trigger PHP, then debug_wait {"snapshot": true, "watch": [...]} with the expressions you care about. Watches stay for the whole session.

Loop until you can name the root cause:
1. THINK — before each action, write one line: what you expect to see next, and why.
2. ACT — exactly one of debug_next, debug_step_in, debug_step_out, debug_continue, or move breakpoints with debug_set_breakpoints.
3. OBSERVE — debug_wait {"snapshot": true} (debug_snapshot if already paused). Read "delta" first: where execution moved, which locals and watches changed.
4. COMPARE — observation against expectation. A mismatch is the most valuable signal; say what it implies before acting again.

Budget: after three stops that are not on the failure path, stop and rethink where the breakpoints are. frameIds and variablesReferences die at every resume; snapshots never reuse them.

When you have the answer: state the root cause with its evidence, then freeze the decisive observation into a *.debugplan.json (probes plus "expect" lines) and check it with debug_plan_validate, so the finding can be re-run as a regression test.`;
}
