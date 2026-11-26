import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { listLineMemberships } from "@/lib/one-number/line-member-status.server";
import { readPlatformServiceOwnerId } from "@/lib/service/service-catalog.server";
import { isServiceWorkspace } from "@/lib/one-number/service-line.server";

/**
 * Is this queued text ADMIN-INITIATED, so it leaves on the admin line (`resolveAdminLine`, the operator's registered number)
 * instead of the line of the workspace it is about? Captain, Nov 24: "use the 814 for the admin portal always".
 *
 * Admin-initiated means a PERSON at PropLane acted: the actor is a platform admin (`profile_roles` admin) or holds a staff seat
 * on a PropLane-managed workspace, and either
 *   - the actor is not the account sending (an admin or staff member typing in, or acting on, a workspace they do not own)
 *     and the workspace is PropLane-managed; or
 *   - the sending account is the platform service owner itself and the text is to a manager/staff person (PropLane's own
 *     alerts and notices to its people, `counterpartyRole: "manager"`).
 * Automated replies (the actor is the sending account) and anything to a prospect, resident or vendor on a line they texted
 * are never admin-initiated: they answer on the line they were sent to. Anything unreadable is NOT admin (the workspace's own
 * decision stands), so a failed read can only keep a text on its usual line.
 */
export async function isAdminSurfaceSend(
  db: SupabaseClient,
  input: { managerUserId: string; actorUserId: string; workspaceId?: string | null; counterpartyRole?: string | null },
): Promise<boolean> {
  try {
    const manager = input.managerUserId.trim();
    const actor = input.actorUserId.trim();
    if (!manager || !actor) return false;
    const serviceOwner = await readPlatformServiceOwnerId(db).catch(() => null);
    const toPeople = manager === serviceOwner && input.counterpartyRole === "manager";
    const actedFor = actor !== manager && Boolean(input.workspaceId) && (await isServiceWorkspace(db, input.workspaceId)) === true;
    if (!toPeople && !actedFor) return false;
    const { data, error } = await db.from("profile_roles").select("role").eq("user_id", actor).eq("role", "admin").limit(1);
    if (!error && Array.isArray(data) && data.length > 0) return true;
    if (toPeople && actor === manager) return false;
    const seats = await listLineMemberships(db, actor, { kinds: ["teammate"] }).catch(() => null);
    return Boolean(seats?.some((m) => m.isService && (!input.workspaceId || m.workspaceId === input.workspaceId)));
  } catch {
    return false;
  }
}
