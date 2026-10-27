import type { PortalWorkspace } from "@/lib/workspaces/types";

/**
 * Service mode: the PropLane Service shell under /portal. Pure decisions only (no server imports), shared by the
 * layouts, the workspaces route, the rail and the tests.
 *
 * Two portals, one rule:
 *   * Property portal = managers who bought the software and run their own properties. A workspace flagged
 *     `is_service` that the viewer is STAFF of never appears in it.
 *   * Admin / service mode = the workspaces PropLane manages. Staff is a platform admin or the platform service owner
 *     (a member / owner of the workspace) or an accepted non-owner team seat on it. The client who owns an attached
 *     workspace is NOT staff: they keep the view-only Property portal.
 */

/** One tile on the service rail. */
export type ServiceRailWorkspace = { id: string; name: string; city: string | null };

/** What the server hands the shell: the rail's workspaces and what the viewer may do from it. */
export type ServiceShellData = {
  /** Every service workspace the viewer is staff of (the rail's tiles, in order). */
  workspaces: ServiceRailWorkspace[];
  /** Platform admin: gets the PropLane tile (software overview) and the + (new service workspace). */
  isAdmin: boolean;
  /** The service workspace the portal is rendering right now; null on an admin page. */
  activeId: string | null;
  /** The viewer's first own non-service workspace, for "Switch to Property portal"; null = they have none. */
  propertyPortalWorkspaceId: string | null;
};

/** A seat that counts as staff: anything but the client-side Property owner role. */
export function isStaffTeamRole(role: string | null | undefined): boolean {
  const value = (role ?? "").trim();
  return value.length > 0 && value !== "property_owner";
}

/** The roles a PropLane-issued service seat may carry (`insertAdminMembership` writes Admin). */
const PROPLANE_SEAT_ROLES = new Set(["admin", "full"]);

/** One accepted team seat, as the staff decision reads it. */
export type ServiceSeat = {
  workspaceId: string;
  /** Who granted it; only the workspace's own owner can. */
  inviterUserId: string;
  teamRole: string | null;
  /** `account_link_invites.is_service_seat`: PropLane issued this seat through the admin Service path. */
  isServiceSeat: boolean;
};

/**
 * Is this seat PropLane Service STAFF?
 *
 *   * `no` - it is not a membership of that workspace at all (someone other than its owner granted it), or
 *     it is the client-side Property owner role;
 *   * `staff` - any team role carrying PropLane's own provenance (`isServiceSeat`, Admin team Oct 27: a workspace admin,
 *     property manager, bookkeeper... the shell shows their workspaces, the seat decides what they can do), or an
 *     operator role (admin / full) on a workspace PropLane CREATED (the service owner owns it, so the client grants
 *     nothing there). A Viewer / Custom seat WITHOUT the provenance is `no` on either kind of workspace (it keeps
 *     only its per-house grants);
 *   * `platform_person_only` - an operator seat on an attached workspace with no provenance marker (written before the
 *     column, or granted by the client herself). It counts only for a PropLane person, which keeps a client
 *     from minting staff by inviting a second account of her own.
 */
export type ServiceSeatVerdict = "staff" | "platform_person_only" | "no";

export function serviceSeatVerdict(
  seat: ServiceSeat,
  workspace: { ownerUserId: string },
  serviceOwnerId: string | null,
): ServiceSeatVerdict {
  if (!isStaffTeamRole(seat.teamRole)) return "no";
  if (seat.inviterUserId !== workspace.ownerUserId) return "no";
  // A PropLane-issued seat (Admin team, Oct 27) of ANY team role opens the admin-style shell for its holder: the shell only
  // decides which workspaces they see, while what they can read and change inside stays the seat's own houses and
  // module levels (`loadWorkspaces` narrows the houses, every route re-checks the permission map). The marker is written
  // only by the admin Service path, so a client's own co-manager invite never gets here.
  if (seat.isServiceSeat) return "staff";
  // A Viewer / Custom / Property manager seat is a limited seat that keeps only its per-house grants, on a workspace
  // PropLane CREATED and on an ATTACHED one alike. Decided before either branch so a platform admin holding such a
  // seat is not staff through it either (they keep staff only through the rules that name them a PropLane person).
  if (!PROPLANE_SEAT_ROLES.has((seat.teamRole ?? "").trim().toLowerCase())) return "no";
  // A workspace PropLane created: the client grants nothing there, so the operator seat alone is staff.
  if (serviceOwnerId && workspace.ownerUserId === serviceOwnerId) return "staff";
  if (seat.isServiceSeat) return "staff";
  return "platform_person_only";
}

/** The workspace the server scopes a request to: the cookie's workspace when the viewer can see it, else the first. */
export function resolveActiveWorkspace<T extends { id: string }>(workspaces: T[], cookieId: string | null | undefined): T | null {
  const selected = (cookieId ?? "").trim();
  return workspaces.find((w) => w.id === selected) ?? workspaces[0] ?? null;
}

/** Service workspaces of `workspaces` the viewer is staff of (`staffIds`), in payload order. */
export function staffServiceWorkspaces(workspaces: PortalWorkspace[], staffIds: ReadonlySet<string>): PortalWorkspace[] {
  return workspaces.filter((w) => w.isService === true && staffIds.has(w.id));
}

export type ServiceModeDecision = {
  mode: "service" | "property";
  /** The active workspace as the server resolves it (null when the viewer has none). */
  activeId: string | null;
};

/**
 * Service mode iff the active workspace is a service workspace the viewer is staff of. The cookie wins; with no usable
 * cookie it is the first workspace, exactly what the scope readers narrow to, so the rail and the data never disagree.
 */
export function decideServiceMode(
  workspaces: PortalWorkspace[],
  staffIds: ReadonlySet<string>,
  cookieId: string | null | undefined,
): ServiceModeDecision {
  const active = resolveActiveWorkspace(workspaces, cookieId);
  if (!active) return { mode: "property", activeId: null };
  const mode = active.isService === true && staffIds.has(active.id) ? "service" : "property";
  return { mode, activeId: active.id };
}

/**
 * The houses a STAFF viewer may read and write bookings on while a service workspace is open: the workspace's own
 * houses, never anything else. `null` unless service mode holds (the active workspace is a service workspace the
 * viewer is staff of), so a stranger, a client owner and a staff member browsing their own workspace get nothing here.
 * Bookings a workspace owner typed by hand are stamped to the OWNER, so without this the staff member sees only the
 * rows they wrote themselves.
 */
export type ServiceStaffScope = { workspaceId: string; propertyIds: string[] };

export function serviceStaffScope(
  workspaces: PortalWorkspace[],
  staffIds: ReadonlySet<string>,
  cookieId: string | null | undefined,
): ServiceStaffScope | null {
  const decision = decideServiceMode(workspaces, staffIds, cookieId);
  if (decision.mode !== "service" || !decision.activeId) return null;
  const active = workspaces.find((w) => w.id === decision.activeId);
  if (!active) return null;
  return { workspaceId: active.id, propertyIds: [...new Set(active.propertyIds.map((id) => id.trim()).filter(Boolean))] };
}

/**
 * The workspaces payload the Property portal draws: a service workspace the viewer is staff of belongs to the service
 * rail, so it is left out here, and `activeWorkspaceId` is re-resolved on what remains. In service mode nothing is left
 * out (the portal is scoped to that workspace and the client needs it). A client owner's workspace always stays.
 *
 * `staffUnreadable` is the fail-closed answer for a staff read that threw: the portal is never claimed to be in service
 * mode on a guess, and every service workspace the viewer does not OWN is left out (it would otherwise be drawn in
 * Property chrome). The client owner's own managed workspace stays - it is view-only, not hidden.
 */
export function workspacesForPortalPayload(
  workspaces: PortalWorkspace[],
  staffIds: ReadonlySet<string>,
  cookieId: string | null | undefined,
  opts: { staffUnreadable?: boolean } = {},
): { workspaces: PortalWorkspace[]; activeWorkspaceId: string | null } {
  if (opts.staffUnreadable === true) {
    const own = workspaces.filter((w) => !(w.isService === true && w.owned !== true));
    return { workspaces: own, activeWorkspaceId: resolveActiveWorkspace(own, cookieId)?.id ?? null };
  }
  const decision = decideServiceMode(workspaces, staffIds, cookieId);
  if (decision.mode === "service") return { workspaces, activeWorkspaceId: decision.activeId };
  const visible = workspaces.filter((w) => !(w.isService === true && staffIds.has(w.id)));
  return { workspaces: visible, activeWorkspaceId: resolveActiveWorkspace(visible, cookieId)?.id ?? null };
}

/** The viewer's first own non-service workspace (owned first, the default before the rest). */
export function firstPropertyWorkspaceId(workspaces: PortalWorkspace[]): string | null {
  const own = workspaces.filter((w) => w.owned && w.isService !== true);
  return (own.find((w) => w.isDefault) ?? own[0])?.id ?? null;
}

/** "Admin · <workspace>" in the top bar while a service workspace is open. */
export function serviceTopBarLabel(workspaceName: string | null | undefined): string {
  const name = (workspaceName ?? "").trim();
  return name ? `Admin · ${name}` : "Admin";
}

/** The rail's helper accessibility/title text for one service tile ("Ambika · Seattle"). */
export function serviceTileTitle(workspace: ServiceRailWorkspace): string {
  return workspace.city ? `${workspace.name} · ${workspace.city}` : workspace.name;
}
