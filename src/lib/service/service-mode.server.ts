import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isPlatformServiceOwner } from "@/lib/service/service-owner.server";
import {
  decideServiceMode,
  firstPropertyWorkspaceId,
  isStaffTeamRole,
  type ServiceModeDecision,
  type ServiceRailWorkspace,
  type ServiceShellData,
} from "@/lib/service/service-mode";
import { loadWorkspaces } from "@/lib/workspaces/server";

/**
 * Which PropLane Service workspaces the viewer is STAFF of. Staff is membership, never a role on the account:
 *   * the platform service owner, for the workspaces they own;
 *   * an accepted team seat on the workspace that is not the client-side Property owner role (a platform admin is
 *     seated as an Admin member of every service workspace; an invited helper is an Admin seat on one).
 * The client who owns an attached workspace is not staff (no seat, not the service owner), so they keep the
 * view-only Property portal. A membership row only counts when the workspace's own owner granted it.
 *
 * Read-only and cheap for an ordinary manager: one membership read that comes back empty, one settings read.
 * Throws on a read failure; callers decide what a failure means (the layouts fail to the Property portal).
 */
export async function loadServiceStaffWorkspaces(
  db: SupabaseClient,
  userId: string,
): Promise<(ServiceRailWorkspace & { ownerUserId: string })[]> {
  const links = await db
    .from("account_link_invites")
    .select("workspace_id, inviter_user_id, team_role")
    .eq("invitee_user_id", userId)
    .eq("status", "accepted")
    .not("workspace_id", "is", null);
  if (links.error) throw new Error("Could not read workspace seats.");
  const seats = ((links.data ?? []) as { workspace_id: string; inviter_user_id: string; team_role: string | null }[]).filter((l) =>
    isStaffTeamRole(l.team_role),
  );
  const seatIds = [...new Set(seats.map((l) => l.workspace_id))];
  const owner = await isPlatformServiceOwner(db, userId);

  const [bySeat, byOwner] = await Promise.all([
    seatIds.length
      ? db.from("portal_workspaces").select("id, name, city, owner_user_id, created_at").eq("is_service", true).in("id", seatIds)
      : Promise.resolve({ data: [], error: null }),
    owner
      ? db.from("portal_workspaces").select("id, name, city, owner_user_id, created_at").eq("is_service", true).eq("owner_user_id", userId)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (bySeat.error || byOwner.error) throw new Error("Could not read service workspaces.");
  type Row = { id: string; name: string; city: string | null; owner_user_id: string; created_at: string | null };
  const seatOwners = new Map(seats.map((l) => [l.workspace_id, l.inviter_user_id]));
  const rows = new Map<string, Row>();
  for (const row of (byOwner.data ?? []) as Row[]) rows.set(row.id, row);
  for (const row of (bySeat.data ?? []) as Row[]) {
    // The seat must have been granted by the workspace's own owner.
    if (seatOwners.get(row.id) === row.owner_user_id) rows.set(row.id, row);
  }
  return [...rows.values()]
    .sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")) || a.name.localeCompare(b.name))
    .map((r) => ({ id: r.id, name: r.name, city: r.city?.trim() || null, ownerUserId: r.owner_user_id }));
}

/** The staff workspace ids, or an empty set when the read failed (the caller then changes nothing). */
export async function loadServiceStaffIds(db: SupabaseClient, userId: string): Promise<Set<string>> {
  try {
    return new Set((await loadServiceStaffWorkspaces(db, userId)).map((w) => w.id));
  } catch (error) {
    console.error("[service-mode] staff workspaces unreadable", error);
    return new Set();
  }
}

export type PortalServiceShell =
  | { mode: "property"; staff: ServiceRailWorkspace[] }
  | { mode: "service"; shell: ServiceShellData; activeName: string; decision: ServiceModeDecision };

/**
 * The /portal layout's question: is this request in service mode? Ordinary managers (no staff seat) return
 * `property` after one cheap read. Otherwise the workspaces are loaded once and the SAME decision the workspaces route
 * uses is made on them, so the rail and the data cannot disagree.
 */
export async function resolvePortalServiceShell(
  db: SupabaseClient,
  userId: string,
  cookieId: string | null | undefined,
  isAdmin: boolean,
): Promise<PortalServiceShell> {
  let staff: Awaited<ReturnType<typeof loadServiceStaffWorkspaces>>;
  try {
    staff = await loadServiceStaffWorkspaces(db, userId);
  } catch (error) {
    console.error("[service-mode] staff workspaces unreadable", error);
    return { mode: "property", staff: [] };
  }
  const rail = staff.map(({ id, name, city }) => ({ id, name, city }));
  if (staff.length === 0) return { mode: "property", staff: [] };
  let workspaces;
  try {
    workspaces = await loadWorkspaces(db, userId);
  } catch (error) {
    console.error("[service-mode] workspaces unreadable", error);
    return { mode: "property", staff: rail };
  }
  const staffIds = new Set(staff.map((w) => w.id));
  const decision = decideServiceMode(workspaces, staffIds, cookieId);
  if (decision.mode !== "service" || !decision.activeId) return { mode: "property", staff: rail };
  const active = workspaces.find((w) => w.id === decision.activeId);
  return {
    mode: "service",
    decision,
    activeName: active?.name ?? "",
    shell: {
      workspaces: rail,
      isAdmin,
      activeId: decision.activeId,
      propertyPortalWorkspaceId: firstPropertyWorkspaceId(workspaces),
    },
  };
}

/** The admin layout's rail data: every service workspace the viewer can open; no active one (an admin page). */
export async function loadAdminServiceShell(db: SupabaseClient, userId: string): Promise<ServiceShellData> {
  let workspaces: ServiceRailWorkspace[] = [];
  try {
    workspaces = (await loadServiceStaffWorkspaces(db, userId)).map(({ id, name, city }) => ({ id, name, city }));
  } catch (error) {
    console.error("[service-mode] admin rail workspaces unreadable", error);
  }
  return { workspaces, isAdmin: true, activeId: null, propertyPortalWorkspaceId: null };
}

/** The viewer's first own non-service workspace (the Property portal's landing), or null when they have none. */
export async function loadPropertyPortalWorkspaceId(db: SupabaseClient, userId: string): Promise<string | null> {
  try {
    return firstPropertyWorkspaceId(await loadWorkspaces(db, userId));
  } catch (error) {
    console.error("[service-mode] workspaces unreadable", error);
    return null;
  }
}
