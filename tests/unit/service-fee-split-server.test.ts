/**
 * Who may read and who may write a PropLane Service workspace's fee split.
 *
 * Write: `POST /api/admin/service-workspaces` starts with `requireAdminRoute()`, and `setServiceWorkspaceFee`
 * re-checks the admin role, so a non-admin never reaches a fee version. Read: `readServiceFeeSplitForViewer`
 * answers an admin (editable), the workspace owner or a seat (read only) and refuses everyone else with the same 404
 * a non-service workspace gets.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { targetMonthlyFeeCents, type ManagedFeeTerms } from "@/lib/owner-management/fee-math";
import { managementFeeSplitCents } from "@/lib/owner-management/fee-percent";

const WS = "11111111-1111-4111-8111-111111111111";
const ADMIN = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const OWNER = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";
const SEAT = "cccccccc-1111-4111-8111-cccccccccccc";
const STRANGER = "dddddddd-1111-4111-8111-dddddddddddd";

const h = vi.hoisted(() => ({
  admins: new Set<string>(),
  guard: null as null | { ok: true; userId: string } | { ok: false; status: number },
  setFee: vi.fn(),
  sessionUser: null as null | { id: string },
  serviceWorkspace: null as null | { id: string; ownerUserId: string },
  standings: new Map<string, { role: string | null }>(),
  active: null as null | { ownerUserId: string; effectiveFrom: string; createdAt: string; terms: { ownerShareBps: number } },
  versions: [] as { signedAt: string | null; createdAt: string }[],
}));

vi.mock("@/lib/admin/admin-route-guard.server", () => ({
  requireAdminRoute: async () =>
    h.guard && h.guard.ok
      ? h.guard
      : { ok: false, response: NextResponse.json({ error: "Forbidden." }, { status: h.guard && !h.guard.ok ? h.guard.status : 401 }) },
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: h.sessionUser } }) } }),
}));
vi.mock("@/lib/service/service-workspaces.server", () => ({
  setServiceWorkspaceFee: h.setFee,
  addServiceTeamMember: vi.fn(),
  attachWorkspaceToService: vi.fn(),
  authorizeOpenServiceWorkspace: vi.fn(),
  createServiceWorkspace: vi.fn(),
  inviteServiceClient: vi.fn(),
  listServiceAttachCandidates: vi.fn(),
  listServiceTeam: vi.fn(),
  listServiceWorkspaces: vi.fn(),
  removeServiceTeamMember: vi.fn(),
  renameServiceWorkspace: vi.fn(),
  setServiceOwnerOfRecord: vi.fn(),
}));
vi.mock("@/lib/auth/admin-role", () => ({
  userHoldsAdminRole: async (_db: unknown, id: string) => h.admins.has(id),
  listAdminUserIds: async () => [...h.admins],
}));
vi.mock("@/lib/service/service-owner.server", () => ({
  loadServiceWorkspace: async (_db: unknown, id: string) => (h.serviceWorkspace && h.serviceWorkspace.id === id ? h.serviceWorkspace : null),
}));
vi.mock("@/lib/workspaces/membership.server", () => ({
  actorWorkspaceStanding: async (_db: unknown, actor: string) => h.standings.get(actor) ?? null,
}));
vi.mock("@/lib/owner-management/policies.server", () => ({
  loadActivePolicyForWorkspace: async () => h.active,
  listPoliciesForWorkspace: async () => h.versions,
}));

const adminRoute = await import("@/app/api/admin/service-workspaces/route");
const feeRoute = await import("@/app/api/workspaces/service-fee/route");
const { readServiceFeeSplitForViewer } = await import("@/lib/owner-management/service-fee-split.server");

function post(body: unknown) {
  return adminRoute.POST(new Request("http://localhost/api/admin/service-workspaces", { method: "POST", body: JSON.stringify(body) }));
}
function get(workspaceId = WS) {
  return feeRoute.GET(new Request(`http://localhost/api/workspaces/service-fee?workspaceId=${workspaceId}`));
}

beforeEach(() => {
  h.admins = new Set([ADMIN]);
  h.guard = null;
  h.setFee.mockReset();
  h.sessionUser = null;
  h.serviceWorkspace = { id: WS, ownerUserId: OWNER };
  h.standings = new Map([
    [OWNER, { role: "owner" }],
    [SEAT, { role: "property_manager" }],
    [STRANGER, { role: null }],
  ]);
  h.active = { ownerUserId: OWNER, effectiveFrom: "2026-10-20", createdAt: "2026-10-20T10:00:00Z", terms: { ownerShareBps: 9000 } };
  h.versions = [
    { signedAt: "2026-10-01T00:00:00Z", createdAt: "2026-10-01T00:00:00Z" },
    { signedAt: "2026-10-20T10:00:00Z", createdAt: "2026-10-20T10:00:00Z" },
    { signedAt: null, createdAt: "2026-10-22T00:00:00Z" },
  ];
});

describe("writing the fee split", () => {
  it("refuses a signed-out caller before any fee code runs", async () => {
    h.guard = { ok: false, status: 401 };
    expect((await post({ action: "fee", id: WS, percent: 12 })).status).toBe(401);
    expect(h.setFee).not.toHaveBeenCalled();
  });

  it("refuses a signed-in non-admin (the owner included) with 403 and never calls the fee writer", async () => {
    h.guard = { ok: false, status: 403 };
    const res = await post({ action: "fee", id: WS, percent: 12 });
    expect(res.status).toBe(403);
    expect(h.setFee).not.toHaveBeenCalled();
  });

  it("lets an admin through with the percent and the workspace id from the body as names only", async () => {
    h.guard = { ok: true, userId: ADMIN };
    h.setFee.mockResolvedValue({ ok: true, feePercent: 12, changed: true, policyId: "p1" });
    const res = await post({ action: "fee", id: WS, percent: 12 });
    expect(res.status).toBe(200);
    expect(h.setFee).toHaveBeenCalledWith({}, ADMIN, { id: WS, percent: 12 });
  });

  it("the service layer re-checks the admin role on its own", async () => {
    const real = await vi.importActual<typeof import("@/lib/service/service-workspaces.server")>("@/lib/service/service-workspaces.server");
    const result = await real.setServiceWorkspaceFee({} as never, OWNER, { id: WS, percent: 12 });
    expect(result).toMatchObject({ ok: false, status: 403 });
  });
});

describe("reading the fee split", () => {
  it("GET refuses a signed-out caller", async () => {
    expect((await get()).status).toBe(401);
  });

  it("an admin reads it editable", async () => {
    const r = await readServiceFeeSplitForViewer({} as never, ADMIN, WS);
    expect(r).toEqual({
      ok: true,
      view: { split: { feePercent: 10, version: 2, since: "2026-10-20" }, canEdit: true, viewerIsOwnerOfRecord: false },
    });
  });

  it("the owner of record reads it read-only and is told they are the owner", async () => {
    const r = await readServiceFeeSplitForViewer({} as never, OWNER, WS);
    expect(r).toMatchObject({ ok: true, view: { canEdit: false, viewerIsOwnerOfRecord: true, split: { feePercent: 10 } } });
  });

  it("another seat reads it read-only and is not the owner of record", async () => {
    const r = await readServiceFeeSplitForViewer({} as never, SEAT, WS);
    expect(r).toMatchObject({ ok: true, view: { canEdit: false, viewerIsOwnerOfRecord: false } });
  });

  it("a stranger, an unknown viewer and a non-service workspace all get the same 404", async () => {
    expect(await readServiceFeeSplitForViewer({} as never, STRANGER, WS)).toMatchObject({ ok: false, status: 404 });
    expect(await readServiceFeeSplitForViewer({} as never, "eeeeeeee-1111-4111-8111-eeeeeeeeeeee", WS)).toMatchObject({ ok: false, status: 404 });
    h.serviceWorkspace = null;
    expect(await readServiceFeeSplitForViewer({} as never, ADMIN, WS)).toMatchObject({ ok: false, status: 404 });
    expect(await readServiceFeeSplitForViewer({} as never, OWNER, WS)).toMatchObject({ ok: false, status: 404 });
  });

  it("the route turns a stranger into a 404 and returns the view for a seat", async () => {
    h.sessionUser = { id: STRANGER };
    expect((await get()).status).toBe(404);
    h.sessionUser = { id: SEAT };
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ canEdit: false, split: { feePercent: 10, version: 2 } });
  });

  it("a workspace with no fee in force has no split", async () => {
    h.active = null;
    expect(await readServiceFeeSplitForViewer({} as never, ADMIN, WS)).toEqual({
      ok: true,
      view: { split: null, canEdit: true, viewerIsOwnerOfRecord: false },
    });
  });
});

describe("the card's example matches the real money model", () => {
  it("agrees with targetMonthlyFeeCents for a month's rent with no minimum", () => {
    for (const percent of [0, 5, 7.5, 10, 12.34, 30]) {
      const ownerShareBps = Math.round(10_000 - percent * 100);
      const terms: ManagedFeeTerms = {
        ownerShareBps,
        appliesTo: "rent",
        leasingFeeBps: 0,
        minFeeCents: 0,
        reserveTargetCents: 0,
        repairApprovalThresholdCents: 0,
      };
      for (const rent of [100_000, 99_999, 123_457]) {
        const split = managementFeeSplitCents(rent, percent);
        expect(split.feeCents).toBe(targetMonthlyFeeCents(terms, rent));
        expect(split.feeCents + split.ownerCents).toBe(rent);
      }
    }
  });
});
