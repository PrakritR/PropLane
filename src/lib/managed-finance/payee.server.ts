import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadActivePolicyForWorkspace } from "@/lib/owner-management/policies.server";

/**
 * The one answer to "who is paid from this managed workspace?": the workspace's Property owner (the accepted
 * `property_owner` seat, the owner of record when several), else the signed policy's owner for a workspace not yet
 * migrated to the admin-owned model. Never the workspace row's owner column, which is the admin once ownership moves.
 * Payout status, the setup link and withdrawals all resolve the payee here; a read that fails throws (never "no payee").
 */
export async function resolveManagedPayee(db: SupabaseClient, workspaceId: string): Promise<string | null> {
  const ws = workspaceId.trim();
  if (!ws) return null;
  const { data, error } = await db
    .from("account_link_invites")
    .select("invitee_user_id, is_owner_of_record")
    .eq("workspace_id", ws)
    .eq("status", "accepted")
    .eq("team_role", "property_owner");
  if (error && !["42703", "42P01", "PGRST204", "PGRST205"].includes(String(error.code ?? ""))) throw new Error("Could not read the workspace's property owner.");
  const seats = ((error ? [] : data) ?? []) as Array<{ invitee_user_id: string | null; is_owner_of_record?: boolean | null }>;
  const ids = [...new Set(seats.map((s) => String(s.invitee_user_id ?? "").trim()).filter(Boolean))];
  const policyOwner = (await loadActivePolicyForWorkspace(db, ws))?.ownerUserId || null;
  const record = seats.filter((s) => s.is_owner_of_record && s.invitee_user_id).map((s) => String(s.invitee_user_id));
  if (record.length === 1) return record[0]!;
  if (ids.length === 1) return ids[0]!;
  if (ids.length > 1) return policyOwner && ids.includes(policyOwner) ? policyOwner : null;
  return policyOwner;
}
