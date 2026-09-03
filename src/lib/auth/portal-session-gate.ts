"use client";

/**
 * A tiny client-side latch so the portal's background sync loaders stop firing
 * once the session is gone.
 *
 * The portal runs several independent sync loaders (applications, inbox threads,
 * lease pipeline, household charges, schedule records), each on its own interval
 * or store event. None of them knew about sign-out, so after the session ended
 * they all kept polling and each answered 401 — five failed authenticated
 * requests per cycle, and a console full of errors, for as long as the tab
 * stayed open.
 *
 * This is deliberately a module-global latch rather than React state: the
 * loaders are plain functions in `src/lib`, called from many components, and
 * they need the answer without a hook. It is advisory — the server is still the
 * authority on every request; this only stops pointless ones.
 */

let sessionKnownGone = false;

/**
 * The signed-in user id, as a plain module-global so the portal's client-side
 * caches can tell one account's data from the next WITHOUT a React hook.
 *
 * This exists because those caches are keyed only by what they hold (e.g. the
 * inbox scope `axis_portal_inbox_manager_v1`), which is byte-identical for every
 * manager. A module-global Map plus `sessionStorage` therefore survives a
 * sign-out / sign-in inside one tab and hands the SECOND account the FIRST
 * account's rows — for the inbox that meant a brand-new account reading someone
 * else's messages on first paint, before any server fetch could correct it. The
 * server routes were always scoped correctly; the leak was entirely client-side.
 *
 * `use-portal-session.ts` owns the Supabase subscription and pushes every change
 * here, so the dependency runs hooks -> lib and never the other way round.
 */
let viewerId: string | null = null;
const viewerChangeListeners = new Set<(next: string | null) => void>();

/** The current viewer, or null before the session resolves / after sign-out. */
export function portalSessionViewerId(): string | null {
  return viewerId;
}

/** Called by the portal session store on every auth state change. */
export function setPortalSessionViewer(next: string | null): void {
  const normalized = String(next ?? "").trim() || null;
  if (normalized === viewerId) return;
  viewerId = normalized;
  for (const listener of viewerChangeListeners) {
    try {
      listener(normalized);
    } catch {
      /* a bad listener must not break sign-in */
    }
  }
}

/**
 * Subscribe to identity changes so a cache can drop everything it holds for the
 * previous account. Returns an unsubscribe function.
 */
export function onPortalSessionViewerChange(listener: (next: string | null) => void): () => void {
  viewerChangeListeners.add(listener);
  return () => {
    viewerChangeListeners.delete(listener);
  };
}

/** Called when an authenticated portal fetch comes back 401. */
export function markPortalSessionEnded(): void {
  sessionKnownGone = true;
}

/** Called on a successful sign-in so a new session resumes syncing. */
export function markPortalSessionActive(): void {
  sessionKnownGone = false;
}

/** True once a 401 has been seen and no new sign-in has happened since. */
export function portalSessionEnded(): boolean {
  return sessionKnownGone;
}

/**
 * Records a 401 from a portal fetch and reports whether the caller should stop.
 * Any other status (including network errors, which callers handle themselves)
 * leaves the latch alone — a flaky connection is not a sign-out.
 */
export function notePortalResponse(status: number): void {
  if (status === 401) markPortalSessionEnded();
}
