import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PHONE_AUTH_ERROR, phoneAuthEnabled, readPhoneIdentity } from "@/lib/auth/phone-auth.server";
import { residentBoundToManager } from "@/lib/auth/resident-workspace-binding";
import { loadResidentLinkedWorkspaceIds } from "@/lib/communication/resident-conversations.server";
import { loadVendorLinkedWorkspaceIds } from "@/lib/communication/vendor-conversations.server";
import { resolveActiveWorkspaceFromRequest } from "@/lib/workspaces/active.server";

async function rolesFor(db: SupabaseClient, userId: string): Promise<string[]> {
  const { data, error } = await db.from("profile_roles").select("role").eq("user_id", userId);
  if (error || !data?.length) throw new Error(PHONE_AUTH_ERROR);
  return data.map((row) => String(row.role));
}

/** A workspace owner can release an established resident/vendor's lost phone.
 * The SQL transition repeats authorization against locked relationship rows.
 * It never chooses the replacement phone or grants the manager a session.
 */
export async function resetWorkspaceMemberPhone(db: SupabaseClient, actorUserId: string, targetUserId: string): Promise<void> {
  if (actorUserId === targetUserId || !/^[\da-f-]{36}$/i.test(targetUserId) || !(await phoneAuthEnabled(db))) throw new Error(PHONE_AUTH_ERROR);
  const [actorRoles, actorPhone] = await Promise.all([rolesFor(db, actorUserId), readPhoneIdentity(db, actorUserId)]);
  if (!actorRoles.includes("manager") || !actorPhone.verified) throw new Error(PHONE_AUTH_ERROR);
  const [targetRoles, workspace] = await Promise.all([
    rolesFor(db, targetUserId), resolveActiveWorkspaceFromRequest(db, actorUserId),
  ]);
  if (!workspace.owned || workspace.ownerUserId !== actorUserId) throw new Error(PHONE_AUTH_ERROR);
  if (!targetRoles.length || targetRoles.some((role) => role !== "resident" && role !== "vendor")) throw new Error(PHONE_AUTH_ERROR);

  let linked = false;
  if (targetRoles.includes("resident") && await residentBoundToManager(db, targetUserId, actorUserId)) {
    linked = (await loadResidentLinkedWorkspaceIds(db, targetUserId, [workspace.id])).has(workspace.id);
  }
  if (!linked && targetRoles.includes("vendor")) {
    linked = (await loadVendorLinkedWorkspaceIds(db, targetUserId, [workspace.id])).has(workspace.id);
  }
  if (!linked) throw new Error(PHONE_AUTH_ERROR);
  const current = await readPhoneIdentity(db, targetUserId);
  if (!current.verified || !current.phone) throw new Error(PHONE_AUTH_ERROR);
  const operation = randomUUID();
  const claim = await db.rpc("phone_auth_claim_operation", { p_operation: operation, p_phone: current.phone, p_user: targetUserId });
  if (claim.error || claim.data !== true) throw new Error(PHONE_AUTH_ERROR);
  try {
    const result = await db.rpc("phone_auth_reset", {
      p_actor: actorUserId, p_target: targetUserId, p_workspace: workspace.id,
      p_phone: current.phone, p_operation: operation,
    });
    if (result.error || result.data !== true) throw new Error(PHONE_AUTH_ERROR);
  } finally {
    await db.rpc("phone_auth_release_operation", { p_operation: operation });
  }
}
