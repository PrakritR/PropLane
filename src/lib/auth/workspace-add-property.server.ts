import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseTeamRole } from "@/lib/co-manager-team-roles";
import { normalizeWorkspacePermissions } from "@/lib/workspace-co-manager-permissions";
import { workspaceRightsForMembership } from "@/lib/workspaces/membership";
import { ensureDefaultWorkspaceId } from "@/lib/workspaces/active.server";

export type CreateListingOwnerResult =
  | {
      ok: true;
      ownerUserId: string;
      workspaceId?: string;
      appendToInviteId?: string;
    }
  | { ok: false; status: number; error: string };

/**
 * Who a new listing is attributed to, and which workspace it lands in.
 *
 * The owner may create into their own workspace. A teammate may create into a
 * workspace they do not own only through a membership OF THAT WORKSPACE whose
 * role carries the houses right (Admin, Property manager, or a Custom row with
 * Add properties), and the row is stamped as the workspace owner
 * (create-as-owner). A membership of another workspace grants nothing here.
 */
export async function resolveCreateListingOwner(
  db: SupabaseClient,
  input: {
    callerUserId: string;
    admin: boolean;
    requestedOwnerId: string | null;
    workspaceId: string | null;
    /**
     * True when `workspaceId` is an explicit ask — the caller (or the request
     * body) named this exact workspace — rather than the ambient cookie
     * selection. An explicit ask that resolves to a workspace the caller does
     * not own, with no houses right, is refused outright: honoring it
     * would let the body move a record into a workspace the caller doesn't own
     * (docs/agents/property-ownership.md). Left unset (the ordinary
     * cookie-selected case), the same failure falls back to the caller's own
     * default workspace instead of refusing — a stale or foreign cookie should
     * not block a manager from creating their own listing (PRP-481).
     */
    explicitWorkspaceId?: boolean;
  },
): Promise<CreateListingOwnerResult> {
  const caller = input.callerUserId.trim();
  if (!caller) return { ok: false, status: 401, error: "Unauthorized." };

  if (input.admin && input.requestedOwnerId && input.requestedOwnerId !== caller) {
    return { ok: true, ownerUserId: input.requestedOwnerId };
  }

  if (input.requestedOwnerId && input.requestedOwnerId !== caller) {
    return { ok: false, status: 403, error: "Select an owned workspace before adding a property." };
  }

  const selected = input.workspaceId?.trim() || "";
  if (!selected) {
    return { ok: true, ownerUserId: caller };
  }

  const workspace = await db
    .from("portal_workspaces")
    .select("id, owner_user_id")
    .eq("id", selected)
    .maybeSingle();
  if (workspace.error) {
    return { ok: false, status: 503, error: "Could not verify workspace." };
  }
  if (!workspace.data) {
    if (input.explicitWorkspaceId) {
      return { ok: false, status: 403, error: "Select an owned workspace before adding a property." };
    }
    // Same shape as the no-grant fallback below (e8e31052): the ambient
    // (cookie) selection named a workspace that no longer exists — deleted,
    // or simply stale — and nothing asked for it by name, so this is still a
    // self-owned create. Land in the caller's own workspace rather than
    // refuse it outright (PRP-485).
    const ownWorkspaceId = await ensureDefaultWorkspaceId(db, caller);
    return { ok: true, ownerUserId: caller, workspaceId: ownWorkspaceId };
  }

  const ownerUserId = String(workspace.data.owner_user_id ?? "").trim();
  if (ownerUserId === caller) {
    return { ok: true, ownerUserId: caller, workspaceId: String(workspace.data.id) };
  }

  const links = await db
    .from("account_link_invites")
    .select("id, workspace_id, workspace_permissions, team_role")
    .eq("invitee_user_id", caller)
    .eq("inviter_user_id", ownerUserId)
    .eq("status", "accepted")
    .eq("workspace_id", String(workspace.data.id));
  if (links.error) {
    return { ok: false, status: 503, error: "Could not verify workspace access." };
  }

  const grant = (links.data ?? []).find((link) => {
    const parsed = parseTeamRole((link as { team_role?: unknown }).team_role);
    return workspaceRightsForMembership({
      teamRole: parsed.ok ? parsed.role : null,
      workspacePermissions: normalizeWorkspacePermissions((link as { workspace_permissions?: unknown }).workspace_permissions),
    }).houses;
  });
  if (!grant) {
    if (input.explicitWorkspaceId) {
      return { ok: false, status: 403, error: "Select an owned workspace before adding a property." };
    }
    // Self-owned create: the ambient (cookie) selection is not writable, and
    // nothing asked for it by name, so land in the caller's own workspace
    // rather than refuse the create outright.
    const ownWorkspaceId = await ensureDefaultWorkspaceId(db, caller);
    return { ok: true, ownerUserId: caller, workspaceId: ownWorkspaceId };
  }

  return {
    ok: true,
    ownerUserId,
    workspaceId: String(workspace.data.id),
    appendToInviteId: String(grant.id),
  };
}
