/**
 * The admin Service route's team verbs and the requests the Invite sheet builds for them: every verb starts with
 * requireAdminRoute() (a non-admin reaches no service function), the body is passed on as a request (never a
 * grant), and the sheet's choice becomes the same shape the manager invite posts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const guard = vi.hoisted(() => ({ result: { ok: true, userId: "admin-1" } as { ok: true; userId: string } | { ok: false; response: Response } }));
vi.mock("@/lib/admin/admin-route-guard.server", () => ({ requireAdminRoute: async () => guard.result }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));

const svc = vi.hoisted(() => ({
  inviteServiceClient: vi.fn(async () => ({ ok: true as const, linkId: "link-1", delivery: "account" as const, ownerReplaced: false })),
  updateServiceTeamAccess: vi.fn(async () => ({ ok: true as const })),
  removeServiceTeamMember: vi.fn(async () => ({ ok: true as const })),
  createServiceWorkspace: vi.fn(async () => ({ ok: true as const, id: "ws-1", ownerInvite: { sent: true, delivery: "link" as const } })),
  setServiceWorkspaceFee: vi.fn(async () => ({ ok: true as const, feePercent: 10, changed: false })),
}));
vi.mock("@/lib/service/service-workspaces.server", () => ({
  addServiceTeamMember: vi.fn(),
  attachWorkspaceToService: vi.fn(),
  authorizeOpenServiceWorkspace: vi.fn(),
  listServiceAttachCandidates: vi.fn(),
  listServiceTeam: vi.fn(),
  listServiceWorkspaces: vi.fn(),
  renameServiceWorkspace: vi.fn(),
  setServiceOwnerOfRecord: vi.fn(),
  ...svc,
}));

const { POST } = await import("@/app/api/admin/service-workspaces/route");
const requests = await import("@/lib/service/service-team-invite");

const post = (body: unknown) =>
  POST(new Request("https://prop-lane.space/api/admin/service-workspaces", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }));

beforeEach(() => {
  guard.result = { ok: true, userId: "admin-1" };
  for (const fn of Object.values(svc)) fn.mockClear();
});

describe("every team verb starts with requireAdminRoute()", () => {
  it.each(["team-invite", "team-access", "team-remove", "create", "fee"])("%s: a signed-out caller gets 401 and a non-admin 403, and no service function runs", async (action) => {
    guard.result = { ok: false, response: new Response(JSON.stringify({ error: "Unauthorized." }), { status: 401 }) };
    expect((await post({ action, id: "ws-1", email: "a@b.co" })).status).toBe(401);
    guard.result = { ok: false, response: new Response(JSON.stringify({ error: "Forbidden." }), { status: 403 }) };
    expect((await post({ action, id: "ws-1", email: "a@b.co" })).status).toBe(403);
    for (const fn of Object.values(svc)) expect(fn).not.toHaveBeenCalled();
  });
});

describe("team-invite / team-access / create", () => {
  it("passes the role, houses and levels on as a request, with the admin's id from the session and never the body", async () => {
    const res = await post({
      action: "team-invite",
      id: "ws-1",
      email: "a@b.co",
      teamRole: "custom",
      houseScope: "selected",
      assignedPropertyIds: ["h1"],
      propertyCoManagerPermissions: { h1: { payments: { read: true } } },
      coManagerPermissions: { payments: { read: true } },
      workspacePermissions: { teams: true },
      userId: "someone-else",
      operatorUserId: "someone-else",
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true, linkId: "link-1", delivery: "account" });
    const [, operator, input] = svc.inviteServiceClient.mock.calls[0] as unknown as [unknown, string, Record<string, unknown>];
    expect(operator).toBe("admin-1");
    expect(input).toMatchObject({ id: "ws-1", email: "a@b.co", teamRole: "custom", houseScope: "selected", assignedPropertyIds: ["h1"] });
    expect(JSON.stringify(input)).not.toContain("someone-else");
  });

  it("answers an owner conflict with a code the sheet can ask to replace on", async () => {
    svc.inviteServiceClient.mockResolvedValueOnce({ ok: false, status: 409, error: "Ambika is the owner now. Replace them?", code: "owner_exists", ownerName: "Ambika" } as never);
    const res = await post({ action: "team-invite", id: "ws-1", email: "a@b.co", ownerOfRecord: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "owner_exists", ownerName: "Ambika" });
  });

  it("team-access hands the seat id and the new access on; team-remove takes a membership or an invite link", async () => {
    expect((await post({ action: "team-access", id: "ws-1", linkId: "l-1", teamRole: "viewer", houseScope: "all" })).status).toBe(200);
    expect(svc.updateServiceTeamAccess.mock.calls[0]![2]).toMatchObject({ id: "ws-1", linkId: "l-1", teamRole: "viewer", houseScope: "all" });
    await post({ action: "team-remove", id: "ws-1", inviteLinkId: "il-1" });
    expect(svc.removeServiceTeamMember.mock.calls[0]![2]).toMatchObject({ id: "ws-1", inviteLinkId: "il-1" });
  });

  it("create passes the owner's name and email or PropLane ID, and returns whether the owner invite went", async () => {
    const res = await post({ action: "create", name: "Seattle", city: "Seattle", ownerOfRecord: "Ambika Rao", ownerContact: "ambika@x.co" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: "ws-1", ownerInvite: { sent: true } });
    expect(svc.createServiceWorkspace.mock.calls[0]![2]).toMatchObject({ name: "Seattle", ownerOfRecord: "Ambika Rao", ownerContact: "ambika@x.co" });
  });
});

describe("the requests the Invite sheet builds", () => {
  const base = { role: "viewer" as const, houseScope: "selected" as const, houseIds: ["h1", "h2"], customPermissions: {}, workspacePermissions: {} };

  it("a named role posts its stamp over the chosen houses, with the recipient as email or PropLane ID", () => {
    const body = requests.serviceInviteRequest({ workspaceId: "ws-1", recipient: " a@b.co ", choice: base })!;
    expect(body).toMatchObject({ action: "team-invite", id: "ws-1", email: "a@b.co", teamRole: "viewer", houseScope: "selected", assignedPropertyIds: ["h1", "h2"] });
    expect(Object.keys(body.propertyCoManagerPermissions as object)).toEqual(["h1", "h2"]);
    expect(body).not.toHaveProperty("proplaneId");
    expect(requests.serviceInviteRequest({ workspaceId: "ws-1", recipient: "AX-1234", choice: base })).toMatchObject({ proplaneId: "AX-1234" });
    expect(requests.serviceInviteRequest({ workspaceId: "ws-1", recipient: "  ", choice: base })).toBeNull();
  });

  it("Custom posts the grid and its workspace rights; a named role posts none", () => {
    const custom = requests.serviceInviteRequest({
      workspaceId: "ws-1",
      recipient: "a@b.co",
      choice: { ...base, role: "custom", customPermissions: { payments: { read: true, notification: true } }, workspacePermissions: { teams: true } },
    })!;
    expect(custom.teamRole).toBe("custom");
    expect(custom.coManagerPermissions).toEqual({ payments: { read: true, notification: true } });
    expect(custom.workspacePermissions).toEqual({ teams: true });
    expect(requests.serviceInviteRequest({ workspaceId: "ws-1", recipient: "a@b.co", choice: { ...base, workspacePermissions: { teams: true } } })!.workspacePermissions).toEqual({});
  });

  it("Owner is its own shape: the owner-of-record flag, no houses, no module levels; replace only when confirmed", () => {
    const owner = requests.serviceInviteRequest({ workspaceId: "ws-1", recipient: "o@b.co", choice: { ...base, role: "property_owner" } })!;
    expect(owner).toEqual({ action: "team-invite", id: "ws-1", email: "o@b.co", ownerOfRecord: true });
    expect(requests.serviceInviteRequest({ workspaceId: "ws-1", recipient: "o@b.co", choice: { ...base, role: "property_owner" }, replaceOwner: true })).toMatchObject({ replaceOwner: true });
  });

  it("Edit access posts the same access fields for the seat", () => {
    expect(requests.serviceAccessRequest({ workspaceId: "ws-1", linkId: "l-1", choice: { ...base, houseScope: "all", houseIds: ["h1"] } })).toMatchObject({
      action: "team-access",
      id: "ws-1",
      linkId: "l-1",
      teamRole: "viewer",
      houseScope: "all",
      assignedPropertyIds: ["h1"],
    });
  });
});
