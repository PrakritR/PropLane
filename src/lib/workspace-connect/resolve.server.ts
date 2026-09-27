import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { INVITE_PERMISSION_COLUMNS, readPropertyPermissionsFromRow } from "@/lib/account-link-invite-row";
import { coManagerModuleAllowed } from "@/lib/co-manager-permissions";
import { workspaceConnectEnabled } from "@/lib/workspace-connect/flag";

export type WorkspaceConnectAccount = {
  workspaceId: string;
  ownerUserId: string;
  stripeConnectAccountId: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  payoutMode: "manual" | "automatic";
};

/**
 * Resolve the Connect account for a charge's WORKSPACE — the workspace id
 * must come from the charge/invoice/record itself, resolved server-side,
 * NEVER from the request body (ids in a request body are not authorization).
 *
 * Returns `null` when the flag is off (every caller must fall back to the
 * existing per-manager `profiles.stripe_connect_account_id` path — this
 * function performs no fallback itself, so a caller that forgets to check
 * for `null` fails closed rather than silently using the wrong account) or
 * when the workspace has not set one up yet.
 */
export async function resolveWorkspaceConnectAccount(
  db: SupabaseClient,
  workspaceId: string,
): Promise<WorkspaceConnectAccount | null> {
  if (!workspaceConnectEnabled()) return null;
  const id = workspaceId.trim();
  if (!id) return null;

  const { data } = await db
    .from("portal_workspaces")
    .select(
      "id, owner_user_id, stripe_connect_account_id, stripe_connect_charges_enabled, stripe_connect_payouts_enabled, payout_mode",
    )
    .eq("id", id)
    .maybeSingle();
  if (!data) return null;

  return {
    workspaceId: String(data.id),
    ownerUserId: String(data.owner_user_id ?? ""),
    stripeConnectAccountId: (data.stripe_connect_account_id as string | null) ?? null,
    chargesEnabled: Boolean(data.stripe_connect_charges_enabled),
    payoutsEnabled: Boolean(data.stripe_connect_payouts_enabled),
    payoutMode: data.payout_mode === "automatic" ? "automatic" : "manual",
  };
}

/**
 * Whether `userId` may view/edit THIS WORKSPACE's bank & payout state
 * ("Bank & payouts", C187) — the workspace's owner always may. A co-manager
 * needs the `bankAccount` grant at `level` on at least one property that is
 * actually IN this workspace.
 *
 * Deliberately narrower than the existing per-manager
 * `coManagerHasOwnerBankAccountAccess` (manager-stripe-payout-access.server.ts),
 * which allows the grant on ANY property under the owner — once a manager's
 * money is split per workspace, a co-manager scoped to one workspace's
 * properties must not reach another workspace's bank account through this
 * check. Returns `false` (never throws) so a lookup failure fails closed.
 */
export async function assertWorkspacePayoutAccess(
  db: SupabaseClient,
  userId: string,
  workspaceId: string,
  level: "read" | "edit" = "edit",
): Promise<boolean> {
  const uid = userId.trim();
  const wid = workspaceId.trim();
  if (!uid || !wid) return false;

  const { data: workspace } = await db
    .from("portal_workspaces")
    .select("id, owner_user_id")
    .eq("id", wid)
    .maybeSingle();
  if (!workspace) return false;

  const ownerUserId = String(workspace.owner_user_id ?? "");
  if (ownerUserId === uid) return true;
  if (!ownerUserId) return false;

  const { data: properties } = await db.from("manager_property_records").select("id").eq("workspace_id", wid);
  const workspacePropertyIds = new Set((properties ?? []).map((row) => String((row as { id: unknown }).id)));
  if (workspacePropertyIds.size === 0) return false;

  const { data: links } = await db
    .from("account_link_invites")
    .select(INVITE_PERMISSION_COLUMNS)
    .eq("invitee_user_id", uid)
    .eq("inviter_user_id", ownerUserId)
    .eq("status", "accepted");
  for (const link of links ?? []) {
    const assigned = Array.isArray(link.assigned_property_ids) ? link.assigned_property_ids.map(String) : [];
    const perms = readPropertyPermissionsFromRow(link as Parameters<typeof readPropertyPermissionsFromRow>[0]);
    for (const propertyId of assigned) {
      if (!workspacePropertyIds.has(propertyId)) continue;
      if (coManagerModuleAllowed(perms, propertyId, "bankAccount", level)) return true;
    }
  }
  return false;
}
