import {
  onPortalSessionViewerChange,
  portalSessionViewerId,
} from "@/lib/auth/portal-session-gate";
import { isDemoModeActive } from "@/lib/demo/demo-session";

/**
 * A server-provided viewer can render before the client cache viewer hydrates.
 * Permit that one null -> intended-viewer transition, but never revive an
 * initial request after another account (including an A -> B -> A cycle).
 * This observes identity; it must not set the shared cache's viewer itself.
 */
export function observeCommunicationInitialViewer(viewerId: string) {
  // Demo's synthetic viewer deliberately does not own the authenticated cache.
  if (isDemoModeActive()) return { isCurrent: () => true, canRetry: () => false, dispose: () => {} };
  const initialViewer = portalSessionViewerId();
  let invalidated = initialViewer !== null && initialViewer !== viewerId;
  const unsubscribe = onPortalSessionViewerChange((next) => {
    if (next !== viewerId) invalidated = true;
  });
  return {
    isCurrent: () => !invalidated,
    canRetry: () => !invalidated && portalSessionViewerId() === viewerId,
    dispose: unsubscribe,
  };
}

/** Retry only a stale cache result, once, through its normal coalesced loader. */
export async function retryStaleCommunicationSource<T extends { stale?: boolean }>(
  load: () => Promise<T>,
  canRetry: () => boolean,
): Promise<T> {
  const result = await load();
  return result.stale && canRetry() ? load() : result;
}
