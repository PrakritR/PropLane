import { describe, it, expect, vi, beforeEach } from "vitest";

// Route dependencies stubbed so the test focuses on the paid-sticky / unmark logic.
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: vi.fn().mockResolvedValue(false) }));
vi.mock("@/lib/payment-automation-settings", () => ({
  DEFAULT_MANAGER_AUTOMATION_SETTINGS: {},
  loadManagerAutomationSettings: vi.fn().mockResolvedValue({}),
}));
vi.mock("@/lib/payment-reminder-bootstrap", () => ({
  ensureChargeDueDateForReminders: vi.fn((c: unknown) => c),
}));
vi.mock("@/lib/reports/ledger-sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reports/ledger-sync")>();
  return {
    ...actual,
    reconcileDuplicateChargeList: vi.fn().mockResolvedValue({ removedChargeIds: [] }),
    syncLedgerChargeEntry: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock("@/lib/payment-reminder-lifecycle.server", () => ({
  cancelFuturePaymentRemindersForCharge: vi.fn().mockResolvedValue(undefined),
  restoreFuturePaymentRemindersForCharge: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/household-charge-payment-eligibility", () => ({
  enrichHouseholdChargesFromPropertyRecords: vi.fn((c: unknown) => c),
}));
vi.mock("@/lib/auth/manager-lease-scope", () => ({
  managerHasCoManagerPermissionForProperty: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/lib/auth/co-manager-module-scope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/co-manager-module-scope")>()),
  fetchRowsForManagerWithLinked: vi.fn(),
  linkedPropertyIdsForModule: vi.fn(),
  resolveManagerWorkspaceRowScope: vi.fn().mockResolvedValue({ propertyIds: null, untaggedOwnedVisible: true }),
}));

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { syncLedgerChargeEntry } from "@/lib/reports/ledger-sync";
import { POST } from "@/app/api/portal-household-charges/route";

type Stored = { status: string; manager_user_id: string; property_id: string | null; row_data: Record<string, unknown>; updated_at?: string };
const STORED_AT = "2026-10-01T00:00:00.000Z";

function makeDb(seed: Record<string, Stored>) {
  const stored = new Map<string, Stored>(Object.entries(seed).map(([id, row]) => [id, { updated_at: STORED_AT, ...row }]));
  const upserted: Array<Record<string, unknown>> = [];
  const db = {
    from(table: string) {
      if (table === "profiles") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { email: "mgr@test.com", role: "manager" } }) }) }),
        };
      }
      if (table === "profile_roles") {
        return { select: () => ({ eq: async () => ({ data: [{ role: "manager" }] }) }) };
      }
      if (table === "portal_household_charge_records") {
        return {
          select: () => ({
            in: async (_col: string, ids: string[]) => ({
              data: ids.filter((id) => stored.has(id)).map((id) => ({ id, ...stored.get(id)! })),
            }),
            eq: (_col: string, id: string) => ({
              maybeSingle: async () => ({ data: stored.has(id) ? { id, ...stored.get(id)! } : null }),
            }),
          }),
          // Existing rows are compare-and-set on (status, updated_at); new ids are insert-only.
          insert: (r: Record<string, unknown>) => {
            upserted.push(r);
            stored.set(String(r.id), {
              status: String(r.status), manager_user_id: String(r.manager_user_id),
              property_id: (r.property_id as string | null) ?? null,
              row_data: r.row_data as Record<string, unknown>, updated_at: STORED_AT,
            });
            return { select: async () => ({ data: [{ id: r.id }], error: null }) };
          },
          update: (patch: Record<string, unknown>) => {
            const filters: Record<string, unknown> = {};
            const chain = {
              eq: (col: string, value: unknown) => { filters[col] = value; return chain; },
              select: async () => {
                const id = String(filters.id);
                const cur = stored.get(id);
                if (!cur || cur.status !== filters.status || cur.updated_at !== filters.updated_at) {
                  return { data: [], error: null };
                }
                upserted.push({ id, ...patch });
                stored.set(id, { ...cur, status: String(patch.status), row_data: patch.row_data as Record<string, unknown> });
                return { data: [{ id }], error: null };
              },
            };
            return chain;
          },
        };
      }
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) };
    },
  };
  return { db, stored, upserted };
}

function jsonReq(body: unknown): Request {
  return new Request("http://localhost/api/portal-household-charges", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("portal-household-charges POST — paid is sticky", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "mgr_1", email: "mgr@test.com" } } }) },
    } as never);
  });

  it("does NOT downgrade a stored-paid charge when a stale full-list mirror sends it as pending", async () => {
    const { db, stored, upserted } = makeDb({
      hc_1: { status: "paid", manager_user_id: "mgr_1", property_id: "prop_1", row_data: { id: "hc_1", status: "paid" } },
    });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);

    const res = await POST(
      jsonReq({
        action: "replace",
        charges: [{ id: "hc_1", status: "pending", propertyId: "prop_1", residentEmail: "r@test.com" }],
      }),
    );

    expect(res.status).toBe(200);
    // The paid row is untouched and the downgrade was skipped from the upsert.
    expect(stored.get("hc_1")!.status).toBe("paid");
    expect(upserted.find((r) => r.id === "hc_1")).toBeUndefined();
  });

  it("does NOT promote a pending charge to paid from the browser mirror (payment authority is server-only)", async () => {
    const { db, stored, upserted } = makeDb({
      hc_2: { status: "pending", manager_user_id: "mgr_1", property_id: "prop_1", row_data: { id: "hc_2", status: "pending" } },
    });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);

    const res = await POST(
      jsonReq({
        action: "replace",
        charges: [{ id: "hc_2", status: "paid", propertyId: "prop_1", residentEmail: "r@test.com",
          paidAt: "2026-10-01T00:00:00.000Z", paidMethod: "check" }],
      }),
    );

    expect(res.status).toBe(200);
    expect(stored.get("hc_2")!.status).toBe("pending");
    expect(stored.get("hc_2")!.row_data).not.toHaveProperty("paidAt");
    expect(upserted).toHaveLength(0);
    expect(syncLedgerChargeEntry).not.toHaveBeenCalled();
  });

  it("returns 200 when the ledger/GL write-through rejects — the charge row is already persisted", async () => {
    const { db, stored } = makeDb({
      hc_4: { status: "pending", manager_user_id: "mgr_1", property_id: "prop_1",
        row_data: { id: "hc_4", status: "pending", title: "Rent" } },
    });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);
    vi.mocked(syncLedgerChargeEntry).mockRejectedValueOnce(new Error("duplicate ledger entry"));

    const res = await POST(
      jsonReq({
        action: "replace",
        charges: [{ id: "hc_4", status: "pending", title: "Rent (edited)", propertyId: "prop_1", residentEmail: "r@test.com" }],
      }),
    );

    expect(res.status).toBe(200);
    expect(syncLedgerChargeEntry).toHaveBeenCalled();
    expect((stored.get("hc_4")!.row_data as { title?: string }).title).toBe("Rent (edited)");
  });

  it("skips ledger sync when a mirror POST repeats unchanged charge rows", async () => {
    const unchanged = {
      id: "hc_5",
      status: "pending",
      propertyId: "prop_1",
      residentEmail: "r@test.com",
      amountLabel: "$500.00",
      balanceLabel: "$500.00",
      title: "Rent",
      kind: "rent",
    };
    const { db } = makeDb({
      hc_5: {
        status: "pending",
        manager_user_id: "mgr_1",
        property_id: "prop_1",
        row_data: unchanged,
      },
    });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);

    const res = await POST(jsonReq({ action: "replace", charges: [unchanged] }));

    expect(res.status).toBe(200);
    expect(syncLedgerChargeEntry).not.toHaveBeenCalled();
  });

  it("action:'unmarkPaid' refuses to revert a paid receipt and leaves the row untouched", async () => {
    const { db, stored } = makeDb({
      hc_3: {
        status: "paid",
        manager_user_id: "mgr_1",
        property_id: "prop_1",
        row_data: { id: "hc_3", status: "paid", amountLabel: "$100.00", balanceLabel: "$0.00" },
      },
    });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);

    const res = await POST(jsonReq({ action: "unmarkPaid", id: "hc_3" }));

    // Approved contract: no accounting-safe reversal exists for a recorded receipt.
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Receipt correction is not available.");
    expect(stored.get("hc_3")!.status).toBe("paid");
    expect((stored.get("hc_3")!.row_data as { balanceLabel?: string }).balanceLabel).toBe("$0.00");
    expect(syncLedgerChargeEntry).not.toHaveBeenCalled();
  });
});
