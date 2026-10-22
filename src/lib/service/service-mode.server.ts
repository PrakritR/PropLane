import "server-only";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { userHoldsAdminRole } from "@/lib/auth/admin-role";
import { platformServiceOwnerId } from "@/lib/service/service-owner.server";
import {
  decideServiceMode,
  firstPropertyWorkspaceId,
  isStaffTeamRole,
  serviceStaffScope,
  type ServiceStaffScope,
  type ServiceModeDecision,
  type ServiceRailWorkspace,
  type ServiceShellData,
} from "@/lib/service/service-mode";
import { loadWorkspaces } from "@/lib/workspaces/server";
import { WORKSPACE_COOKIE } from "@/lib/workspaces/types";

/**
 * Which PropLane Service workspaces the viewer is STAFF of. Staff is membership, never a role on the account:
 *   * the platform service owner, for the workspaces they own;
 *   * an accepted team seat, granted by the workspace's own owner, that is not the client-side Property owner role.
 *
 * A seat alone is not provenance on an ATTACHED workspace: the client stays its owner there (`attachWorkspaceToService`
 * never moves `owner_user_id`), so every seat on it - PropLane's own and the co-managers the client invites herself -
 * is granted by the same account. On such a workspace a seat therefore counts only for a PropLane person: the platform
 * service owner or a platform admin, which is exactly who the attach path seats. On a workspace PropLane CREATED (owned
 * by the service owner) the client grants nothing, so any seat there is PropLane-issued and an invited helper is staff.
 * Either way the client who owns an attached workspace keeps the view-only Property portal.
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
  // One settings read answers both questions. Fail closed: an unknown service owner makes every seated
  // workspace read as "attached", so only a PropLane person is staff of it.
  const serviceOwnerId = await platformServiceOwnerId(db);
  const owner = serviceOwnerId !== null && serviceOwnerId === userId;

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
  let platformPerson: boolean | null = owner ? true : null;
  for (const row of (bySeat.data ?? []) as Row[]) {
    // The seat must have been granted by the workspace's own owner.
    if (seatOwners.get(row.id) !== row.owner_user_id) continue;
    if (serviceOwnerId && row.owner_user_id === serviceOwnerId) {
      rows.set(row.id, row);
      continue;
    }
    // An attached workspace: the client owns it and grants its seats, so only a PropLane person is staff.
    platformPerson ??= await userHoldsAdminRole(db, userId);
    if (platformPerson) rows.set(row.id, row);
  }
  return [...rows.values()]
    .sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")) || a.name.localeCompare(b.name))
    .map((r) => ({ id: r.id, name: r.name, city: r.city?.trim() || null, ownerUserId: r.owner_user_id }));
}

/**
 * The staff workspace ids, and whether the read failed. A failure is reported, never flattened into "no
 * staff seats": the callers fail CLOSED on it (a service workspace is kept out of the Property portal and
 * the workspace selection is dropped), because reading as "not staff" would draw a service workspace in
 * Property chrome.
 */
export async function loadServiceStaffIds(db: SupabaseClient, userId: string): Promise<{ ids: Set<string>; failed: boolean }> {
  try {
    return { ids: new Set((await loadServiceStaffWorkspaces(db, userId)).map((w) => w.id)), failed: false };
  } catch (error) {
    console.error("[service-mode] staff workspaces unreadable", error);
    return { ids: new Set(), failed: true };
  }
}

/**
 * The houses this viewer may run bookings on as service STAFF, re-derived on the server from membership and the
 * selection cookie (a request body never names it). Null when the viewer is not staff of the active service
 * workspace, and on any read failure: a scope that cannot be resolved never widens access.
 */
export async function loadServiceStaffScope(db: SupabaseClient, userId: string): Promise<ServiceStaffScope | null> {
  try {
    const staff = await loadServiceStaffWorkspaces(db, userId);
    if (staff.length === 0) return null;
    const workspaces = await loadWorkspaces(db, userId);
    const cookieId = (await cookies()).get(WORKSPACE_COOKIE)?.value;
    return serviceStaffScope(workspaces, new Set(staff.map((w) => w.id)), cookieId);
  } catch (error) {
    console.error("[service-mode] staff scope unreadable", error);
    return null;
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
