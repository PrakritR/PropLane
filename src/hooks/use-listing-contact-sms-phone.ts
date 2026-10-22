"use client";

import { useWorkspaces } from "@/components/portal/workspace-provider";
import { useEffect, useState } from "react";
import { listingCtaSmsPhone } from "@/lib/claw-leasing-links";
import { workspaceWorkNumber, type WorkspaceWorkNumberSource } from "@/lib/sms/manager-messaging-number";
import { sharedGet } from "@/lib/shared-get-cache";

/** The selected workspace’s operational work number, never a personal phone or shared platform line. */
async function ownManagerListingCtaPhone(workspaceId?: string): Promise<string | null> {
  try {
    const res = await sharedGet(`/api/manager/messaging-number${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`);
    if (!res.ok) return null;
    const data = res.data as ({ lineReady?: boolean } & WorkspaceWorkNumberSource) | null;
    // The CTA prints the line the workspace texts FROM - a teammate's own
    // retired row is never it (`workspaceWorkNumber` is the one answer) - and
    // it is a fact about that LINE, not about whether the signed-in viewer may
    // send on it: a prospect is the one who will text it.
    return data?.lineReady ? listingCtaSmsPhone(workspaceWorkNumber(data)) : null;
  } catch {
    return null;
  }
}

/**
 * The workspace's own work number, for the MANAGER-side surfaces that print it: the Promotion panels' work
 * contact line and the listing wizard's contact section. It is resolved only when the viewer is provably the
 * listing's owner - a known `ownerManagerUserId` with an unknown or different viewer (admin previews,
 * cross-manager previews) resolves to `null` rather than showing the viewer's own number for someone else's
 * home.
 *
 * The public catalog is NOT a source any more: nothing a renter sees carries a phone number, so
 * `publicListingProjection` no longer publishes one. Returns `null` when the workspace has no live work
 * number.
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
