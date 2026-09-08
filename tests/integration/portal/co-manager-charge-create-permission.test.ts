import { describe, it, expect, vi, beforeEach } from "vitest";

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
vi.mock("@/lib/domain-action-events.server", () => ({
  emitHouseholdChargeTransition: vi.fn().mockResolvedValue(undefined),
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

const CO_MANAGER = "co_mgr_1";
const OWNER = "owner_1";
const OWNED_PROPERTY = "prop_owner";

type PropertyRow = { id: string; manager_user_id: string | null };

/**
 * The route only ever reads the property table through `.select().in()`, so the
 * stub answers that shape and nothing else. `propertyReadFails` models the
 * transient-blip case the payee resolution must refuse on.
 */
function makeDb(properties: PropertyRow[], opts?: { propertyReadFails?: boolean }) {
  const upserted: Array<Record<string, unknown>> = [];
  const db = {
    from(table: string) {
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: { email: "co@test.com", role: "manager" } }) }),
          }),
        };
      }
      if (table === "profile_roles") {
        return { select: () => ({ eq: async () => ({ data: [{ role: "manager" }] }) }) };
      }
      if (table === "manager_property_records") {
        return {
          select: () => ({
            in: async (_col: string, ids: string[]) =>
              opts?.propertyReadFails
                ? { data: null, error: { message: "boom" } }
                : { data: properties.filter((p) => ids.includes(p.id)), error: null },
          }),
        };
      }
      if (table === "portal_household_charge_records") {
        return {
          select: () => ({
            in: async () => ({ data: [], error: null }),
            eq: () => ({ maybeSingle: async () => ({ data: null }) }),
          }),
          upsert: async (rows: Array<Record<string, unknown>>) => {
            upserted.push(...rows);
            return { error: null };
          },
        };
      }
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) };
    },
  };
  return { db, upserted };
}

function newChargeReq(propertyId: string | null) {
  return new Request("http://localhost/api/portal-household-charges", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      charges: [
        {
          id: "chg_new_1",
          propertyId,
          status: "pending",
          title: "September rent",
          residentEmail: "resident@test.com",
          // A caller can name anyone here; the route must never believe it.
          managerUserId: CO_MANAGER,
        },
      ],
    }),
  });
}

describe("creating a charge is gated by the owner's Payments grant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: CO_MANAGER, email: "co@test.com" } } }) },
    } as never);
  });

  it("refuses a co-manager with no Payments edit grant on the owner's property", async () => {
    const { db, upserted } = makeDb([{ id: OWNED_PROPERTY, manager_user_id: OWNER }]);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);
    vi.mocked(managerHasCoManagerPermissionForProperty).mockResolvedValue(false);

    const res = await POST(newChargeReq(OWNED_PROPERTY));

    expect(res.status).toBe(200);
    // Nothing was written — the resident is never billed by someone the owner
    // has not authorised.
    expect(upserted).toHaveLength(0);
  });

  it("allows it with the grant, and stamps the OWNER as the payee — never the caller", async () => {
    const { db, upserted } = makeDb([{ id: OWNED_PROPERTY, manager_user_id: OWNER }]);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);
    vi.mocked(managerHasCoManagerPermissionForProperty).mockResolvedValue(true);

    const res = await POST(newChargeReq(OWNED_PROPERTY));

    expect(res.status).toBe(200);
    expect(upserted).toHaveLength(1);
    // This is the whole point: one property, one payee. Checkout reads this
    // column to decide which bank account receives the rent.
    expect(upserted[0]!.manager_user_id).toBe(OWNER);
    expect(upserted[0]!.property_id).toBe(OWNED_PROPERTY);
  });

  it("asks for the grant on the property the charge NAMES, so relabeling buys nothing", async () => {
    const { db } = makeDb([{ id: OWNED_PROPERTY, manager_user_id: OWNER }]);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);
    vi.mocked(managerHasCoManagerPermissionForProperty).mockResolvedValue(true);

    await POST(newChargeReq(OWNED_PROPERTY));

    expect(managerHasCoManagerPermissionForProperty).toHaveBeenCalledWith(
      expect.anything(),
      CO_MANAGER,
      OWNED_PROPERTY,
      "payments",
      "edit",
    );
  });

  it("refuses rather than guessing a payee when the property cannot be read", async () => {
    const { db, upserted } = makeDb([{ id: OWNED_PROPERTY, manager_user_id: OWNER }], {
      propertyReadFails: true,
    });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);
    vi.mocked(managerHasCoManagerPermissionForProperty).mockResolvedValue(true);

    const res = await POST(newChargeReq(OWNED_PROPERTY));

    expect(res.status).toBe(503);
    expect(upserted).toHaveLength(0);
  });

  it("still lets a manager bill on their OWN property", async () => {
    const { db, upserted } = makeDb([{ id: OWNED_PROPERTY, manager_user_id: CO_MANAGER }]);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);
    vi.mocked(managerHasCoManagerPermissionForProperty).mockResolvedValue(false);

    const res = await POST(newChargeReq(OWNED_PROPERTY));

    expect(res.status).toBe(200);
    expect(upserted).toHaveLength(1);
    expect(upserted[0]!.manager_user_id).toBe(CO_MANAGER);
    expect(managerHasCoManagerPermissionForProperty).not.toHaveBeenCalled();
  });

  it("leaves a charge filed under no property attributed to its author", async () => {
    const { db, upserted } = makeDb([]);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);

    const res = await POST(newChargeReq(null));

    expect(res.status).toBe(200);
    expect(upserted).toHaveLength(1);
    expect(upserted[0]!.manager_user_id).toBe(CO_MANAGER);
  });
});
