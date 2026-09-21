/**
 * A deleted charge must stop contributing to the ledger it was mirrored into.
 * `deleteLedgerEntriesForCharge` (`src/lib/reports/ledger-sync.ts`) owns the
 * delete-by-`source_charge_id` query, and the `deleteCharge` action in
 * `src/app/api/portal-household-charges/route.ts` calls it right after the
 * charge row itself is deleted, scoped to the charge's resolved owner.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest } from "../helpers/api-request";

const getUser = vi.fn();
let existingRow: { manager_user_id: string | null; property_id: string | null } | null;
let ledgerEqCalls: [string, string][];

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: vi.fn(async () => false) }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => makeServiceClient(),
}));

import { deleteLedgerEntriesForCharge } from "@/lib/reports/ledger-sync";
import { POST as deleteChargeRoute } from "@/app/api/portal-household-charges/route";

function makeServiceClient() {
  const chargeBuilder: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockImplementation(() => Promise.resolve({ data: existingRow, error: null })),
    delete: vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    }),
  };
  const ledgerBuilder: Record<string, unknown> = {
    eq: vi.fn().mockImplementation((column: string, value: string) => {
      ledgerEqCalls.push([column, value]);
      return ledgerBuilder;
    }),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
  };
  return {
    from(table: string) {
      if (table === "profiles") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: { email: "mgr@example.com", role: "manager" }, error: null }),
        };
      }
      if (table === "profile_roles") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockImplementation(() => Promise.resolve({ data: [{ role: "manager" }], error: null })),
        };
      }
      if (table === "portal_household_charge_records") return chargeBuilder;
      if (table === "ledger_entries") return { delete: vi.fn().mockReturnValue(ledgerBuilder) };
      return {};
    },
  };
}

describe("deleteLedgerEntriesForCharge", () => {
  function makeLedgerBuilder(result: { error: { message: string } | null }) {
    const eqCalls: [string, string][] = [];
    const builder = {
      eq: vi.fn().mockImplementation((column: string, value: string) => {
        eqCalls.push([column, value]);
        return builder;
      }),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
    };
    return { builder, eqCalls };
  }

  it("scopes the delete to source_charge_id and manager_user_id when an owner is given", async () => {
    const { builder, eqCalls } = makeLedgerBuilder({ error: null });
    const db = { from: vi.fn().mockReturnValue({ delete: vi.fn().mockReturnValue(builder) }) };

    await deleteLedgerEntriesForCharge(db as never, "mgr-1", "hc_1");

    expect(db.from).toHaveBeenCalledWith("ledger_entries");
    expect(eqCalls).toEqual([
      ["source_charge_id", "hc_1"],
      ["entry_type", "charge"],
      ["manager_user_id", "mgr-1"],
    ]);
  });

  it("only ever removes the charge line — payment and refund lines stay on the books", async () => {
    const { builder, eqCalls } = makeLedgerBuilder({ error: null });
    const db = { from: vi.fn().mockReturnValue({ delete: vi.fn().mockReturnValue(builder) }) };

    await deleteLedgerEntriesForCharge(db as never, "mgr-1", "hc_paid");

    expect(eqCalls).toContainEqual(["entry_type", "charge"]);
  });

  it("scopes only by source_charge_id and entry type when no owner is known (admin)", async () => {
    const { builder, eqCalls } = makeLedgerBuilder({ error: null });
    const db = { from: vi.fn().mockReturnValue({ delete: vi.fn().mockReturnValue(builder) }) };

    await deleteLedgerEntriesForCharge(db as never, null, "hc_1");

    expect(eqCalls).toEqual([
      ["source_charge_id", "hc_1"],
      ["entry_type", "charge"],
    ]);
  });

  it("does nothing for an empty charge id", async () => {
    const db = { from: vi.fn() };

    await deleteLedgerEntriesForCharge(db as never, "mgr-1", "");

    expect(db.from).not.toHaveBeenCalled();
  });

  it("throws when the delete errors", async () => {
    const { builder } = makeLedgerBuilder({ error: { message: "boom" } });
    const db = { from: vi.fn().mockReturnValue({ delete: vi.fn().mockReturnValue(builder) }) };

    await expect(deleteLedgerEntriesForCharge(db as never, "mgr-1", "hc_1")).rejects.toThrow("boom");
  });
});

describe("POST /api/portal-household-charges deleteCharge removes the ledger line", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUser.mockResolvedValue({ data: { user: { id: "mgr-1" } }, error: null });
    existingRow = { manager_user_id: "mgr-1", property_id: "prop-1" };
    ledgerEqCalls = [];
  });

  it("deletes the charge's ledger entries scoped to its owner", async () => {
    const res = await deleteChargeRoute(
      jsonRequest("http://localhost/api/portal-household-charges", {
        method: "POST",
        body: { action: "deleteCharge", id: "hc_1" },
      }),
    );
    expect(res.status).toBe(200);
    expect(ledgerEqCalls).toEqual([
      ["source_charge_id", "hc_1"],
      ["entry_type", "charge"],
      ["manager_user_id", "mgr-1"],
    ]);
  });

  it("pins the delete to the calling manager when the charge row was already gone — never unscoped for a non-admin", async () => {
    existingRow = null;
    const res = await deleteChargeRoute(
      jsonRequest("http://localhost/api/portal-household-charges", {
        method: "POST",
        body: { action: "deleteCharge", id: "hc_missing" },
      }),
    );
    expect(res.status).toBe(200);
    expect(ledgerEqCalls).toEqual([
      ["source_charge_id", "hc_missing"],
      ["entry_type", "charge"],
      ["manager_user_id", "mgr-1"],
    ]);
  });
});
