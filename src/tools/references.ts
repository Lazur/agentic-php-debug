import type { SessionManager } from '../session.js';
import { StaleReferenceError } from './errors.js';

/**
 * Reject a frameId the agent obtained during an earlier suspension.
 *
 * Fail-open by construction: a reference this server never issued is passed
 * straight through, so this can raise a false positive only if the session
 * mis-tracks its own hand-outs.
 */
export function assertFreshFrameId(session: SessionManager, frameId: number): void {
  const issued = session.staleFrameSuspension(frameId);
  if (issued !== undefined) {
    throw new StaleReferenceError('frameId', frameId, issued, session.suspensionId);
  }
}

/** As {@link assertFreshFrameId}, for a variablesReference. */
export function assertFreshVariablesReference(session: SessionManager, ref: number): void {
  const issued = session.staleVariablesReferenceSuspension(ref);
  if (issued !== undefined) {
    throw new StaleReferenceError('variablesReference', ref, issued, session.suspensionId);
  }
}
