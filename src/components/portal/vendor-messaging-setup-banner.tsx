"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { isDemoModeActive } from "@/lib/demo/demo-session";

const DISMISSED_KEY = "proplane.vendor-verify-phone-notice.dismissed";

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Portal-wide "verify your phone" notice, in the slot the retired "set up your
 * work number" notice used. Vendors have no PropLane number (Oct 6): managers
 * text the vendor's own phone from their work number, and those conversations
 * (earlier ones included) show up here once the vendor verifies that phone with
 * a code. Cleared by `profiles.phone_verified_at` - a typed phone never counts.
 */
export function VendorMessagingSetupBanner() {
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  const [needsVerification, setNeedsVerification] = useState(false);

  useEffect(() => {
    setDismissed(readDismissed());
  }, []);

  useEffect(() => {
    if (isDemoModeActive()) return;
    let cancelled = false;
    void fetch("/api/manager/phone", { credentials: "include", cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (cancelled || !body || typeof body !== "object") return;
        setNeedsVerification(!(body as { phoneVerifiedAt?: string | null }).phoneVerifiedAt);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (dismissed !== false) return null;
  if (!needsVerification) return null;

  return (
    <div
      className="flex shrink-0 items-center gap-3 border-b border-border bg-card px-[max(1rem,env(safe-area-inset-left,0px))] py-1 pe-[max(0.5rem,env(safe-area-inset-right,0px))] text-[13px] leading-snug text-foreground lg:px-6"
      data-attr="vendor-messaging-setup-banner"
      role="status"
    >
      <span className="h-5 w-[3px] shrink-0 rounded-full bg-primary" aria-hidden />
      <p className="min-w-0 flex-1 truncate font-medium">Verify your phone to get your texts from managers.</p>
      <Link
        href="/vendor/profile?tab=messaging"
        data-attr="vendor-messaging-setup-banner-link"
        className="inline-flex min-h-11 shrink-0 items-center rounded-full border border-border bg-card px-3 text-[12.5px] font-semibold text-foreground hover:bg-accent/40"
      >
        Verify phone
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
