import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ManagedOwnerIdentity } from "@/lib/communication/managed-owner-thread";

/**
 * The client (the Property owner of record) of the ACTIVE workspace when that workspace is PropLane-managed (`is_service`);
 * null for every other workspace and for any unreadable answer (then nothing is hidden: a failed read never hides a real
 * conversation). The client is `resolveManagedPayee` (the owner seat), never the workspace row's owner, which is the admin
 * once ownership moves. TODO(managed-workspaces-to-admin-20261112): before the prod one-shot an attached workspace is still
 * client-owned, so a workspace with no seat and no policy falls back to its owner unless that owner is the service owner
 * (the admin's own thread is never hidden); drop the fallback after the move.
 */
export async function loadManagedOwnerIdentity(db: SupabaseClient, workspaceId: string | null | undefined): Promise<ManagedOwnerIdentity | null> {
  const id = workspaceId?.trim();
  if (!id) return null;
  try {
    const { data: ws, error } = await db.from("portal_workspaces").select("owner_user_id, is_service").eq("id", id).maybeSingle();
    const row = ws as { owner_user_id?: unknown; is_service?: unknown } | null;
    if (error || row?.is_service !== true) return null;
    const { resolveManagedPayee } = await import("@/lib/managed-finance/payee.server");
    let ownerUserId = (await resolveManagedPayee(db, id)) ?? "";
    if (!ownerUserId) {
      const { platformServiceOwnerId } = await import("@/lib/service/service-owner.server");
      const workspaceOwner = String(row.owner_user_id ?? "").trim();
      ownerUserId = workspaceOwner && workspaceOwner !== (await platformServiceOwnerId(db)) ? workspaceOwner : "";
    }
    if (!ownerUserId) return null;
    const { data: profile } = await db.from("profiles").select("email, phone").eq("id", ownerUserId).maybeSingle();
    const p = profile as { email?: unknown; phone?: unknown } | null;
    return { ownerUserId, email: String(p?.email ?? "").trim().toLowerCase() || null, phoneE164: String(p?.phone ?? "").trim() || null };
  } catch {
    return null;
  }
}
