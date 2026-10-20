import type { SupabaseClient } from "@supabase/supabase-js";
import { INVITE_PERMISSION_COLUMNS, readPropertyPermissionsFromRow, resolveInviteTeamRole } from "@/lib/account-link-invite-row";

/**
 * Does this account hold an accepted team seat that justifies the account-wide `manager` role?
 *
 * The role is one row per account, not one per seat, so the question "may this role be taken away again" is never
 * answerable from a single invite: a teammate seated on two workspaces, or re-accepting one invite while another is
 * already accepted, is a manager because of ANY accepted non-`property_owner` seat. A rollback that reads only its own
 * invite revokes the role the other, accepted, seat depends on - and `smsProvenSessionVerdict` then reads that
 * teammate as resident-only.
 *
 * Fail-safe: an unreadable answer counts as justified. Leaving a role in place is recoverable (the owner can revoke
 * the seat); taking manager access away from someone who holds a live seat is not.
 */
export async function holdsAcceptedManagerSeat(db: SupabaseClient, userId: string): Promise<boolean> {
  const uid = String(userId ?? "").trim();
  if (!uid) return true;
  const { data, error } = await db
    .from("account_link_invites")
    .select(`id, status, ${INVITE_PERMISSION_COLUMNS}`)
    .eq("invitee_user_id", uid)
    .eq("status", "accepted");
  if (error) return true;
  return ((data ?? []) as Array<Record<string, unknown>>).some(
    (row) => resolveInviteTeamRole(row.team_role, readPropertyPermissionsFromRow(row as never)) !== "property_owner",
  );
}
