import "server-only";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { userHoldsAdminRole } from "@/lib/auth/admin-role";
import { platformServiceOwnerId } from "@/lib/service/service-owner.server";
import {
  decideServiceMode,
  firstPropertyWorkspaceId,
  isStaffTeamRole,
  serviceSeatVerdict,
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
 *   * an accepted team seat, granted by the workspace's own owner, that `serviceSeatVerdict` calls staff.
 *
 * An ATTACHED workspace keeps its CLIENT as the owner (`attachWorkspaceToService` never moves `owner_user_id`), so
 * "the owner granted it" cannot tell PropLane's own helper invite from a co-manager the client invited herself. The
 * seat's own provenance does: `is_service_seat`, written only by the admin Service path. A seat without it on an
 * attached workspace (a row from before the column, or the client's own invite) counts only for a PropLane person -
 * the platform service owner or a platform admin. Either way the client who owns an attached workspace keeps the
 * view-only Property portal.
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
    .select("workspace_id, inviter_user_id, team_role, is_service_seat")
    .eq("invitee_user_id", userId)
    .eq("status", "accepted")
    .not("workspace_id", "is", null);
  if (links.error) throw new Error("Could not read workspace seats.");
  type SeatRow = { workspace_id: string; inviter_user_id: string; team_role: string | null; is_service_seat?: boolean | null };
  const seats = ((links.data ?? []) as SeatRow[]).filter((l) => isStaffTeamRole(l.team_role));
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
  const seatByWorkspace = new Map(seats.map((l) => [l.workspace_id, l]));
  const rows = new Map<string, Row>();
  for (const row of (byOwner.data ?? []) as Row[]) rows.set(row.id, row);
  let platformPerson: boolean | null = owner ? true : null;
  for (const row of (bySeat.data ?? []) as Row[]) {
    const seat = seatByWorkspace.get(row.id);
    if (!seat) continue;
    const verdict = serviceSeatVerdict(
      {
        workspaceId: seat.workspace_id,
        inviterUserId: seat.inviter_user_id,
        teamRole: seat.team_role,
        isServiceSeat: seat.is_service_seat === true,
      },
      { ownerUserId: row.owner_user_id },
      serviceOwnerId,
    );
    if (verdict === "no") continue;
    if (verdict === "staff") {
      rows.set(row.id, row);
      continue;
    }
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
