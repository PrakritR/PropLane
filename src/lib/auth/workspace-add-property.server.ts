import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hasWorkspaceAddProperties } from "@/lib/workspace-co-manager-permissions";
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
 * workspace they do not own only with `workspace_permissions.addProperties`,
 * and the row is stamped as the workspace owner (create-as-owner).
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
     * not own, with no `addProperties` grant, is refused outright: honoring it
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
    return { ok: false, status: 403, error: "Select an owned workspace before adding a property." };
  }

  const ownerUserId = String(workspace.data.owner_user_id ?? "").trim();
  if (ownerUserId === caller) {
    return { ok: true, ownerUserId: caller, workspaceId: String(workspace.data.id) };
  }

  const links = await db
    .from("account_link_invites")
    .select("id, workspace_id, workspace_permissions")
    .eq("invitee_user_id", caller)
    .eq("inviter_user_id", ownerUserId)
    .eq("status", "accepted");
  if (links.error) {
    return { ok: false, status: 503, error: "Could not verify workspace access." };
  }

  const grant = (links.data ?? []).find((link) => {
    if (!hasWorkspaceAddProperties(link.workspace_permissions)) return false;
    const linkWorkspace = String((link as { workspace_id?: string | null }).workspace_id ?? "").trim();
    return !linkWorkspace || linkWorkspace === String(workspace.data!.id);
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
