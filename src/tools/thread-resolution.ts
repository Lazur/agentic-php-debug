import type { SessionManager } from '../session.js';

/**
 * Resolve which thread a tool should act on when the caller omitted threadId.
 *
 * Both front ends want the same convenience — an agent that has just been told
 * "paused at line 42" should not have to call debug_threads before every step.
 * It lives here rather than in either caller so the MCP server and the VS Code
 * extension cannot drift apart on what "the current thread" means.
 */

/** Outcome of resolving a thread to act on while suspended. */
export interface ResolvedThread {
  threadId: number;
  /**
   * True when the caller omitted threadId and more than one thread is
   * suspended, so the fallback picked one arbitrarily. Callers surface this —
   * silently guessing between suspended threads produces results that look
   * fine and describe the wrong execution.
   */
  ambiguous: boolean;
}

/**
 * Pick the thread to act on for a tool that requires the session to be paused.
 *
 * Falls back to `session.stopInfo`, which is derived as the most-recently
 * stopped thread that is still suspended. Returns undefined when nothing is
 * suspended, so the caller can report INVALID_PARAMS rather than sending a
 * request the adapter will reject.
 */
export function resolveStoppedThreadId(
  session: SessionManager,
  explicit?: number,
): ResolvedThread | undefined {
  if (explicit !== undefined) return { threadId: explicit, ambiguous: false };

  const threadId = session.stopInfo?.threadId;
  if (threadId === undefined) return undefined;

  return { threadId, ambiguous: session.status.stoppedThreads.length > 1 };
}

/**
 * Pick the thread to act on for a tool that requires the session to be RUNNING
 * (currently only debug_pause).
 *
 * `stopInfo` is useless here: a running session has nothing suspended, so
 * defaulting from it can only ever fail. Fall back to the live connection
 * instead, and only when there is exactly one — with several in flight there is
 * no defensible choice, and pausing the wrong one is worse than asking.
 */
export function resolveRunningThreadId(
  session: SessionManager,
  explicit?: number,
): number | undefined {
  if (explicit !== undefined) return explicit;

  const live = session.status.liveThreadIds;
  return live.length === 1 ? live[0] : undefined;
}

/** Phrase the ambiguity for a tool result, listing the other candidates. */
export function ambiguousThreadNote(session: SessionManager, chosen: number): string {
  const others = session.status.stoppedThreads
    .map((t) => t.threadId)
    .filter((id) => id !== chosen);
  return (
    `threadId was omitted and ${others.length + 1} threads are suspended; acted on thread ${chosen}. ` +
    `Other suspended thread ids: ${others.join(', ')}. Pass threadId explicitly to choose.`
  );
}
