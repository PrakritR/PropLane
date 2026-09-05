import "server-only";

import {
  coManagerModuleAllowed,
  normalizePropertyCoManagerPermissions,
} from "@/lib/co-manager-permissions";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type ServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

export type StripePayoutContext = {
  /** Profile whose `stripe_connect_account_id` receives resident payouts. */
  payoutOwnerUserId: string;
  canEditBankAccount: boolean;
  isCoManagerForPayout: boolean;
};

async function userOwnsManagerProperties(db: ServiceClient, userId: string): Promise<boolean> {
  const { count, error } = await db
    .from("manager_property_records")
    .select("id", { count: "exact", head: true })
    .eq("manager_user_id", userId);
  if (error) return false;
  return (count ?? 0) > 0;
}

/** Whether a co-manager may change the owner's Stripe payout bank for any assigned property. */
export async function coManagerCanEditOwnerBankAccount(
  db: ServiceClient,
  coManagerUserId: string,
  ownerUserId: string,
): Promise<boolean> {
  const { data: links } = await db
    .from("account_link_invites")
    .select("assigned_property_ids, property_co_manager_permissions, co_manager_permissions")
    .eq("invitee_user_id", coManagerUserId)
    .eq("inviter_user_id", ownerUserId)
    .eq("status", "accepted");
  for (const link of links ?? []) {
    const assigned = Array.isArray(link.assigned_property_ids) ? link.assigned_property_ids.map(String) : [];
    const perms = normalizePropertyCoManagerPermissions(
      link.property_co_manager_permissions ?? link.co_manager_permissions,
      assigned,
    );
    if (assigned.some((propertyId) => coManagerModuleAllowed(perms, propertyId, "bankAccount", "edit"))) {
      return true;
    }
  }
  return false;
}

/**
 * Resident payouts always land in the property owner's Connect account. Co-managers
 * may view that account's readiness; editing it requires the `bankAccount` grant.
 */
export async function resolveStripePayoutContext(
  db: ServiceClient,
  sessionUserId: string,
): Promise<StripePayoutContext> {
  const uid = sessionUserId.trim();
  if (!uid) {
    return { payoutOwnerUserId: "", canEditBankAccount: false, isCoManagerForPayout: false };
  }

  const owns = await userOwnsManagerProperties(db, uid);
  if (owns) {
    return { payoutOwnerUserId: uid, canEditBankAccount: true, isCoManagerForPayout: false };
  }

  const { data: links } = await db
    .from("account_link_invites")
    .select("inviter_user_id")
    .eq("invitee_user_id", uid)
    .eq("status", "accepted");
  const inviters = [
    ...new Set((links ?? []).map((row) => String(row.inviter_user_id ?? "").trim()).filter(Boolean)),
  ];

  if (inviters.length === 0) {
    return { payoutOwnerUserId: uid, canEditBankAccount: true, isCoManagerForPayout: false };
  }

  const ownerId = inviters[0]!;
  const canEdit = await coManagerCanEditOwnerBankAccount(db, uid, ownerId);
  return { payoutOwnerUserId: ownerId, canEditBankAccount: canEdit, isCoManagerForPayout: true };
}
