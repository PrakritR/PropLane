"use client";

import { useWorkspaces } from "@/components/portal/workspace-provider";
import { useEffect, useState } from "react";
import { publicListingContact } from "@/lib/public-listing-contacts";
import { listingCtaSmsPhone } from "@/lib/claw-leasing-links";
import { isLiveListingIdForContactSms } from "@/lib/listing-contact-sms";

async function contactSmsFromPublicCatalog(listingId: string): Promise<string | null> {
  return listingCtaSmsPhone((await publicListingContact(listingId))?.contactSmsPhone);
}

/** The selected workspace’s operational work number, never a personal phone or shared platform line. */
async function ownManagerListingCtaPhone(workspaceId?: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/manager/messaging-number${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`, { credentials: "include", cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as { canSend?: boolean; number?: { phoneNumber?: string }; workspaceNumber?: { phoneNumber?: string } };
    return data.canSend ? listingCtaSmsPhone(data.workspaceNumber?.phoneNumber ?? data.number?.phoneNumber) : null;
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
  const workspace = useWorkspaces();
  const workspaceId = workspace?.workspaces.find((w) => opts.listingId && w.propertyIds.includes(opts.listingId))?.id ?? workspace?.active?.id;
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
        const own = await ownManagerListingCtaPhone(workspaceId);
        if (!cancelled) setPhone(own);
        return;
      }
      if (!cancelled) setPhone(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, listingId, ownerId, viewerId, workspaceId]);

  return phone;
}
