"use client";

import { useEffect, useState } from "react";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { sharedGet } from "@/lib/shared-get-cache";
import { PHONE_VERIFIED_EVENT } from "@/lib/vendor-work-number";

/**
 * True while the signed-in vendor has not verified their phone. A verified phone is what a manager's
 * text reaches when the vendor has no routable PropLane number, what the vendor's own number is
 * claimed against, and what links earlier manager conversations into their Communication.
 * Cleared by `profiles.phone_verified_at` (`contact.phoneVerifiedAt` off /api/vendor/profile) -
 * a typed phone never counts. This feeds ONE compact Dashboard attention row (round 5): there is
 * no per-page banner on the other vendor pages, and Settings > Messaging keeps its own prompt.
 */
export function useVendorPhoneNeedsVerification(): boolean {
  const [needsVerification, setNeedsVerification] = useState(false);

  useEffect(() => {
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
    // Verifying in Settings clears the row right away, without waiting out the shared read's TTL.
    const onVerified = () => read(true);
    window.addEventListener(PHONE_VERIFIED_EVENT, onVerified);
    return () => {
      cancelled = true;
      window.removeEventListener(PHONE_VERIFIED_EVENT, onVerified);
    };
  }, []);

  return needsVerification;
}
