import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { resolveWorkspaceFromSettingsRequest, type ActiveWorkspace } from "@/lib/workspaces/active.server";
import type { ListingChannelPostRow, ListingChannelPostState, ListingChannelId } from "@/lib/listing-channels/registry";

export type ListingChannelRouteContext = {
  db: SupabaseClient;
  userId: string;
  workspace: ActiveWorkspace;
};

/**
 * The signed-in manager and the workspace the request is about (`?workspaceId=`, else the switcher
 * cookie, else their own default). Ids in a request body are never trusted past this point:
 * every property is re-checked against this workspace before it is read or written.
 */
export async function resolveListingChannelContext(
  request: Request,
  bodyWorkspaceId?: string | null,
): Promise<ListingChannelRouteContext | null> {
  const auth = await requireManagerRouteUser();
  if (!auth) return null;
  const workspace = await resolveWorkspaceFromSettingsRequest(auth.db, auth.userId, request, bodyWorkspaceId);
  return { db: auth.db, userId: auth.userId, workspace };
}

/** The owner's listing in THIS workspace, or null: a property id from the body proves nothing on its own. */
export async function propertyInWorkspace(
  db: SupabaseClient,
  workspace: ActiveWorkspace,
  propertyId: string,
): Promise<{ id: string; live: boolean } | null> {
  if (!propertyId || !workspace.propertyIds.includes(propertyId)) return null;
  const { data, error } = await db
    .from("manager_property_records")
    .select("id, status, manager_user_id, workspace_id")
    .eq("id", propertyId)
    .maybeSingle();
  if (error || !data) return null;
  if (String(data.manager_user_id) !== workspace.ownerUserId || String(data.workspace_id) !== workspace.id) return null;
  return { id: String(data.id), live: data.status === "live" };
}

export function toPostRow(raw: Record<string, unknown>): ListingChannelPostRow {
  return {
    propertyId: String(raw.property_id),
    channel: String(raw.channel) as ListingChannelId,
    enabled: raw.enabled !== false,
    state: String(raw.state) as ListingChannelPostState,
    externalId: (raw.external_id as string | null) ?? null,
    lastError: (raw.last_error as string | null) ?? null,
    postedAt: (raw.posted_at as string | null) ?? null,
    postedUrl: (raw.posted_url as string | null) ?? null,
    updatedAt: (raw.updated_at as string | null) ?? null,
  };
}
