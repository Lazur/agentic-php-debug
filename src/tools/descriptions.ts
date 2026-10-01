// Barrel file: re-exports every model-facing description constant.
//
// These strings are the prose an LLM reads to decide when and how to call a
// tool, and they carry hard-won operational guidance (breakpoint hit-count
// resets, staged-vs-applied writes, DAP_TIMEOUT semantics, buffered event
// replay). The VS Code extension's package.json used to keep hand-copied
// versions that silently rotted; scripts/sync-schemas.ts now generates
// `modelDescription` from here so there is exactly one copy.

export { debugLaunchDescription } from './debug-launch.js';
export { debugTerminateDescription } from './debug-terminate.js';
export { debugStatusDescription } from './debug-status.js';
export { debugWaitDescription } from './debug-wait.js';
export { debugEvaluateDescription } from './debug-evaluate.js';
export { debugThreadsDescription } from './debug-threads.js';
export { debugContinueDescription } from './debug-continue.js';
export { debugNextDescription } from './debug-next.js';
export { debugStepInDescription } from './debug-step-in.js';
export { debugStepOutDescription } from './debug-step-out.js';
export { debugPauseDescription } from './debug-pause.js';
export { debugSetBreakpointsDescription } from './debug-set-breakpoints.js';
export { debugVariablesDescription } from './debug-variables.js';
export { debugStackTraceDescription } from './debug-stack-trace.js';
export { debugScopesDescription } from './debug-scopes.js';
export { debugSetVariableDescription } from './debug-set-variable.js';
export { debugSourceDescription } from './debug-source.js';
export { debugExceptionInfoDescription } from './debug-exception-info.js';
export { debugSetExceptionBreakpointsDescription } from './debug-set-exception-breakpoints.js';
export { debugSetFunctionBreakpointsDescription } from './debug-set-function-breakpoints.js';
export { debugImportIdeBreakpointsDescription } from './debug-import-ide-breakpoints.js';
export { debugSnapshotDescription } from './debug-snapshot.js';
export { debugPlanValidateDescription } from './debug-plan-validate.js';
export { debugPlanRunDescription } from './debug-plan-run.js';
export { debugPlanReportDescription } from './debug-plan-report.js';
