/**
 * Service mode: the PropLane Service shell under /portal. Which workspaces are staff-only, what the Property portal
 * lists, when the portal renders service mode, and who the rail is composed for.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  decideServiceMode,
  firstPropertyWorkspaceId,
  isStaffTeamRole,
  serviceSeatVerdict,
  resolveActiveWorkspace,
  serviceTileTitle,
  serviceTopBarLabel,
  workspacesForPortalPayload,
} from "@/lib/service/service-mode";
import { serviceInviteBody } from "@/lib/service/service-team-invite";
import type { PortalWorkspace } from "@/lib/workspaces/types";
import { makeServiceFakeDb, type ServiceFakeDb } from "../helpers/service-fake-db";

const ADMIN = "22222222-2222-4222-8222-222222222222";
const OWNER = "11111111-1111-4111-8111-111111111111";
const HELPER = "33333333-3333-4333-8333-333333333333";
const CLIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PLAIN = "44444444-4444-4444-8444-444444444444";
const AMBIKA = "a0000000-0000-4000-8000-00000000000a";
const VINOD = "b0000000-0000-4000-8000-00000000000b";
const MINE = "c0000000-0000-4000-8000-00000000000c";
const ATTACHED = "d0000000-0000-4000-8000-00000000000d";

function ws(id: string, name: string, over: Partial<PortalWorkspace> = {}): PortalWorkspace {
  return { id, name, ownerUserId: OWNER, owned: false, isDefault: false, propertyIds: [], propertyPermissions: {}, ...over };
}

describe("isStaffTeamRole", () => {
  it("counts every seat except the client-side Property owner", () => {
    expect(isStaffTeamRole("admin")).toBe(true);
    expect(isStaffTeamRole("full")).toBe(true);
    expect(isStaffTeamRole("property_manager")).toBe(true);
    expect(isStaffTeamRole("property_owner")).toBe(false);
    expect(isStaffTeamRole(null)).toBe(false);
    expect(isStaffTeamRole("")).toBe(false);
  });
});

describe("serviceSeatVerdict", () => {
  const SERVICE_OWNER = OWNER;
  const seatRow = (over: Partial<Parameters<typeof serviceSeatVerdict>[0]> = {}) => ({
    workspaceId: AMBIKA,
    inviterUserId: CLIENT,
    teamRole: "admin",
    isServiceSeat: true,
    ...over,
  });

  it("is no membership at all unless the workspace's own owner granted it, at an operator role", () => {
    expect(serviceSeatVerdict(seatRow({ inviterUserId: "stranger" }), { ownerUserId: CLIENT }, SERVICE_OWNER)).toBe("no");
    expect(serviceSeatVerdict(seatRow({ teamRole: "property_owner" }), { ownerUserId: CLIENT }, SERVICE_OWNER)).toBe("no");
    expect(serviceSeatVerdict(seatRow({ teamRole: null }), { ownerUserId: CLIENT }, SERVICE_OWNER)).toBe("no");
  });

  it("on a workspace PropLane created, an Admin / Full seat is staff and a Viewer / Custom seat is not", () => {
    const own = { ownerUserId: SERVICE_OWNER };
    for (const teamRole of ["admin", "full", " Admin "]) {
      expect(serviceSeatVerdict(seatRow({ inviterUserId: SERVICE_OWNER, teamRole, isServiceSeat: false }), own, SERVICE_OWNER)).toBe("staff");
    }
    for (const teamRole of ["viewer", "custom", "property_manager"]) {
      for (const isServiceSeat of [false, true]) {
        expect(serviceSeatVerdict(seatRow({ inviterUserId: SERVICE_OWNER, teamRole, isServiceSeat }), own, SERVICE_OWNER)).toBe("no");
      }
    }
  });

  it("on an ATTACHED workspace only PropLane's own seat counts; anything else needs a PropLane person", () => {
    const attached = { ownerUserId: CLIENT };
    // The helper invite the admin Service path wrote.
    expect(serviceSeatVerdict(seatRow(), attached, SERVICE_OWNER)).toBe("staff");
    expect(serviceSeatVerdict(seatRow({ teamRole: "full" }), attached, SERVICE_OWNER)).toBe("staff");
    // The client's own co-manager invite at an operator role: only a PropLane person.
    expect(serviceSeatVerdict(seatRow({ isServiceSeat: false }), attached, SERVICE_OWNER)).toBe("platform_person_only");
    // A non-operator seat is no seat at all here either, marked or not: being a platform admin does not
    // turn a Viewer / Custom / Property manager seat into staff.
    for (const teamRole of ["viewer", "custom", "property_manager"]) {
      for (const isServiceSeat of [false, true]) {
        expect(serviceSeatVerdict(seatRow({ teamRole, isServiceSeat }), attached, SERVICE_OWNER), teamRole).toBe("no");
      }
    }
    // An unknown service owner reads every workspace as attached: fail closed.
    expect(serviceSeatVerdict(seatRow({ inviterUserId: SERVICE_OWNER, isServiceSeat: false }), { ownerUserId: SERVICE_OWNER }, null)).toBe(
      "platform_person_only",
    );
  });
});

describe("the Property portal list", () => {
  const ambika = ws(AMBIKA, "Ambika", { isService: true });
  const vinod = ws(VINOD, "Vinod", { isService: true });
  const mine = ws(MINE, "My homes", { owned: true, isDefault: true, ownerUserId: ADMIN });
  const staff = new Set([AMBIKA, VINOD]);

  it("leaves a service workspace out for its staff, and re-resolves the active one on what remains", () => {
    const out = workspacesForPortalPayload([mine, ambika, vinod], staff, MINE);
    expect(out.workspaces.map((w) => w.id)).toEqual([MINE]);
    expect(out.activeWorkspaceId).toBe(MINE);
  });

  it("an admin with no workspace of their own and no cookie is in service mode, so nothing is left out", () => {
    const out = workspacesForPortalPayload([ambika, vinod], staff, undefined);
    expect(out.workspaces.map((w) => w.id)).toEqual([AMBIKA, VINOD]);
    expect(out.activeWorkspaceId).toBe(AMBIKA);
  });

  it("a cookie naming a service workspace is service mode: the full list is kept and that workspace is active", () => {
    const out = workspacesForPortalPayload([mine, ambika, vinod], staff, VINOD);
    expect(out.workspaces).toHaveLength(3);
    expect(out.activeWorkspaceId).toBe(VINOD);
  });

  it("the client who owns an attached service workspace keeps it (not staff), and a plain manager is untouched", () => {
    const clientWs = ws(AMBIKA, "Ambika", { isService: true, owned: true, ownerUserId: CLIENT, readOnly: true });
    expect(workspacesForPortalPayload([clientWs], new Set(), AMBIKA)).toEqual({ workspaces: [clientWs], activeWorkspaceId: AMBIKA });
    const plain = [ws("p1", "One", { owned: true }), ws("p2", "Two", { owned: true })];
    expect(workspacesForPortalPayload(plain, new Set(), "p2")).toEqual({ workspaces: plain, activeWorkspaceId: "p2" });
    expect(workspacesForPortalPayload(plain, new Set(), "gone").activeWorkspaceId).toBe("p1");
  });
});

describe("service mode decision", () => {
  const ambika = ws(AMBIKA, "Ambika", { isService: true });
  const mine = ws(MINE, "My homes", { owned: true, isDefault: true });

  it("is service only when the ACTIVE workspace is a service workspace the viewer is staff of", () => {
    expect(decideServiceMode([mine, ambika], new Set([AMBIKA]), AMBIKA)).toEqual({ mode: "service", activeId: AMBIKA });
    expect(decideServiceMode([mine, ambika], new Set([AMBIKA]), MINE)).toEqual({ mode: "property", activeId: MINE });
    expect(decideServiceMode([mine, ambika], new Set([AMBIKA]), "stale")).toEqual({ mode: "property", activeId: MINE });
    // Not staff (the client owner): never service mode, even on their own service workspace.
    expect(decideServiceMode([ambika], new Set(), AMBIKA).mode).toBe("property");
    expect(decideServiceMode([], new Set([AMBIKA]), AMBIKA)).toEqual({ mode: "property", activeId: null });
  });

  it("resolves the active workspace the way the scope readers do: the cookie's, else the first", () => {
    expect(resolveActiveWorkspace([mine, ambika], AMBIKA)?.id).toBe(AMBIKA);
    expect(resolveActiveWorkspace([mine, ambika], null)?.id).toBe(MINE);
  });

  it("names the Property portal landing workspace and labels the top bar", () => {
    expect(firstPropertyWorkspaceId([ambika, mine])).toBe(MINE);
    expect(firstPropertyWorkspaceId([ws(AMBIKA, "A", { isService: true, owned: true })])).toBeNull();
    expect(serviceTopBarLabel("Ambika")).toBe("Admin · Ambika");
    expect(serviceTopBarLabel("  ")).toBe("Admin");
    expect(serviceTileTitle({ id: "1", name: "Ambika", city: "Seattle" })).toBe("Ambika · Seattle");
  });
});

describe("the Team pane's one invite box", () => {
  it("sends an email when it has an @, a PropLane ID otherwise, nothing when empty", () => {
    expect(serviceInviteBody("w", " a@b.co ")).toEqual({ action: "team-invite", id: "w", email: "a@b.co" });
    expect(serviceInviteBody("w", "AX-1234")).toEqual({ action: "team-invite", id: "w", proplaneId: "AX-1234" });
    expect(serviceInviteBody("w", "   ")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Server: who is staff, the rail composition and the layout's gate.

let db: ServiceFakeDb;
let admins = new Set<string>();
vi.mock("@/lib/auth/admin-role", () => ({
  userHoldsAdminRole: async (_db: unknown, id: string) => admins.has(id),
  listAdminUserIds: async () => [...admins],
}));
vi.mock("@/lib/auth/co-manager-invite-eligibility.server", () => ({ userIsPropertyPortalManager: async () => true }));
const loadWorkspacesMock = vi.hoisted(() => ({ value: [] as unknown[] }));
vi.mock("@/lib/workspaces/server", () => ({ loadWorkspaces: async () => loadWorkspacesMock.value }));

const mode = await import("@/lib/service/service-mode.server");

function seat(
  invitee: string,
  workspace: string,
  role: string,
  inviter = OWNER,
  status = "accepted",
  opts: { serviceSeat?: boolean } = {},
) {
  return {
    id: `${invitee}-${workspace}`,
    inviter_user_id: inviter,
    invitee_user_id: invitee,
    workspace_id: workspace,
    team_role: role,
    status,
    // `insertAdminMembership` stamps every seat PropLane issues; a client's own co-manager invite has none.
    is_service_seat: opts.serviceSeat ?? true,
  };
}

beforeEach(() => {
  admins = new Set([ADMIN, OWNER]);
  loadWorkspacesMock.value = [];
  db = makeServiceFakeDb({
    platform_service_settings: [{ singleton: true, owner_user_id: OWNER }],
    portal_workspaces: [
      { id: AMBIKA, name: "Ambika", city: "Seattle", owner_user_id: OWNER, is_service: true, created_at: "2026-10-01T00:00:00Z" },
      { id: VINOD, name: "Vinod", city: "Seattle", owner_user_id: OWNER, is_service: true, created_at: "2026-10-02T00:00:00Z" },
      { id: MINE, name: "My homes", city: null, owner_user_id: ADMIN, is_service: false, created_at: "2026-09-01T00:00:00Z" },
    ],
    account_link_invites: [
      seat(ADMIN, AMBIKA, "admin"),
      seat(ADMIN, VINOD, "admin"),
      seat(HELPER, VINOD, "admin"),
      seat(CLIENT, AMBIKA, "property_owner"),
      // A pending invite and a seat granted by someone who does not own the workspace are not staff.
      seat(PLAIN, AMBIKA, "admin", OWNER, "pending"),
      seat(PLAIN, VINOD, "admin", "99999999-9999-4999-8999-999999999999"),
    ],
  });
});

describe("who is staff of a service workspace", () => {
  const ids = async (user: string) => (await mode.loadServiceStaffWorkspaces(db as never, user)).map((w) => w.name);

  it("a platform admin is seated on every service workspace, in creation order (Ambika, then Vinod)", async () => {
    expect(await ids(ADMIN)).toEqual(["Ambika", "Vinod"]);
  });

  it("the platform service owner is staff of the workspaces they own, with no seat", async () => {
    expect(await ids(OWNER)).toEqual(["Ambika", "Vinod"]);
  });

  it("an invited helper is staff of that workspace only", async () => {
    expect(await ids(HELPER)).toEqual(["Vinod"]);
  });

  it("the client's Property owner seat, a pending invite and a seat granted by a stranger are not staff", async () => {
    expect(await ids(CLIENT)).toEqual([]);
    expect(await ids(PLAIN)).toEqual([]);
  });

  it("an attached workspace's own client owner is not staff (no seat, not the service owner)", async () => {
    db.tables.portal_workspaces.push({ id: ATTACHED, name: "Client homes", owner_user_id: CLIENT, is_service: true, created_at: "2026-10-03T00:00:00Z" });
    expect(await ids(CLIENT)).toEqual([]);
    // ...and a read failure is REPORTED, so the callers can fail closed instead of reading "not staff".
    db.failOn.account_link_invites = { code: "XX000", message: "down" };
    expect(await mode.loadServiceStaffIds(db as never, ADMIN)).toEqual({ ids: new Set(), failed: true });
  });

  it("fails closed when the provenance column is not there yet, and says which migration is missing", async () => {
    const logged: unknown[][] = [];
    const error = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void logged.push(args));
    try {
      db.failOn.account_link_invites = { code: "42703", message: 'column account_link_invites.is_service_seat does not exist' };
      // Nobody is staff: no rail, no service mode, and the Property portal list fails closed on `failed`.
      expect(await mode.loadServiceStaffIds(db as never, ADMIN)).toEqual({ ids: new Set(), failed: true });
      expect(await mode.resolvePortalServiceShell(db as never, ADMIN, VINOD, true)).toEqual({ mode: "property", staff: [] });
      expect(JSON.stringify(logged)).toContain("20261021090100");
    } finally {
      error.mockRestore();
    }
  });

  it("a seat the CLIENT granted on their own attached workspace is not staff: only PropLane's own seat is", async () => {
    db.tables.portal_workspaces.push({ id: ATTACHED, name: "Client homes", owner_user_id: CLIENT, is_service: true, created_at: "2026-10-03T00:00:00Z" });
    // The client invites a second account of their own as a co-manager of the workspace they still own.
    // It is granted by the workspace's owner and carries an operator role, so only the missing provenance
    // marker tells it apart from a PropLane seat.
    db.tables.account_link_invites.push(seat(PLAIN, ATTACHED, "admin", CLIENT, "accepted", { serviceSeat: false }));
    expect(await ids(PLAIN)).toEqual([]);
    // PropLane's own seats on the same workspace (the attach path seats the service owner and a platform admin).
    db.tables.account_link_invites.push(seat(ADMIN, ATTACHED, "admin", CLIENT), seat(OWNER, ATTACHED, "admin", CLIENT));
    expect(await ids(ADMIN)).toContain("Client homes");
    expect(await ids(OWNER)).toContain("Client homes");
  });

  it("a HELPER invited through the admin Service path is staff of an attached workspace too", async () => {
    db.tables.portal_workspaces.push({ id: ATTACHED, name: "Client homes", owner_user_id: CLIENT, is_service: true, created_at: "2026-10-03T00:00:00Z" });
    // `inviteServiceClient` writes the seat under the workspace's owner with the service marker; the helper
    // holds no platform admin role at all.
    db.tables.account_link_invites.push(seat(HELPER, ATTACHED, "admin", CLIENT));
    expect(admins.has(HELPER)).toBe(false);
    expect(await ids(HELPER)).toEqual(["Vinod", "Client homes"]);
    // A legacy PropLane seat written before the marker existed still works for a PropLane person only.
    db.tables.account_link_invites.push(seat(PLAIN, ATTACHED, "full", CLIENT, "accepted", { serviceSeat: false }));
    expect(await ids(PLAIN)).toEqual([]);
    admins.add(PLAIN);
    expect(await ids(PLAIN)).toEqual(["Client homes"]);
  });
});

describe("a limited seat on a workspace PropLane created", () => {
  it("is not staff and gets no staff scope: it keeps only its per-house grants", async () => {
    db.tables.account_link_invites.push(seat(PLAIN, AMBIKA, "viewer", OWNER, "accepted", { serviceSeat: false }));
    db.tables.account_link_invites.push(seat(HELPER, AMBIKA, "custom", OWNER, "accepted", { serviceSeat: true }));
    expect((await mode.loadServiceStaffWorkspaces(db as never, PLAIN)).map((w) => w.name)).toEqual([]);
    expect((await mode.loadServiceStaffWorkspaces(db as never, HELPER)).map((w) => w.name)).toEqual(["Vinod"]);
    expect(await mode.loadServiceStaffScope(db as never, PLAIN)).toBeNull();
  });
});

describe("the /portal layout's service-mode gate", () => {
  const full = () => [
    ws(MINE, "My homes", { owned: true, isDefault: true, ownerUserId: ADMIN }),
    ws(AMBIKA, "Ambika", { isService: true }),
    ws(VINOD, "Vinod", { isService: true }),
  ];

  it("an admin whose cookie names a service workspace gets service mode with the rail composed for an admin", async () => {
    loadWorkspacesMock.value = full();
    const res = await mode.resolvePortalServiceShell(db as never, ADMIN, VINOD, true);
    expect(res.mode).toBe("service");
    if (res.mode !== "service") return;
    expect(res.activeName).toBe("Vinod");
    expect(res.shell).toEqual({
      workspaces: [
        { id: AMBIKA, name: "Ambika", city: "Seattle" },
        { id: VINOD, name: "Vinod", city: "Seattle" },
      ],
      isAdmin: true,
      activeId: VINOD,
      propertyPortalWorkspaceId: MINE,
    });
  });

  it("the same admin on their own workspace is the Property portal (and keeps the staff list for the menu)", async () => {
    loadWorkspacesMock.value = full();
    expect(await mode.resolvePortalServiceShell(db as never, ADMIN, MINE, true)).toMatchObject({ mode: "property", staff: [{ id: AMBIKA }, { id: VINOD }] });
  });

  it("a helper sees only their workspace, with no admin tiles", async () => {
    loadWorkspacesMock.value = [ws(VINOD, "Vinod", { isService: true, viewerRole: "admin" })];
    const res = await mode.resolvePortalServiceShell(db as never, HELPER, undefined, false);
    expect(res.mode).toBe("service");
    if (res.mode !== "service") return;
    expect(res.shell).toMatchObject({ isAdmin: false, activeId: VINOD, propertyPortalWorkspaceId: null });
    expect(res.shell.workspaces).toEqual([{ id: VINOD, name: "Vinod", city: "Seattle" }]);
  });

  it("fails closed for the Property portal list when the staff read is unreadable", () => {
    const out = workspacesForPortalPayload(
      [ws(MINE, "My homes", { owned: true, isDefault: true, ownerUserId: ADMIN }), ws(AMBIKA, "Ambika", { isService: true })],
      new Set(),
      AMBIKA,
      { staffUnreadable: true },
    );
    expect(out.workspaces.map((w) => w.id)).toEqual([MINE]);
    expect(out.activeWorkspaceId).toBe(MINE);
    // The client owner's own managed workspace is view-only, not hidden.
    const client = ws(AMBIKA, "Ambika", { isService: true, owned: true, ownerUserId: CLIENT, readOnly: true });
    expect(workspacesForPortalPayload([client], new Set(), AMBIKA, { staffUnreadable: true }).workspaces).toEqual([client]);
  });

  it("the client owner and a plain manager stay in the Property portal after one cheap read", async () => {
    loadWorkspacesMock.value = [ws(AMBIKA, "Ambika", { isService: true, owned: false, readOnly: true })];
    expect(await mode.resolvePortalServiceShell(db as never, CLIENT, AMBIKA, false)).toEqual({ mode: "property", staff: [] });
    expect(await mode.resolvePortalServiceShell(db as never, PLAIN, undefined, false)).toEqual({ mode: "property", staff: [] });
  });

  it("an unreadable seat table fails to the Property portal, never to a half-built service shell", async () => {
    db.failOn.account_link_invites = { code: "XX000", message: "down" };
    expect(await mode.resolvePortalServiceShell(db as never, ADMIN, VINOD, true)).toEqual({ mode: "property", staff: [] });
  });

  it("the admin portal's rail lists every workspace the admin can open and has no active one", async () => {
    expect(await mode.loadAdminServiceShell(db as never, ADMIN)).toEqual({
      workspaces: [
        { id: AMBIKA, name: "Ambika", city: "Seattle" },
        { id: VINOD, name: "Vinod", city: "Seattle" },
      ],
      isAdmin: true,
      activeId: null,
      propertyPortalWorkspaceId: null,
    });
  });
});
