"use client";

import { useEffect, useState } from "react";
import { publicListingContact } from "@/lib/public-listing-contacts";
import { listingCtaSmsPhone } from "@/lib/claw-leasing-links";
import { isLiveListingIdForContactSms } from "@/lib/listing-contact-sms";

async function contactSmsFromPublicCatalog(listingId: string): Promise<string | null> {
  return listingCtaSmsPhone((await publicListingContact(listingId))?.contactSmsPhone);
}

/**
 * The signed-in manager's own CTA number, already resolved server-side by
 * `resolveListingCtaSmsPhone` — production returns their verified personal
 * phone, dev/preview the shared Claw line. `workNumber` is the pre-split
 * fallback for a deploy whose API has not shipped `listingCtaPhone` yet, so it
 * is only consulted when the key is ABSENT: an explicit `null` means the server
 * decided this manager has no usable CTA number, and falling through to
 * `workNumber` there would text the shared Claw line instead of rendering the
 * web links.
 */
async function ownManagerListingCtaPhone(): Promise<string | null> {
  try {
    const res = await fetch("/api/manager/phone", { credentials: "include", cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as { listingCtaPhone?: string | null; workNumber?: string | null };
    const resolved = data && "listingCtaPhone" in data ? data.listingCtaPhone : data?.workNumber;
    return listingCtaSmsPhone(resolved);
  } catch {
    return null;
  }
}

/**
 * Resolves the SMS number shown on listing CTAs — same source as the public browse page.
 * Live listings use the public catalog; drafts use the signed-in manager's own number,
 * but ONLY when the viewer is provably the listing's owner. A known `ownerManagerUserId`
 * with an unknown or different viewer (admin previews, cross-manager previews) resolves
 * to `null` rather than stamping the viewer's own phone onto someone else's listing.
 *
 * Returns `null` when there is none (e.g. a production manager with no verified
 * phone); callers must render the web "Schedule a tour / apply online" links
 * rather than an `sms:` link.
 */
export function useListingContactSmsPhone(opts: {
  listingId?: string | null;
  ownerManagerUserId?: string | null;
  viewerManagerUserId?: string | null;
  enabled?: boolean;
}): string | null {
  const [phone, setPhone] = useState<string | null>(null);
  const enabled = opts.enabled !== false;
  const listingId = opts.listingId?.trim() || null;
  const ownerId = opts.ownerManagerUserId?.trim() || null;
  const viewerId = opts.viewerManagerUserId?.trim() || null;

  useEffect(() => {
    if (!enabled) {
      setPhone(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      if (listingId && isLiveListingIdForContactSms(listingId)) {
        const fromCatalog = await contactSmsFromPublicCatalog(listingId);
        if (!cancelled && fromCatalog) {
          setPhone(fromCatalog);
          return;
        }
      }
      const viewerIsOwner = !ownerId || (Boolean(viewerId) && ownerId === viewerId);
      if (viewerIsOwner) {
        const own = await ownManagerListingCtaPhone();
        if (!cancelled) setPhone(own);
        return;
      }
      if (!cancelled) setPhone(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, listingId, ownerId, viewerId]);

  return phone;
}
