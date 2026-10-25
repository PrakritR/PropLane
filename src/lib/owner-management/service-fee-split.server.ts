import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { userHoldsAdminRole } from "@/lib/auth/admin-role";
import { feePercentForOwnerShareBps } from "@/lib/owner-management/fee-percent";
import { listPoliciesForWorkspace, loadActivePolicyForWorkspace } from "@/lib/owner-management/policies.server";
import { loadServiceWorkspace } from "@/lib/service/service-owner.server";
import { actorWorkspaceStanding } from "@/lib/workspaces/membership.server";

export type ServiceFeeSplit = {
  /** Percent PropLane keeps of rent. The owner gets the rest. */
  feePercent: number;
  /** 1 for the first accepted fee version of the workspace, counting up with every rate change. */
  version: number;
  /** The day (YYYY-MM-DD) the version in force started. */
  since: string;
};

export type ServiceFeeSplitView = {
  /** Null when the workspace has no fee in force yet. */
  split: ServiceFeeSplit | null;
  /** Server-derived: true only for a platform admin. The write itself is refused again by `requireAdminRoute`. */
  canEdit: boolean;
  /** The viewer is the owner of record named on the policy in force (so the line reads "You"). */
  viewerIsOwnerOfRecord: boolean;
};

export type ServiceFeeSplitResult = { ok: true; view: ServiceFeeSplitView } | { ok: false; status: 401 | 404 | 503; error: string };

/**
 * What the signed-in viewer may see of a PropLane Service workspace's fee split, re-derived here and never taken from
 * the request: the workspace must carry the service flag, and the viewer must be a platform admin, the workspace's
 * owner, or hold an accepted seat in THAT workspace (`actorWorkspaceStanding`). Anyone else, and any workspace that is
 * not a service workspace, answers the same 404 so the route is no oracle for which workspace ids exist.
 */
export async function readServiceFeeSplitForViewer(
  db: SupabaseClient,
  viewerUserId: string,
  workspaceId: string,
): Promise<ServiceFeeSplitResult> {
  const viewer = viewerUserId.trim();
  if (!viewer) return { ok: false, status: 401, error: "Unauthorized." };
  const notFound = { ok: false, status: 404, error: "Service workspace not found." } as const;
  const workspace = await loadServiceWorkspace(db, workspaceId);
  if (!workspace) return notFound;
  const isAdmin = await userHoldsAdminRole(db, viewer);
  if (!isAdmin) {
    const standing = await actorWorkspaceStanding(db, viewer, workspace.id);
    if (!standing || standing.role === null) return notFound;
  }
  try {
    const active = await loadActivePolicyForWorkspace(db, workspace.id);
    if (!active) return { ok: true, view: { split: null, canEdit: isAdmin, viewerIsOwnerOfRecord: false } };
    const versions = await listPoliciesForWorkspace(db, workspace.id);
    const version = Math.max(1, versions.filter((p) => p.signedAt && p.createdAt <= active.createdAt).length);
    return {
      ok: true,
      view: {
        split: { feePercent: feePercentForOwnerShareBps(active.terms.ownerShareBps), version, since: active.effectiveFrom },
        canEdit: isAdmin,
        viewerIsOwnerOfRecord: active.ownerUserId === viewer,
      },
    };
  } catch {
    return { ok: false, status: 503, error: "Could not read the fee split. Try again." };
  }
}
