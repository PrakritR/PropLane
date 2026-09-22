import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabaseClient, type Row } from "./helpers/fake-supabase-tables";

/**
 * A manager with more than one workspace must see and manage only the
 * active workspace's owner distributions and property-owner rows. Both
 * `manager_owner_distributions.property_id` and
 * `manager_property_owners.property_id` are `not null`, so there is no
 * account-level branch here — every row narrows by house alone. These fail
 * against pre-fix `manager-owner-distributions.server.ts`
 * (`.eq("manager_user_id", …)` alone).
 */

const state = vi.hoisted(() => ({ cookieValue: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => (state.cookieValue !== undefined ? { value: state.cookieValue } : undefined) })),
}));

const mocks = vi.hoisted(() => ({ loadWorkspaces: vi.fn(), postGlOwnerDistribution: vi.fn() }));
vi.mock("@/lib/workspaces/server", () => ({ loadWorkspaces: mocks.loadWorkspaces }));
vi.mock("@/lib/reports/gl-posting", () => ({ postGlOwnerDistribution: mocks.postGlOwnerDistribution }));

import {
  approveOwnerDistribution,
  createOwnerDistribution,
  listOwnerDistributions,
  listPropertyOwners,
  payOwnerDistribution,
  upsertPropertyOwner,
} from "@/lib/manager-owner-distributions.server";

const MANAGER = "mgr-1";
const WS_A = { id: "ws-a", name: "A", ownerUserId: MANAGER, owned: true, isDefault: true, propertyIds: ["p1"] };
const WS_B = { id: "ws-b", name: "B", ownerUserId: MANAGER, owned: true, isDefault: false, propertyIds: ["p2"] };
const WS_EMPTY = { id: "ws-empty", name: "Empty", ownerUserId: MANAGER, owned: true, isDefault: false, propertyIds: [] };

function distributionRow(id: string, propertyId: string, status = "draft") {
  return {
    id,
    manager_user_id: MANAGER,
    property_id: propertyId,
    owner_id: null,
    period_start: "2026-01-01",
    period_end: "2026-01-31",
    beginning_balance_cents: 0,
    cash_in_cents: 100000,
    cash_out_cents: 0,
    management_fee_cents: 10000,
    reserve_holdback_cents: 0,
    adjustments_cents: 0,
    distribution_cents: 90000,
    status,
  };
}

beforeEach(() => {
  state.cookieValue = undefined;
  mocks.loadWorkspaces.mockReset();
  mocks.postGlOwnerDistribution.mockReset();
  mocks.postGlOwnerDistribution.mockResolvedValue(undefined);
});

describe("listOwnerDistributions — active-workspace scoping", () => {
  it("a manager with two workspaces sees only workspace A's distributions while A is active", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_A.id;
    const db = fakeSupabaseClient({ manager_owner_distributions: [distributionRow("d-a", "p1"), distributionRow("d-b", "p2")] });
    const rows = await listOwnerDistributions(db as never, MANAGER);
    expect(rows.map((r) => r.id)).toEqual(["d-a"]);
  });

  it("switching to workspace B shows only B's distributions", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_B.id;
    const db = fakeSupabaseClient({ manager_owner_distributions: [distributionRow("d-a", "p1"), distributionRow("d-b", "p2")] });
    const rows = await listOwnerDistributions(db as never, MANAGER);
    expect(rows.map((r) => r.id)).toEqual(["d-b"]);
  });

  it("an empty active workspace yields none", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_EMPTY]);
    state.cookieValue = WS_EMPTY.id;
    const db = fakeSupabaseClient({ manager_owner_distributions: [distributionRow("d-a", "p1")] });
    expect(await listOwnerDistributions(db as never, MANAGER)).toEqual([]);
  });

  it("a single-workspace manager is unaffected", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A]);
    const db = fakeSupabaseClient({ manager_owner_distributions: [distributionRow("d-a", "p1")] });
    const rows = await listOwnerDistributions(db as never, MANAGER);
    expect(rows.map((r) => r.id)).toEqual(["d-a"]);
  });
});

describe("listPropertyOwners — active-workspace scoping", () => {
  function ownerRow(id: string, propertyId: string) {
    return { id, manager_user_id: MANAGER, property_id: propertyId, owner_name: "Owner", ownership_pct: 100 };
  }

  it("scopes to the active workspace's houses", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_A.id;
    const db = fakeSupabaseClient({ manager_property_owners: [ownerRow("o-a", "p1"), ownerRow("o-b", "p2")] });
    const owners = await listPropertyOwners(db as never, MANAGER);
    expect(owners.map((o) => o.id)).toEqual(["o-a"]);
  });
});

describe("createOwnerDistribution / upsertPropertyOwner — active-workspace guard", () => {
  it("refuses a distribution for a property outside the active workspace", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_A.id;
    const db = fakeSupabaseClient({ manager_owner_distributions: [] as Row[] });
    await expect(
      createOwnerDistribution(db as never, {
        managerUserId: MANAGER,
        propertyId: "p2",
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
      }),
    ).rejects.toThrow(/outside your active workspace/);
  });

  it("allows a distribution for a property inside the active workspace", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_A.id;
    const db = fakeSupabaseClient({ manager_owner_distributions: [] as Row[] });
    const d = await createOwnerDistribution(db as never, {
      managerUserId: MANAGER,
      propertyId: "p1",
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
    });
    expect(d.propertyId).toBe("p1");
  });

  it("refuses a property-owner row for a property outside the active workspace", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_A.id;
    const db = fakeSupabaseClient({ manager_property_owners: [] as Row[] });
    await expect(
      upsertPropertyOwner(db as never, { managerUserId: MANAGER, propertyId: "p2", ownerName: "Jane" }),
    ).rejects.toThrow(/outside your active workspace/);
  });
});

describe("approveOwnerDistribution / payOwnerDistribution — active-workspace guard", () => {
  it("refuses to approve a distribution whose property is outside the active workspace", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_A.id;
    const db = fakeSupabaseClient({ manager_owner_distributions: [distributionRow("d1", "p2")] });
    await expect(approveOwnerDistribution(db as never, MANAGER, "d1")).rejects.toThrow(/Owner distribution not found/);
  });

  it("approves and pays a distribution whose property IS inside the active workspace", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_A.id;
    const db = fakeSupabaseClient({ manager_owner_distributions: [distributionRow("d1", "p1")] });
    const approved = await approveOwnerDistribution(db as never, MANAGER, "d1");
    expect(approved.status).toBe("approved");
    const paid = await payOwnerDistribution(db as never, MANAGER, "d1");
    expect(paid.status).toBe("paid");
  });
});
