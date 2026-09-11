"use client";

import { useEffect } from "react";
import { ApplyLoadingCover } from "./apply-loading-cover";

/**
 * The signed-in resident's hand-off from the public apply link into the portal.
 *
 * `redirect()` cannot do this job here. The decision needs an authenticated role
 * lookup, and by the time it resolves the response has already begun streaming,
 * so Next can no longer answer with a 307 — it serialises the redirect into the
 * stream as client recovery (`NEXT_REDIRECT … "Switched to client rendering"`)
 * and the browser performs it after hydration. Measured on a manager's
 * application link, that left the resident looking at the PUBLIC MARKETING SITE
 * — navbar, footer, an empty content skeleton — for ~600ms before the whole
 * document reloaded into the portal. That is the "opens, goes back, then opens
 * again" in the report.
 *
 * The cover, shared with the route's loading fallback, is what closes that gap:
 * the marketing site is never on screen, so the trip reads as one slow open
 * rather than a page that reset itself. The second document load is still there
 * — only deciding before render (in middleware) removes it.
 *
 * `replace`, never `assign`: the public URL must not become a history entry, or
 * Back out of the portal lands here and is immediately sent forward again.
 */
export function ApplyPortalHandoff({ href }: { href: string }) {
  useEffect(() => {
    window.location.replace(href);
  }, [href]);

  return (
    <ApplyLoadingCover>
      {/* Without JavaScript the hand-off still has to complete. */}
      <noscript>
        <a className="text-sm font-semibold text-primary underline underline-offset-4" href={href}>
          Continue to your application
        </a>
      </noscript>
    </ApplyLoadingCover>
  );
}
