import type { InviteRow } from "@/app/api/pro/account-links/route";
import { managerPlanAllowsCoManagerInvites } from "@/lib/co-manager-plan-access.server";
import { getManagerPurchaseSku } from "@/lib/manager-access-server";
import { scopedRelationshipDeletesForRevokedInvite } from "@/lib/pro-relationships";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

async function revokeInviteRow(svc: ReturnType<typeof createSupabaseServiceRoleClient>, invite: InviteRow): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await svc
    .from("account_link_invites")
    .update({ status: "cancelled", responded_at: now })
    .eq("id", invite.id)
    .in("status", ["pending", "accepted"]);

  if (error) throw error;

  await svc.from("portal_pro_relationship_records").delete().eq("id", invite.id);

  for (const scope of scopedRelationshipDeletesForRevokedInvite(invite)) {
    await svc
      .from("portal_pro_relationship_records")
      .delete()
      .eq("manager_user_id", scope.managerUserId)
      .filter("row_data->>linkedAxisId", "eq", scope.linkedAxisId);
  }
}

/**
 * When a manager downgrades to Free (or loses paid SKU), disconnect every
 * co-manager link they participate in so access cannot outlive the plan.
 */
export async function disconnectCoManagerLinksForPlanDowngrade(userId: string): Promise<number> {
  const uid = userId.trim();
  if (!uid) return 0;

  const { tier } = await getManagerPurchaseSku(uid);
  if (managerPlanAllowsCoManagerInvites({ tier })) return 0;

  const svc = createSupabaseServiceRoleClient();
  const { data, error } = await svc
    .from("account_link_invites")
    .select("*")
    .eq("tab_kind", "manager")
    .in("status", ["pending", "accepted"])
    .or(`inviter_user_id.eq.${uid},invitee_user_id.eq.${uid}`);

  if (error) throw error;

  let disconnected = 0;
  for (const row of (data ?? []) as InviteRow[]) {
    await revokeInviteRow(svc, row);
    disconnected += 1;
  }
  return disconnected;
}
