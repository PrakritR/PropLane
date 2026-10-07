"use client";

import { useCallback, useEffect, useState } from "react";

import { useWorkspaces } from "@/components/portal/workspace-provider";
import type { ListingHoldReason } from "@/lib/listing-channels/post-text";
import type {
  ListingChannelAvailability,
  ListingChannelId,
  ListingChannelPostRow,
} from "@/lib/listing-channels/registry";
import { invalidateSharedGets, sharedGet } from "@/lib/shared-get-cache";

export type ListingChannelsStatus = {
  workspaceId: string;
  canManage: boolean;
  /** Request-access partner contacts; empty unless the viewer is a PropLane admin. */
  partnerContacts?: Partial<Record<ListingChannelId, string>>;
  schemaReady: boolean;
  channels: { id: ListingChannelId; availability: ListingChannelAvailability }[];
  meta: { configured: boolean; connected: boolean; pageName: string | null; igUsername: string | null; revoked: boolean };
  workContact: { phone: string | null; email: string | null };
  /** "Listed with PropLane": whether the line is included, and whether the plan pins it on. */
  attribution?: { enabled: boolean; forced: boolean };
  posts: ListingChannelPostRow[];
  property: { id: string; live: boolean; holdReasons: ListingHoldReason[]; postTexts: Record<string, string> } | null;
};

const ROUTE = "/api/manager/listing-channels";

function isStatus(data: unknown): data is ListingChannelsStatus {
  const d = data as Partial<ListingChannelsStatus> | null;
  return Boolean(d && Array.isArray(d.channels) && Array.isArray(d.posts) && d.meta);
}

function urlFor(workspaceId: string | undefined, propertyId: string | undefined): string {
  const q = new URLSearchParams();
  if (workspaceId) q.set("workspaceId", workspaceId);
  if (propertyId) q.set("propertyId", propertyId);
  const qs = q.toString();
  return qs ? `${ROUTE}?${qs}` : ROUTE;
}

/** One shared read per URL (`sharedGet`); a write calls `refresh` to re-read. */
export function useListingChannels(propertyId?: string) {
  const workspaceId = useWorkspaces()?.active?.id;
  const [status, setStatus] = useState<ListingChannelsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const url = urlFor(workspaceId, propertyId);

  const read = useCallback(
    async (force: boolean) => {
      const res = await sharedGet(url, { force });
      if (res.ok && isStatus(res.data)) setStatus(res.data);
      setLoading(false);
    },
    [url],
  );

  useEffect(() => {
    let cancelled = false;
    void sharedGet(url).then((res) => {
      if (cancelled) return;
      if (res.ok && isStatus(res.data)) setStatus(res.data);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  const refresh = useCallback(async () => {
    invalidateSharedGets(ROUTE);
    await read(true);
  }, [read]);

  return { status, loading, refresh, workspaceId };
}

export async function postListingChannelWrite(
  path: "toggle" | "mark-posted" | "attribution",
  body: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${ROUTE}/${path}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return { ok: true };
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: json.error ?? "Could not save." };
  } catch {
    return { ok: false, error: "Could not save." };
  }
}
