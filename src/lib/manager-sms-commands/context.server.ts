import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { findVerifiedProfileByPhone } from "@/lib/one-number/router-lookups.server";
import { listLineMemberships } from "@/lib/one-number/line-member-status.server";
import { identifyServiceManagerPhone } from "@/lib/service/service-manager.server";
import { resolveManagerSmsAccess } from "@/lib/sms/manager-sms-access.server";
import { buildServiceManagerAgentContext, holdsAdminRole, type ServiceSeat } from "@/lib/sms/service-manager-inbound.server";
import type { AgentContext } from "@/lib/tools/context";
import { resolveManagerSmsAgentContext } from "@/lib/tools/manager-sms-context";

/**
 * Defence in depth. The inbound pipeline only calls `handleManagerSmsCommand` with an identity it already
 * resolved (`resolveManagerSmsInboundIdentity` / `recognizeServiceManagerInbound`); this re-proves the one fact every
 * command rests on: this phone is the VERIFIED phone of this actor. An unverified, shared or unknown phone gets nothing.
 */
export async function phoneBelongsToActor(db: SupabaseClient, input: { staffPhoneE164: string; actorUserId: string }): Promise<boolean> {
  const actorUserId = input.actorUserId.trim();
  if (!actorUserId || !input.staffPhoneE164.trim()) return false;
  try {
    const profile = await findVerifiedProfileByPhone(db, input.staffPhoneE164);
    if (profile?.id === actorUserId) return true;
    const service = await identifyServiceManagerPhone(db, input.staffPhoneE164);
    return service?.ownerUserId === actorUserId;
  } catch {
    return false;
  }
}

type WorkspaceRow = { id: string; name: string; ownerUserId: string; isDefault: boolean; isService: boolean };

async function loadWorkspace(db: SupabaseClient, workspaceId: string): Promise<WorkspaceRow | null> {
  const { data, error } = await db
    .from("portal_workspaces")
    .select("id, name, owner_user_id, is_default, is_service")
    .eq("id", workspaceId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    id: String(data.id),
    name: String(data.name ?? ""),
    ownerUserId: String(data.owner_user_id ?? ""),
    isDefault: data.is_default === true,
    isService: data.is_service === true,
  };
}

/**
 * The manager agent context this actor holds on ONE workspace, or null. It is the same context the manager text turn
 * runs under, so every tool the command layer then calls keeps its own workspace, seat and read-only checks.
 *
 *   owner of a self-serve workspace  the ordinary owner context
 *   owner of a PropLane-managed one  null: the client is view-only there, staff run it
 *   admin on a managed workspace     the full owner-mode context over the workspace
 *   seat holder on a managed one     the delegated context of that seat (read-only seats get no write tool)
 *   co-manager on a self-serve one   their delegated context
 */
export async function buildCommandContext(
  db: SupabaseClient,
  input: { actorUserId: string; workspaceId: string },
): Promise<AgentContext | null> {
  const actorUserId = input.actorUserId.trim();
  try {
    const ws = await loadWorkspace(db, input.workspaceId.trim());
    if (!ws || !actorUserId) return null;
    const ref = { id: ws.id, name: ws.name, ownerUserId: ws.ownerUserId, isDefault: ws.isDefault };
    if (ws.ownerUserId === actorUserId) {
      if (ws.isService) {
        // Managed workspaces are owned by the service owner (an admin): that actor runs it with the full owner-mode context.
        // TODO(managed-workspaces-to-admin-20261112): an attached workspace still owned by its CLIENT is view-only (null).
        if (!(await holdsAdminRole(db, actorUserId))) return null;
        const built = await buildServiceManagerAgentContext(db, { serviceOwnerId: actorUserId, workspace: ref });
        return built.ok ? built.ctx : null;
      }
      const built = await resolveManagerSmsAgentContext(db, { managerUserId: actorUserId, actorUserId, workspaceId: ws.id });
      return built.ok ? built.ctx : null;
    }
    if (ws.isService) {
      if (await holdsAdminRole(db, actorUserId)) {
        const built = await buildServiceManagerAgentContext(db, { serviceOwnerId: actorUserId, workspace: ref });
        return built.ok ? built.ctx : null;
      }
      const memberships = await listLineMemberships(db, actorUserId, { kinds: ["teammate"] });
      const seat = (memberships ?? []).find((m) => m.kind === "teammate" && m.isService && m.workspaceId === ws.id);
      if (!seat) return null;
      const seatRef: ServiceSeat = { workspace: ref, viewerRole: seat.teamRole === "viewer" };
      const built = await buildServiceManagerAgentContext(db, { serviceOwnerId: actorUserId, workspace: ref, seat: seatRef });
      return built.ok ? built.ctx : null;
    }
    const access = await resolveManagerSmsAccess(db, { actorUserId, workNumberOwnerId: ws.ownerUserId });
    if (!access || access.mode !== "delegated") return null;
    const built = await resolveManagerSmsAgentContext(db, { managerUserId: ws.ownerUserId, actorUserId, access, workspaceId: ws.id });
    return built.ok ? built.ctx : null;
  } catch {
    return null;
  }
}
