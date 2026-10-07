"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { sharedGet } from "@/lib/shared-get-cache";
import { PHONE_VERIFIED_EVENT } from "@/lib/vendor-work-number";

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
    // A dismissed banner never renders again, so it never needs the answer: skip the request on
    // every vendor page for a vendor who dismissed it (`null` = localStorage not read yet).
    if (dismissed !== false) return;
    if (isDemoModeActive()) return;
    let cancelled = false;
    const read = (force: boolean) => {
      void sharedGet("/api/vendor/profile", force ? { force: true } : undefined).then((result) => {
        if (cancelled || !result.ok || !result.data || typeof result.data !== "object") return;
        const contact = (result.data as { contact?: { phoneVerifiedAt?: string | null } }).contact;
        setNeedsVerification(!contact?.phoneVerifiedAt);
      });
    };
    read(false);
    // Verifying in Settings hides the banner right away, without waiting out the shared read's TTL.
    const onVerified = () => read(true);
    window.addEventListener(PHONE_VERIFIED_EVENT, onVerified);
    return () => {
      cancelled = true;
      window.removeEventListener(PHONE_VERIFIED_EVENT, onVerified);
    };
  }, [dismissed]);

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
