/** Every new Accounts > Managed by PropLane verb starts with requireAdminRoute(): signed out 401, non-admin 403, no service function runs. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const guard = vi.hoisted(() => ({ result: { ok: true, userId: "admin-1" } as { ok: true; userId: string } | { ok: false; response: Response } }));
vi.mock("@/lib/admin/admin-route-guard.server", () => ({ requireAdminRoute: async () => guard.result }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));

const managed = vi.hoisted(() => ({
  listAccountWorkspacesForManaging: vi.fn(async () => ({ ok: true as const, account: { id: "a", name: "A", email: "a@x.co" }, workspaces: [], managedCount: 0 })),
  manageAccountByProplane: vi.fn(async () => ({ ok: true as const, attached: ["ws-1"], moved: [], archived: [], kept: [], feeErrors: [] })),
}));
vi.mock("@/lib/service/managed-by-proplane.server", () => managed);
vi.mock("@/lib/service/service-workspaces.server", () => ({
  addServiceTeamMember: vi.fn(),
  attachWorkspaceToService: vi.fn(),
  authorizeOpenServiceWorkspace: vi.fn(),
  createServiceWorkspace: vi.fn(),
  inviteServiceClient: vi.fn(),
  listServiceAttachCandidates: vi.fn(),
  listServiceTeam: vi.fn(),
  listServiceWorkspaces: vi.fn(),
  releaseServiceWorkspaceOldNumber: vi.fn(),
  removeServiceTeamMember: vi.fn(),
  renameServiceWorkspace: vi.fn(),
  setServiceOwnerOfRecord: vi.fn(),
  setServiceWorkspaceFee: vi.fn(),
  updateServiceTeamAccess: vi.fn(),
}));

const { POST } = await import("@/app/api/admin/service-workspaces/route");
const post = (body: unknown) =>
  POST(new Request("https://prop-lane.space/api/admin/service-workspaces", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }));

beforeEach(() => {
  guard.result = { ok: true, userId: "admin-1" };
  for (const fn of Object.values(managed)) fn.mockClear();
});

describe("account-workspaces / manage-by-proplane", () => {
  it.each(["account-workspaces", "manage-by-proplane"])("%s: signed out 401, non-admin 403, and no service function runs", async (action) => {
    guard.result = { ok: false, response: new Response(JSON.stringify({ error: "Unauthorized." }), { status: 401 }) };
    expect((await post({ action, accountUserId: "u", mode: "pick", workspaceIds: ["w"] })).status).toBe(401);
    guard.result = { ok: false, response: new Response(JSON.stringify({ error: "Forbidden." }), { status: 403 }) };
    expect((await post({ action, accountUserId: "u", mode: "pick", workspaceIds: ["w"] })).status).toBe(403);
    for (const fn of Object.values(managed)) expect(fn).not.toHaveBeenCalled();
  });

  it("passes the body on as a request with the admin's id from the session, never the body", async () => {
    const res = await post({ action: "manage-by-proplane", accountUserId: "acct", mode: "combine", workspaceIds: ["w1", "w2"], targetId: "w1", city: "Seattle", feePercent: 8, userId: "forged", operatorUserId: "forged" });
    expect(res.status).toBe(201);
    expect(managed.manageAccountByProplane).toHaveBeenCalledWith(expect.anything(), "admin-1", {
      accountUserId: "acct",
      mode: "combine",
      workspaceIds: ["w1", "w2"],
      targetId: "w1",
      city: "Seattle",
      label: undefined,
      feePercent: 8,
    });
    const listed = await post({ action: "account-workspaces", accountUserId: "acct" });
    expect(listed.status).toBe(200);
    expect(managed.listAccountWorkspacesForManaging).toHaveBeenCalledWith(expect.anything(), "admin-1", "acct");
  });
});
