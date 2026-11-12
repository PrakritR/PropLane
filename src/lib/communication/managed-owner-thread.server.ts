import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ManagedOwnerIdentity } from "@/lib/communication/managed-owner-thread";

/**
 * The client owner of the ACTIVE workspace when that workspace is PropLane-managed (`is_service`); null for every other
 * workspace and for any unreadable answer (then nothing is hidden: a failed read never hides a real conversation).
 */
export async function loadManagedOwnerIdentity(db: SupabaseClient, workspaceId: string | null | undefined): Promise<ManagedOwnerIdentity | null> {
  const id = workspaceId?.trim();
  if (!id) return null;
  try {
    const { data: ws, error } = await db.from("portal_workspaces").select("owner_user_id, is_service").eq("id", id).maybeSingle();
    const row = ws as { owner_user_id?: unknown; is_service?: unknown } | null;
    if (error || row?.is_service !== true) return null;
    const ownerUserId = String(row.owner_user_id ?? "").trim();
    if (!ownerUserId) return null;
    const { data: profile } = await db.from("profiles").select("email, phone").eq("id", ownerUserId).maybeSingle();
    const p = profile as { email?: unknown; phone?: unknown } | null;
    return { ownerUserId, email: String(p?.email ?? "").trim().toLowerCase() || null, phoneE164: String(p?.phone ?? "").trim() || null };
  } catch {
    return null;
  }
}
