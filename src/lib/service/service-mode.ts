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
 * The workspaces payload the Property portal draws: a service workspace the viewer is staff of belongs to the service
 * rail, so it is left out here, and `activeWorkspaceId` is re-resolved on what remains. In service mode nothing is left
 * out (the portal is scoped to that workspace and the client needs it). A client owner's workspace always stays.
 */
export function workspacesForPortalPayload(
  workspaces: PortalWorkspace[],
  staffIds: ReadonlySet<string>,
  cookieId: string | null | undefined,
): { workspaces: PortalWorkspace[]; activeWorkspaceId: string | null } {
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
