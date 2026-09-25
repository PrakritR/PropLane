import "server-only";

import { INVITE_PERMISSION_COLUMNS, readPropertyPermissionsFromRow } from "@/lib/account-link-invite-row";
import { coManagerModuleAllowed } from "@/lib/co-manager-permissions";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type ServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

export type StripePayoutContext = {
  /** Profile whose `stripe_connect_account_id` receives resident payouts. Empty when unresolved. */
  payoutOwnerUserId: string;
  canEditBankAccount: boolean;
  /**
   * Whether a co-manager holds the `bankAccount` grant at `read` on any
   * assigned property under this owner. Always `true` for a primary owner
   * viewing their own account. A co-manager with NEITHER read nor edit must
   * never see the owner's Stripe status, balance, or identity state at all —
   * "empty permissions = no access" (docs/agents/co-manager-access.md)
   * applies to `bankAccount` the same as every other module.
   */
  canViewBankAccount: boolean;
  isCoManagerForPayout: boolean;
  /** Set when the payout owner could not be decided; routes must refuse rather than guess. */
  unresolvedReason?: "lookup_failed" | "ambiguous_owner";
};

/**
 * Whether this account holds property of its own.
 *
 * A read failure is NOT "no properties": treating it that way reclassified an
 * owner as somebody's co-manager on a transient DB blip and pointed their
 * onboarding at another manager's Connect account. The caller fails closed on
 * `null` instead.
 */
async function userOwnsManagerProperties(db: ServiceClient, userId: string): Promise<boolean | null> {
  const { count, error } = await db
    .from("manager_property_records")
    .select("id", { count: "exact", head: true })
    .eq("manager_user_id", userId);
  if (error) return null;
  return (count ?? 0) > 0;
}

/**
 * Whether a co-manager may READ or edit the owner's Stripe payout bank/payout
 * state for any assigned property, at the given level — the one answer every
 * bank/payout route's gate (`assertCoManagerBankAccountAccess`) checks
 * against, `edit`/`delete` implying `read` per the standard level model.
 */
export async function coManagerHasOwnerBankAccountAccess(
  db: ServiceClient,
  coManagerUserId: string,
  ownerUserId: string,
  level: "read" | "edit" = "edit",
): Promise<boolean> {
  const { data: links } = await db
    .from("account_link_invites")
    .select(INVITE_PERMISSION_COLUMNS)
    .eq("invitee_user_id", coManagerUserId)
    .eq("inviter_user_id", ownerUserId)
    .eq("status", "accepted");
  for (const link of links ?? []) {
    const assigned = Array.isArray(link.assigned_property_ids) ? link.assigned_property_ids.map(String) : [];
    const perms = readPropertyPermissionsFromRow(link as Parameters<typeof readPropertyPermissionsFromRow>[0]);
    if (assigned.some((propertyId) => coManagerModuleAllowed(perms, propertyId, "bankAccount", level))) {
      return true;
    }
  }
  return false;
}

/**
 * Resident payouts always land in the property owner's Connect account. A
 * co-manager may view that account's readiness ONLY with the `bankAccount`
 * grant at `read`; editing it requires `edit`. Neither is a standing
 * privilege of being an accepted co-manager on ANY module — see
 * `docs/agents/co-manager-access.md` "Empty permissions = no access".
 */
export async function resolveStripePayoutContext(
  db: ServiceClient,
  sessionUserId: string,
): Promise<StripePayoutContext> {
  const uid = sessionUserId.trim();
  if (!uid) {
    return { payoutOwnerUserId: "", canEditBankAccount: false, canViewBankAccount: false, isCoManagerForPayout: false };
  }

  const owns = await userOwnsManagerProperties(db, uid);
  if (owns === null) {
    return {
      payoutOwnerUserId: "",
      canEditBankAccount: false,
      canViewBankAccount: false,
      isCoManagerForPayout: false,
      unresolvedReason: "lookup_failed",
    };
  }
  if (owns) {
    return { payoutOwnerUserId: uid, canEditBankAccount: true, canViewBankAccount: true, isCoManagerForPayout: false };
  }

  const { data: links, error: linkError } = await db
    .from("account_link_invites")
    .select("inviter_user_id")
    .eq("invitee_user_id", uid)
    .eq("status", "accepted");
  if (linkError) {
    return {
      payoutOwnerUserId: "",
      canEditBankAccount: false,
      canViewBankAccount: false,
      isCoManagerForPayout: false,
      unresolvedReason: "lookup_failed",
    };
  }
  const inviters = [
    ...new Set((links ?? []).map((row) => String(row.inviter_user_id ?? "").trim()).filter(Boolean)),
  ].filter((id) => id !== uid);

  // No accepted link at all: this is the caller's own payout account. A brand-new
  // manager with no listings yet still onboards their OWN Connect account here.
  if (inviters.length === 0) {
    return { payoutOwnerUserId: uid, canEditBankAccount: true, canViewBankAccount: true, isCoManagerForPayout: false };
  }

  // Two owners have two different Connect accounts and nothing in this request
  // says which one is meant. `inviters[0]` came out of an unordered query, so it
  // could route a bank change at the wrong manager — refuse instead of guessing.
  if (inviters.length > 1) {
    return {
      payoutOwnerUserId: "",
      canEditBankAccount: false,
      canViewBankAccount: false,
      isCoManagerForPayout: true,
      unresolvedReason: "ambiguous_owner",
    };
  }

  const ownerId = inviters[0]!;
  const [canEdit, canView] = await Promise.all([
    coManagerHasOwnerBankAccountAccess(db, uid, ownerId, "edit"),
    coManagerHasOwnerBankAccountAccess(db, uid, ownerId, "read"),
  ]);
  return {
    payoutOwnerUserId: ownerId,
    canEditBankAccount: canEdit,
    // `edit` already implies `read` in the standard level model, but a
    // grant lookup failure must never silently upgrade a refused view into
    // an allowed one — take both results rather than assuming.
    canViewBankAccount: canView || canEdit,
    isCoManagerForPayout: true,
  };
}

/** The message a route shows when {@link resolveStripePayoutContext} could not decide an owner. */
export function stripePayoutContextError(reason: StripePayoutContext["unresolvedReason"]): string {
  return reason === "ambiguous_owner"
    ? "You co-manage properties for more than one owner, so payouts must be set up from the owner's own account."
    : "Could not resolve payout account. Try again in a moment.";
}
