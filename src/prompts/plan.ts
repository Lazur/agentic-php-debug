/**
 * Plan mode: the agent writes the whole investigation before anything runs.
 *
 * The phase skeleton is fixed and the model never rewrites it; what the model
 * decides is the plan's content. Competing hypotheses with predictions come
 * first, so each probe has to earn its place by discriminating between them.
 */

export const debugPlanPromptDescription =
  'Debug in PLAN mode: write a plan before anything runs, execute it whole with debug_plan_run, then analyse the report.';

export function debugPlanPrompt(problem: string): string {
  return `You are debugging a PHP application in PLAN mode. A plan you write BEFORE anything executes is run whole by the debugger; nothing in it can change while it runs. Work through four phases in order.

Problem: ${problem}

1. PLAN — read the code first. Write at least two competing hypotheses, each with the evidence behind it ("basis"), what you believe ("claim"), and "predicts": observations the run can check. Then choose probes that DISCRIMINATE between them: a probe earns its place only if what it observes would confirm one hypothesis and refute another.
   - Put probes on executable statements: the first statement of a block, never a brace, a comment or a blank line.
   - Capture narrowly: "evaluate" the expressions your predictions need; dump "locals" only when you do not yet know what to ask.
   - When the failure is a throw and you do not know where, use "exceptions": {"filters": ["Exception"]}.
   - Give the plan a trigger that reproduces the problem: {"kind": "command", "argv": [...]} for a script, {"kind": "http", "url": ...} for a request.
   - Add "expect" lines for the facts that should hold, so the plan can be re-run as a regression test.
2. VALIDATE — call debug_plan_validate, inline or with the path of a *.debugplan.json file you wrote. Fix every error and read every warning.
3. EXECUTE — call debug_plan_run once, and nothing else while it runs.
4. ANALYSE — reason ONLY from the returned report, using debug_plan_report {"runId": ...} for frames, locals or the tool-call journal. Answer with:
   | Hypothesis | Prediction | Observed | Verdict |
   then the root cause with the evidence that proves it, then either the fix or — when the evidence is not conclusive — a NEW plan that targets what is still unknown. Never ask to change a run in progress.

The plan format is the input schema of debug_plan_run, also published as the resource php-debug://schemas/debug-plan.v1.json.`;
}
