"use client";

import { useEffect, useState } from "react";
import { publicListingContact } from "@/lib/public-listing-contacts";
import { listingCtaEmailAddress } from "@/lib/listing-cta-email";
import { isLiveListingIdForContactSms } from "@/lib/listing-contact-sms";
import {
  isManagerAssistantEmailStatus,
  managerWorkEmailInUse,
} from "@/lib/manager-assistant-email/manager-assistant-email-status";

async function contactEmailFromPublicCatalog(listingId: string): Promise<string | null> {
  return listingCtaEmailAddress((await publicListingContact(listingId))?.contactWorkEmail);
}

/**
 * The signed-in manager's own work email, gated the way the PUBLIC catalog
 * gates it (`resolveActiveManagerWorkEmail`): the deployment can send and
 * receive mail, and the workspace has an address. Deliberately not `canUse`,
 * which also folds in the plan hold — the public page does not, and a draft's
 * Review must show what that page will print, not what Settings says about
 * billing.
 */
async function ownManagerWorkEmail(): Promise<string | null> {
  try {
    const res = await fetch("/api/manager/assistant-email", { credentials: "include", cache: "no-store" });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    if (!isManagerAssistantEmailStatus(data)) return null;
    if (!data.sendingAvailable || !data.receivingAvailable) return null;
    return listingCtaEmailAddress(managerWorkEmailInUse(data));
  } catch {
    return null;
  }
}

/**
 * The email twin of `useListingContactSmsPhone`: the work email a renter sees
 * on the listing's Email button. Live listings read the public catalog, so the
 * manager's preview shows exactly the address the public page will; a draft
 * reads the signed-in manager's own address, and only when the viewer is
 * provably the owner. Returns `null` when there is no usable address.
 */
export function useListingContactWorkEmail(opts: {
  listingId?: string | null;
  ownerManagerUserId?: string | null;
  viewerManagerUserId?: string | null;
  enabled?: boolean;
}): string | null {
  const [email, setEmail] = useState<string | null>(null);
  const enabled = opts.enabled !== false;
  const listingId = opts.listingId?.trim() || null;
  const ownerId = opts.ownerManagerUserId?.trim() || null;
  const viewerId = opts.viewerManagerUserId?.trim() || null;

  useEffect(() => {
    if (!enabled) {
      setEmail(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      if (listingId && isLiveListingIdForContactSms(listingId)) {
        const fromCatalog = await contactEmailFromPublicCatalog(listingId);
        if (!cancelled && fromCatalog) {
          setEmail(fromCatalog);
          return;
        }
      }
      const viewerIsOwner = !ownerId || (Boolean(viewerId) && ownerId === viewerId);
      if (viewerIsOwner) {
        const own = await ownManagerWorkEmail();
        if (!cancelled) setEmail(own);
        return;
      }
      if (!cancelled) setEmail(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, listingId, ownerId, viewerId]);

  return email;
}
