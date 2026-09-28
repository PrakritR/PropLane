"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { isDemoModeActive } from "@/lib/demo/demo-session";

const DISMISSED_KEY = "proplane.vendor-messaging-setup-notice.dismissed";

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Portal-wide "set up your work number" notice — same slot as the manager
 * messaging banner, but on every vendor page (captain, 2026-09-27 studio
 * VD06/VD07/VD60/VD61: "have this top setup show in all tabs"; a prior
 * version deliberately scoped this to two screens after a nag complaint —
 * that decision is superseded). Tracks the real, free, PropLane-provisioned
 * work number (`vendor_work_identities` via `/api/vendor/work-identity`),
 * not the vendor's own free-text `profiles.phone` — claiming a number in
 * Settings > Work number & email is what actually clears this everywhere.
 */
export function VendorMessagingSetupBanner() {
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  const [needsNumber, setNeedsNumber] = useState(false);

  useEffect(() => {
    setDismissed(readDismissed());
  }, []);

  useEffect(() => {
    if (isDemoModeActive()) return;
    let cancelled = false;
    void fetch("/api/vendor/work-identity", { credentials: "include", cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (cancelled || !body || typeof body !== "object") return;
        const value = String((body as { identity?: { sms?: { value?: string | null } } }).identity?.sms?.value ?? "").trim();
        setNeedsNumber(!value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (dismissed !== false) return null;
  if (!needsNumber) return null;

  return (
    <div
      className="flex shrink-0 items-center gap-3 border-b border-border bg-card px-[max(1rem,env(safe-area-inset-left,0px))] py-1 pe-[max(0.5rem,env(safe-area-inset-right,0px))] text-[13px] leading-snug text-foreground lg:px-6"
      data-attr="vendor-messaging-setup-banner"
      role="status"
    >
      <span className="h-5 w-[3px] shrink-0 rounded-full bg-primary" aria-hidden />
      <p className="min-w-0 flex-1 truncate font-medium">Phone number not set up.</p>
      <Link
        href="/vendor/profile?tab=work"
        data-attr="vendor-messaging-setup-banner-link"
        className="inline-flex min-h-11 shrink-0 items-center rounded-full border border-border bg-card px-3 text-[12.5px] font-semibold text-foreground hover:bg-accent/40"
      >
        Set up messaging
      </Link>
      <button
        type="button"
        onClick={() => {
          try {
            window.localStorage.setItem(DISMISSED_KEY, "1");
          } catch {
            /* ignore */
          }
          setDismissed(true);
        }}
        aria-label="Dismiss"
        data-attr="vendor-messaging-setup-banner-dismiss"
        className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted hover:bg-accent/40 hover:text-foreground"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
