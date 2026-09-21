import "server-only";

import {
  normalizeCoManagerPermissions,
  type CoManagerPermissions,
} from "@/lib/co-manager-permissions";
import {
  notifyDemotedToCoManager,
  notifyPromotedToMainManager,
} from "@/lib/co-manager-notification.server";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

export type WorkspaceOwnershipAfterRole = "admin" | "property_manager" | "viewer" | "custom" | "nothing";

function looksLikeMissingFunction(err: { message?: string } | null | undefined): boolean {
  const m = (err?.message ?? "").toLowerCase();
  return m.includes("does not exist") || m.includes("schema cache");
}

function propertyLabelFromRow(row: { property_data?: unknown; row_data?: unknown; id?: string }): string {
  const pd = (row.property_data ?? row.row_data ?? {}) as Record<string, unknown>;
  const building = String(pd.buildingName ?? pd.title ?? "").trim();
  const unit = String(pd.unitLabel ?? "").trim();
  return [building, unit].filter(Boolean).join(" · ") || String(row.id ?? "Property");
}

export type TransferWorkspaceOwnershipInput = {
  workspaceId: string;
  currentOwnerUserId: string;
  newOwnerUserId: string;
  formerOwnerRole: WorkspaceOwnershipAfterRole;
  formerOwnerPermissions: CoManagerPermissions;
};

export type TransferWorkspaceOwnershipResult =
  | { ok: true; houses: number; members: number; workspaceName: string }
  | { ok: false; error: string; status: number };

/**
 * Hands a whole workspace to an accepted member. Every house it holds moves
 * with it (`transfer_portal_workspace_ownership`, see the migration header
 * for how the property-workspace-reassign and membership-propagation
 * triggers are held off for the duration of the call).
 *
 * Deliberately does NOT re-check a plan record cap on the new owner before
 * transferring: `transferPropertyOwnership` (the analogous per-property
 * path this mirrors) does not enforce one either, so there is no "same
 * wording" to reuse. The 3-workspace ownership cap below is the one limit
 * both the per-property and per-workspace paths actually enforce.
 */
export async function transferWorkspaceOwnership(
  db: Db,
  input: TransferWorkspaceOwnershipInput,
): Promise<TransferWorkspaceOwnershipResult> {
  const workspaceId = input.workspaceId.trim();
  const currentOwnerUserId = input.currentOwnerUserId.trim();
  const newOwnerUserId = input.newOwnerUserId.trim();
  const formerOwnerPermissions = normalizeCoManagerPermissions(input.formerOwnerPermissions);

  if (!workspaceId || !currentOwnerUserId || !newOwnerUserId) {
    return { ok: false, error: "Missing required fields.", status: 400 };
  }
  if (currentOwnerUserId === newOwnerUserId) {
    return { ok: false, error: "Choose a different member to transfer to.", status: 400 };
  }

  const { data: workspaceRow, error: workspaceErr } = await db
    .from("portal_workspaces")
    .select("id, name, owner_user_id")
    .eq("id", workspaceId)
    .maybeSingle();
  if (workspaceErr) return { ok: false, error: workspaceErr.message, status: 500 };
  if (!workspaceRow?.id) return { ok: false, error: "Workspace not found.", status: 404 };
  if (workspaceRow.owner_user_id !== currentOwnerUserId) {
    return { ok: false, error: "Only the workspace owner can transfer ownership.", status: 403 };
  }
  const workspaceName = String(workspaceRow.name ?? "").trim() || "This workspace";

  const { data: memberRow, error: memberErr } = await db
    .from("account_link_invites")
    .select("id")
    .eq("inviter_user_id", currentOwnerUserId)
    .eq("invitee_user_id", newOwnerUserId)
    .eq("workspace_id", workspaceId)
    .eq("status", "accepted")
    .maybeSingle();
  if (memberErr) return { ok: false, error: memberErr.message, status: 500 };
  if (!memberRow?.id) {
    return { ok: false, error: "That person isn't a member of this workspace.", status: 404 };
  }

  const [{ data: currentOwnerProfile }, { data: newOwnerProfile }] = await Promise.all([
    db.from("profiles").select("full_name, email").eq("id", currentOwnerUserId).maybeSingle(),
    db.from("profiles").select("full_name, email").eq("id", newOwnerUserId).maybeSingle(),
  ]);
  const currentOwnerName =
    currentOwnerProfile?.full_name?.trim() || currentOwnerProfile?.email?.trim() || "Former manager";
  const newOwnerName = newOwnerProfile?.full_name?.trim() || newOwnerProfile?.email?.trim() || "This manager";

  const { count: ownedCount, error: countErr } = await db
    .from("portal_workspaces")
    .select("id", { count: "exact", head: true })
    .eq("owner_user_id", newOwnerUserId);
  if (countErr) return { ok: false, error: countErr.message, status: 500 };
  if ((ownedCount ?? 0) >= 3) {
    return { ok: false, error: `${newOwnerName} already owns 3 workspaces, the limit.`, status: 409 };
  }

  const { data: rpcData, error: rpcErr } = await db.rpc("transfer_portal_workspace_ownership", {
    p_workspace: workspaceId,
    p_from: currentOwnerUserId,
    p_to: newOwnerUserId,
    p_former_role: input.formerOwnerRole,
    p_former_permissions: formerOwnerPermissions,
  });
  if (rpcErr) {
    if (looksLikeMissingFunction(rpcErr)) {
      return { ok: false, error: "Transfer isn't available yet.", status: 503 };
    }
    return { ok: false, error: rpcErr.message, status: 500 };
  }

  const result = (rpcData ?? {}) as { houses?: number; members?: number };
  const houses = Number(result.houses ?? 0);
  const members = Number(result.members ?? 0);

  // Both notification helpers take a single property label. They are
  // per-property in shape; called ONCE here (not per house) naming the
  // workspace's first house, rather than sending the new and former owner N
  // notices for an N-house workspace.
  const { data: firstHouse } = await db
    .from("manager_property_records")
    .select("id, property_data, row_data")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const propertyLabel = firstHouse ? propertyLabelFromRow(firstHouse) : workspaceName;

  void notifyPromotedToMainManager({
    newManagerUserId: newOwnerUserId,
    formerOwnerUserId: currentOwnerUserId,
    formerOwnerName: currentOwnerName,
    propertyLabel,
  });
  void notifyDemotedToCoManager({
    formerOwnerUserId: currentOwnerUserId,
    newManagerUserId: newOwnerUserId,
    newManagerName: newOwnerName,
    propertyLabel,
  });

  return { ok: true, houses, members, workspaceName };
}
