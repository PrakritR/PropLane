"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
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
 * Portal-wide "set up your contact number" notice — same slot as the manager
 * messaging banner. A vendor's number is `profiles.phone`, not a provisioned
 * Twilio line; the copy still matches the manager chrome so the two portals
 * read as one website.
 */
export function VendorMessagingSetupBanner() {
  const pathname = usePathname();
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  const [needsPhone, setNeedsPhone] = useState(false);

  useEffect(() => {
    setDismissed(readDismissed());
  }, []);

  useEffect(() => {
    if (isDemoModeActive()) return;
    let cancelled = false;
    void fetch("/api/vendor/profile", { credentials: "include", cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (cancelled || !body || typeof body !== "object") return;
        const phone = String((body as { contact?: { phone?: string } }).contact?.phone ?? "").trim();
        setNeedsPhone(!phone);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Scoped to the two screens this is actually actionable from — Communication
  // and the vendor's own Settings (where "Set up messaging" lands). Every
  // other page (a vendor's own Calendar included) used to carry this as a nag
  // that reappeared on every navigation (AXI night sweep area 2d).
  const onCommunication = Boolean(pathname?.startsWith("/vendor/communication"));
  const onSettings = Boolean(pathname?.startsWith("/vendor/profile"));
  if (!onCommunication && !onSettings) return null;
  if (dismissed !== false) return null;
  if (!needsPhone) return null;

  return (
    <div
      className="flex shrink-0 items-center gap-3 border-b border-border bg-card px-[max(1rem,env(safe-area-inset-left,0px))] py-1 pe-[max(0.5rem,env(safe-area-inset-right,0px))] text-[13px] leading-snug text-foreground lg:px-6"
      data-attr="vendor-messaging-setup-banner"
      role="status"
    >
      <span className="h-5 w-[3px] shrink-0 rounded-full bg-primary" aria-hidden />
      <p className="min-w-0 flex-1 truncate font-medium">Phone number not set up.</p>
      <Link
        href="/vendor/profile"
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
