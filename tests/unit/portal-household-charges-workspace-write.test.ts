/**
 * Batch A — active-workspace scoping. `POST /api/portal-household-charges`
 * must refuse a delete of a charge outside the caller's active workspace, and
 * must refuse to CREATE a new charge under a property outside it. Read scoping
 * for this route is covered at the shared-loader level in
 * `manager-workspace-row-scope.test.ts`; this file is the write-path proof.
 *
 * `resolveManagerWorkspaceRowScope` is mocked directly (its own resolution is
 * covered elsewhere) while the real `rowInWorkspaceScope` decides the outcome,
 * so this is a genuine test of the route's guard wiring.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const getUser = vi.fn();
const isAdminUser = vi.fn(async () => false);
const resolveManagerWorkspaceRowScope = vi.fn();
const managerHasCoManagerPermissionForProperty = vi.fn(async () => false);
const syncLedgerPaymentEntry = vi.fn(async () => undefined);
const resolvePropertyPayoutOwners = vi.fn(async () => new Map());

type Row = Record<string, unknown>;
const state = {
  profile: { email: "mgr@test.local", role: "manager" } as Row | null,
  roles: [{ role: "manager" }] as Row[],
  charges: new Map<string, Row>(),
  deletedIds: [] as string[],
  upserted: [] as Row[],
};

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: (...a: unknown[]) => isAdminUser(...(a as [])) }));
vi.mock("@/lib/auth/manager-lease-scope", () => ({
  managerHasCoManagerPermissionForProperty: (...a: unknown[]) => managerHasCoManagerPermissionForProperty(...(a as [])),
}));
vi.mock("@/lib/auth/co-manager-module-scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/co-manager-module-scope")>();
  return {
    ...actual,
    fetchRowsForManagerWithLinked: async () => [],
    linkedPropertyIdsForModule: async () => new Set<string>(),
    resolveManagerWorkspaceRowScope: (...a: unknown[]) => resolveManagerWorkspaceRowScope(...(a as [])),
  };
});
vi.mock("@/lib/household-charge-payment-eligibility.server", () => ({
  enrichHouseholdChargesFromPropertyRecords: async (_db: unknown, charges: unknown[]) => charges,
}));
vi.mock("@/lib/payment-reminder-lifecycle.server", () => ({
  cancelFuturePaymentRemindersForCharge: async () => undefined,
  restoreFuturePaymentRemindersForCharge: async () => undefined,
}));
vi.mock("@/lib/payment-automation-settings", () => ({
  DEFAULT_MANAGER_AUTOMATION_SETTINGS: {},
  loadManagerAutomationSettings: async () => ({}),
}));
vi.mock("@/lib/payment-reminder-bootstrap", () => ({
  ensureChargeDueDateForReminders: (charge: unknown) => charge,
}));
vi.mock("@/lib/reports/ledger-sync", () => ({
  deleteLedgerEntriesForCharge: async () => undefined,
  householdChargeLedgerFingerprint: () => "fp",
  reconcileDuplicateChargeList: async () => undefined,
  syncLedgerChargeEntry: async () => undefined,
  syncLedgerPaymentEntry: (...args: unknown[]) => syncLedgerPaymentEntry(...(args as [])),
}));
vi.mock("@/lib/domain-action-events.server", () => ({ emitHouseholdChargeTransition: async () => undefined }));
vi.mock("@/lib/payments/property-payout-owner.server", () => ({
  resolvePropertyPayoutOwners: (...a: unknown[]) => resolvePropertyPayoutOwners(...(a as [])),
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from(table: string) {
      if (table === "profiles") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.profile }) }) }) };
      }
      if (table === "profile_roles") {
        return { select: () => ({ eq: async () => ({ data: state.roles }) }) };
      }
      if (table === "portal_household_charge_records") {
        return {
          select: (_cols: string) => ({
            eq: (_col: string, id: string) => ({
              maybeSingle: async () => ({ data: state.charges.get(id) ?? null }),
            }),
            in: (_col: string, ids: string[]) => ({
              then: (resolve: (v: unknown) => unknown) =>
                Promise.resolve({
                  data: ids.map((id) => state.charges.get(id)).filter(Boolean),
                  error: null,
                }).then(resolve),
            }),
          }),
          update: (patch: Row) => {
            const filters: Record<string, unknown> = {};
            const query = {
              eq: (key: string, value: unknown) => { filters[key] = value; return query; },
              is: (key: string, value: unknown) => { filters[key] = value; return query; },
              select: () => query,
              maybeSingle: async () => {
                const row = state.charges.get(String(filters.id));
                if (!row || Object.entries(filters).some(([key, value]) => key !== "id" && (row[key] ?? null) !== value)) return { data: null, error: null };
                state.charges.set(String(filters.id), { ...row, ...patch });
                return { data: { id: filters.id }, error: null };
              },
            };
            return query;
          },
          delete: () => ({
            eq: async (_col: string, id: string) => {
              state.deletedIds.push(id);
              return { data: null, error: null };
            },
          }),
          upsert: async (rows: Row[]) => {
            state.upserted.push(...rows);
            for (const row of rows) state.charges.set(String(row.id), row);
            return { data: null, error: null };
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  }),
}));

const { POST } = await import("@/app/api/portal-household-charges/route");

const post = (body: unknown) =>
  POST(new Request("https://prop-lane.space/api/portal-household-charges", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  isAdminUser.mockResolvedValue(false);
  state.profile = { email: "mgr@test.local", role: "manager" };
  state.roles = [{ role: "manager" }];
  state.charges = new Map();
  state.deletedIds = [];
  state.upserted = [];
  getUser.mockResolvedValue({ data: { user: { id: "mgr-1", email: "mgr@test.local" } } });
  resolvePropertyPayoutOwners.mockResolvedValue(new Map());
});

describe("deleteCharge — refuses a row outside the active workspace", () => {
  it("refuses to delete a charge whose house is outside the active workspace", async () => {
    resolveManagerWorkspaceRowScope.mockResolvedValue({ propertyIds: ["prop-a"], untaggedOwnedVisible: true });
    state.charges.set("chg-1", { id: "chg-1", manager_user_id: "mgr-1", property_id: "prop-outside" });

    const res = await post({ action: "deleteCharge", id: "chg-1" });

    expect(res.status).toBe(403);
    expect(state.deletedIds).toEqual([]);
  });

  it("allows the delete when the charge's house is in the active workspace", async () => {
    resolveManagerWorkspaceRowScope.mockResolvedValue({ propertyIds: ["prop-a"], untaggedOwnedVisible: true });
    state.charges.set("chg-1", { id: "chg-1", manager_user_id: "mgr-1", property_id: "prop-a" });

    const res = await post({ action: "deleteCharge", id: "chg-1" });

    expect(res.status).toBe(200);
    expect(state.deletedIds).toEqual(["chg-1"]);
  });

  it("allows deleting the manager's own account-level (no-property) charge in their default workspace", async () => {
    resolveManagerWorkspaceRowScope.mockResolvedValue({ propertyIds: ["prop-a"], untaggedOwnedVisible: true });
    state.charges.set("chg-1", { id: "chg-1", manager_user_id: "mgr-1", property_id: null });

    const res = await post({ action: "deleteCharge", id: "chg-1" });

    expect(res.status).toBe(200);
    expect(state.deletedIds).toEqual(["chg-1"]);
  });

  it("refuses that same account-level charge once a non-default workspace is active", async () => {
    resolveManagerWorkspaceRowScope.mockResolvedValue({ propertyIds: ["prop-b"], untaggedOwnedVisible: false });
    state.charges.set("chg-1", { id: "chg-1", manager_user_id: "mgr-1", property_id: null });

    const res = await post({ action: "deleteCharge", id: "chg-1" });

    expect(res.status).toBe(403);
    expect(state.deletedIds).toEqual([]);
  });
});

describe("charges upsert — a new charge must land in the active workspace", () => {
  it("skips creating a charge under a property outside the active workspace", async () => {
    resolveManagerWorkspaceRowScope.mockResolvedValue({ propertyIds: ["prop-a"], untaggedOwnedVisible: true });

    const res = await post({
      charges: [{ id: "chg-new", propertyId: "prop-outside", status: "pending", kind: "rent" }],
    });

    expect(res.status).toBe(200);
    expect(state.upserted).toEqual([]);
  });

  it("creates a charge under a property inside the active workspace", async () => {
    resolveManagerWorkspaceRowScope.mockResolvedValue({ propertyIds: ["prop-a"], untaggedOwnedVisible: true });

    const res = await post({
      charges: [{ id: "chg-new", propertyId: "prop-a", status: "pending", kind: "rent" }],
    });

    expect(res.status).toBe(200);
    expect(state.upserted.map((r) => r.id)).toEqual(["chg-new"]);
  });
});


describe("offline receipt server authority", () => {
  const id = "receipt-charge";
  const receipt = { action: "recordOfflinePayment", id, paidAt: "2026-01-02T12:00:00.000Z", method: "Check", note: "Check 42" };
  beforeEach(() => {
    resolveManagerWorkspaceRowScope.mockResolvedValue({ propertyIds: null, untaggedOwnedVisible: true });
    state.charges.set(id, { manager_user_id: "mgr-1", property_id: "prop-1", status: "pending", updated_at: "2026-01-01", row_data: { id, status: "pending", amountLabel: "$98.76", balanceLabel: "$98.76", kind: "rent" } });
  });
  it("uses current server amount and writes the payment ledger before success", async () => {
    const response = await post({ ...receipt, amountLabel: "$0.01", charges: [{ amountLabel: "$0.01" }] });
    expect(response.status).toBe(200);
    expect((await response.json()).charge).toMatchObject({ amountLabel: "$98.76", paidAt: receipt.paidAt, paidMethod: "Check", paidNote: "Check 42" });
    expect(syncLedgerPaymentEntry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ amountLabel: "$98.76", managerUserId: "mgr-1", status: "paid" }));
  });
  it("rejects processing and paid charges belonging to a different receipt", async () => {
    state.charges.get(id)!.status = "processing";
    expect((await post(receipt)).status).toBe(409);
    state.charges.get(id)!.status = "paid";
    expect((await post(receipt)).status).toBe(409);
    expect(syncLedgerPaymentEntry).not.toHaveBeenCalled();
  });
  it("rejects an out-of-workspace charge and invalid future payment date", async () => {
    resolveManagerWorkspaceRowScope.mockResolvedValue({ propertyIds: ["elsewhere"], untaggedOwnedVisible: false });
    expect((await post(receipt)).status).toBe(403);
    expect((await post({ ...receipt, paidAt: "2999-01-01" })).status).toBe(400);
  });
  it("reports a ledger failure and repairs it on the same receipt retry", async () => {
    syncLedgerPaymentEntry.mockRejectedValueOnce(new Error("ledger unavailable"));
    expect((await post(receipt)).status).toBe(500);
    expect(state.charges.get(id)!.status).toBe("paid");
    expect((await post(receipt)).status).toBe(200);
    expect(syncLedgerPaymentEntry).toHaveBeenCalledTimes(2);
  });
  it("retries ledger repair for the identical persisted receipt", async () => {
    expect((await post(receipt)).status).toBe(200);
    expect((await post(receipt)).status).toBe(200);
    expect(syncLedgerPaymentEntry).toHaveBeenCalledTimes(2);
  });
});
