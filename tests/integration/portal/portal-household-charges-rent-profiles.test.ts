import { describe, it, expect, vi, beforeEach } from "vitest";

// Route dependencies stubbed so the test focuses on the recurring-rent-profile
// mirror scoping: a co-manager's full-list mirror must never reassign or
// relabel a profile row owned by another manager.
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
vi.mock("@/lib/auth/co-manager-module-scope", () => ({
  fetchRowsForManagerWithLinked: vi.fn(),
  linkedPropertyIdsForModule: vi.fn(),
}));

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { managerHasCoManagerPermissionForProperty } from "@/lib/auth/manager-lease-scope";
import { POST } from "@/app/api/portal-household-charges/route";

type StoredProfile = {
  manager_user_id: string | null;
  property_id: string | null;
  row_data: Record<string, unknown>;
};

function makeDb(
  seedProfiles: Record<string, StoredProfile>,
  opts?: { profileLookupError?: string; chargeLookupError?: string },
) {
  const profiles = new Map<string, StoredProfile>(Object.entries(seedProfiles));
  const upsertedProfiles: Array<Record<string, unknown>> = [];
  const upsertedCharges: Array<Record<string, unknown>> = [];
  const db = {
    from(table: string) {
      if (table === "portal_household_charge_records") {
        return {
          select: () => ({
            in: async () =>
              opts?.chargeLookupError
                ? { data: null, error: { message: opts.chargeLookupError } }
                : { data: [] },
          }),
          upsert: async (rows: Array<Record<string, unknown>>) => {
            upsertedCharges.push(...rows);
            return { error: null };
          },
        };
      }
      if (table === "profiles") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { email: "comgr@test.com", role: "manager" } }) }) }),
        };
      }
      if (table === "profile_roles") {
        return { select: () => ({ eq: async () => ({ data: [{ role: "manager" }] }) }) };
      }
      if (table === "portal_recurring_rent_profile_records") {
        return {
          select: () => ({
            in: async (_col: string, ids: string[]) =>
              opts?.profileLookupError
                ? { data: null, error: { message: opts.profileLookupError } }
                : {
                    data: ids.filter((id) => profiles.has(id)).map((id) => ({ id, ...profiles.get(id)! })),
                  },
          }),
          upsert: async (rows: Array<Record<string, unknown>>) => {
            for (const r of rows) {
              upsertedProfiles.push(r);
              profiles.set(String(r.id), {
                manager_user_id: (r.manager_user_id as string | null) ?? null,
                property_id: (r.property_id as string | null) ?? null,
                row_data: r.row_data as Record<string, unknown>,
              });
            }
            return { error: null };
          },
        };
      }
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }), in: async () => ({ data: [] }) }) };
    },
  };
  return { db, profiles, upsertedProfiles, upsertedCharges };
}

function jsonReq(body: unknown): Request {
  return new Request("http://localhost/api/portal-household-charges", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const OWNER_ID = "mgr_owner";
const CALLER_ID = "mgr_caller";

describe("portal-household-charges POST — recurring-rent-profile mirror scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(managerHasCoManagerPermissionForProperty).mockResolvedValue(false);
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: CALLER_ID, email: "comgr@test.com" } } }) },
    } as never);
  });

  it("skips a foreign profile when the caller lacks payments EDIT — owner is never reassigned", async () => {
    const { db, profiles, upsertedProfiles } = makeDb({
      rp_foreign: {
        manager_user_id: OWNER_ID,
        property_id: "prop_owner",
        row_data: { id: "rp_foreign", amountLabel: "$2,000.00" },
      },
    });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);

    const res = await POST(
      jsonReq({
        rentProfiles: [
          { id: "rp_foreign", propertyId: "prop_owner", residentEmail: "victim@test.com", active: true },
          { id: "rp_own", propertyId: "prop_mine", residentEmail: "mine@test.com", active: true },
        ],
      }),
    );

    expect(res.status).toBe(200);
    // Foreign row untouched: still owned by the original manager, never upserted.
    expect(profiles.get("rp_foreign")!.manager_user_id).toBe(OWNER_ID);
    expect(upsertedProfiles.find((r) => r.id === "rp_foreign")).toBeUndefined();
    // The caller's own/new profile still writes normally, attributed to the caller.
    expect(upsertedProfiles.find((r) => r.id === "rp_own")).toMatchObject({ manager_user_id: CALLER_ID });
  });

  it("with payments EDIT, checks the STORED property and preserves the stored owner + property over client-relabeled values", async () => {
    const { db, upsertedProfiles } = makeDb({
      rp_foreign: {
        manager_user_id: OWNER_ID,
        property_id: "prop_owner",
        row_data: { id: "rp_foreign", amountLabel: "$2,000.00" },
      },
    });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);
    // Grant payments EDIT only on the stored property.
    vi.mocked(managerHasCoManagerPermissionForProperty).mockImplementation(
      async (_db, _userId, propertyId) => propertyId === "prop_owner",
    );

    const res = await POST(
      jsonReq({
        // Client relabels the profile to a property of its own — must be ignored.
        rentProfiles: [{ id: "rp_foreign", propertyId: "prop_relabelled", managerUserId: CALLER_ID, active: true }],
      }),
    );

    expect(res.status).toBe(200);
    // Permission was evaluated against the STORED property, not the client's label.
    expect(managerHasCoManagerPermissionForProperty).toHaveBeenCalledWith(
      expect.anything(),
      CALLER_ID,
      "prop_owner",
      "payments",
      "edit",
    );
    expect(managerHasCoManagerPermissionForProperty).not.toHaveBeenCalledWith(
      expect.anything(),
      CALLER_ID,
      "prop_relabelled",
      "payments",
      "edit",
    );
    // The write goes through but keeps the stored owner and stored property.
    expect(upsertedProfiles.find((r) => r.id === "rp_foreign")).toMatchObject({
      manager_user_id: OWNER_ID,
      property_id: "prop_owner",
    });
  });

  it("fails closed with 500 when the stored-owner lookup errors instead of treating rows as unowned", async () => {
    const { db, upsertedProfiles } = makeDb(
      {
        rp_foreign: {
          manager_user_id: OWNER_ID,
          property_id: "prop_owner",
          row_data: { id: "rp_foreign" },
        },
      },
      { profileLookupError: "query failed" },
    );
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);

    const res = await POST(jsonReq({ rentProfiles: [{ id: "rp_foreign", propertyId: "prop_owner", active: true }] }));

    expect(res.status).toBe(500);
    expect(upsertedProfiles).toHaveLength(0);
  });

  it("fails closed with 500 when the charge ownership lookup errors instead of persisting the mirror", async () => {
    const { db, upsertedCharges } = makeDb({}, { chargeLookupError: "ownership lookup failed" });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);

    const res = await POST(
      jsonReq({ charges: [{ id: "hc_1", status: "pending", propertyId: "prop_x", residentEmail: "r@test.com" }] }),
    );

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "ownership lookup failed" });
    expect(upsertedCharges).toHaveLength(0);
  });
});
