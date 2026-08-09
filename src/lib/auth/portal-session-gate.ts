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
