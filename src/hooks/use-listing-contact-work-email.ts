"use client";

import { useEffect, useState } from "react";
import { listingCtaEmailAddress } from "@/lib/listing-cta-email";
import { isLiveListingIdForContactSms } from "@/lib/listing-contact-sms";
import {
  isManagerAssistantEmailStatus,
  managerWorkEmailInUse,
} from "@/lib/manager-assistant-email/manager-assistant-email-status";

let publicListingsCache: { at: number; byId: Map<string, string> } | null = null;
const PUBLIC_LISTINGS_CACHE_TTL_MS = 55_000;

async function contactEmailFromPublicCatalog(listingId: string): Promise<string | null> {
  if (publicListingsCache && Date.now() - publicListingsCache.at < PUBLIC_LISTINGS_CACHE_TTL_MS) {
    return publicListingsCache.byId.get(listingId) ?? null;
  }
  try {
    const res = await fetch("/api/property-records/public", { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { listings?: Array<{ id?: string; contactWorkEmail?: string }> };
    const byId = new Map<string, string>();
    for (const listing of body.listings ?? []) {
      const id = listing.id?.trim();
      const email = listingCtaEmailAddress(listing.contactWorkEmail);
      if (id && email) byId.set(id, email);
    }
    publicListingsCache = { at: Date.now(), byId };
    return byId.get(listingId) ?? null;
  } catch {
    return null;
  }
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
