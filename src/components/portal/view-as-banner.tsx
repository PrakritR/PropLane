"use client";

import { Eye } from "lucide-react";
import posthog from "posthog-js";
import { useCallback, useEffect, useRef, useState } from "react";
import { clearPortalBrowserCache } from "@/lib/auth/clear-portal-browser-cache";
import { isViewAsExitRequest } from "@/lib/auth/view-as-token";

const PORTAL_LABEL = { manager: "Manager", resident: "Resident", vendor: "Vendor" } as const;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type ViewAsBannerProps = {
  name: string;
  portal: keyof typeof PORTAL_LABEL;
  expiresAtMs: number;
  endHref: string;
};

function minutesLeft(expiresAtMs: number): number {
  return Math.max(0, Math.ceil((expiresAtMs - Date.now()) / 60_000));
}

/**
 * The persistent "Viewing as" bar above the portal's top strip (36px, amber).
 *
 * It is also where the client side of the read-only promise lives. The SERVER
 * is the control (the middleware refuses every non-read request while the
 * session is open); this component only makes that legible: it stamps
 * `data-view-as` on <html> (CSS dims upload and submit controls), turns any
 * same-origin write the page attempts into an instant, explained refusal, and
 * silences product analytics so nothing on screen is captured.
 */
export function ViewAsBanner({ name, portal, expiresAtMs, endHref }: ViewAsBannerProps) {
  const [minutes, setMinutes] = useState(() => minutesLeft(expiresAtMs));
  const [notice, setNotice] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endedRef = useRef(false);

  const end = useCallback(async () => {
    if (endedRef.current) return;
    endedRef.current = true;
    setEnding(true);
    try {
      // DELETE /api/admin/preview is one of the two requests the guard lets through.
      await fetch("/api/admin/preview", { method: "DELETE", credentials: "include" });
    } catch {
      /* the cookie also expires on its own; navigating away still drops the page */
    }
    // The viewed account's rows were cached in this browser under the operator's
    // own keys: drop them so the operator's next page cannot show them.
    clearPortalBrowserCache();
    window.location.assign(endHref);
  }, [endHref]);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-view-as", "true");

    // Nothing on screen is analytics material: stop capture (autocapture reads
    // element text, i.e. the viewed account's names) and recording, and restore
    // exactly what was there when the session ends.
    let optedOutBefore = true;
    try {
      optedOutBefore = posthog.has_opted_out_capturing();
      if (!optedOutBefore) posthog.opt_out_capturing();
      posthog.stopSessionRecording?.();
    } catch {
      /* analytics must never break the portal */
    }

    const realFetch = window.fetch.bind(window);
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = typeof Request !== "undefined" && input instanceof Request ? input : null;
      const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
      let url: URL | null = null;
      try {
        url = new URL(request ? request.url : String(input), window.location.href);
      } catch {
        url = null;
      }
      if (
        url &&
        url.origin === window.location.origin &&
        !SAFE_METHODS.has(method) &&
        !isViewAsExitRequest(method, url.pathname)
      ) {
        setNotice(`Read-only while viewing as ${name}. Nothing was saved.`);
        if (noticeTimer.current) clearTimeout(noticeTimer.current);
        noticeTimer.current = setTimeout(() => setNotice(null), 4000);
        return new Response(JSON.stringify({ error: "read_only_view_as" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
      return realFetch(input, init);
    }) as typeof window.fetch;

    return () => {
      window.fetch = realFetch;
      root.removeAttribute("data-view-as");
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      try {
        if (!optedOutBefore) posthog.opt_in_capturing();
      } catch {
        /* ignore */
      }
    };
  }, [name]);

  useEffect(() => {
    const tick = () => {
      const left = minutesLeft(expiresAtMs);
      setMinutes(left);
      if (left <= 0) void end();
    };
    tick();
    const id = setInterval(tick, 15_000);
    return () => clearInterval(id);
  }, [expiresAtMs, end]);

  return (
    <div
      role="status"
      data-attr="view-as-banner"
      className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--status-pending-fg)]/30 bg-[var(--status-pending-bg)] px-3 text-xs font-medium text-[var(--status-pending-fg)] sm:px-5"
    >
      <Eye className="h-4 w-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">
        {notice ??
          `Viewing as ${name} · ${PORTAL_LABEL[portal]} portal · read-only · ${minutes} min left`}
      </span>
      <button
        type="button"
        data-attr="view-as-end"
        onClick={() => void end()}
        disabled={ending}
        className="shrink-0 rounded-full border border-current px-3 py-0.5 text-xs font-semibold transition-colors hover:bg-[var(--status-pending-fg)]/10 disabled:opacity-60"
      >
        {ending ? "Ending…" : "End"}
      </button>
    </div>
  );
}

