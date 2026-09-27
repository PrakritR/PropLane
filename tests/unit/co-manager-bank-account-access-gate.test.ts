import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertCoManagerBankAccountAccess } from "@/lib/auth/co-manager-bank-account-access";

/**
 * Night flow F8: a co-manager with role "Leasing" (which never grants
 * `bankAccount`) had full, unrestricted read access to the property owner's
 * Stripe Connect readiness, balance, and identity state — `read`-level
 * checks against `assertCoManagerBankAccountAccess` passed unconditionally
 * for ANY accepted co-manager, regardless of their actual grant.
 *
 * Root cause: `if (level === "read") return { ok: true };` in
 * co-manager-bank-account-access.ts, before the real permission was ever
 * looked up. Fixed to check the real `bankAccount` grant at both levels via
 * `coManagerHasOwnerBankAccountAccess` (manager-stripe-payout-access.server.ts).
 */
function fakeDb(rows: Array<{ assigned_property_ids: string[]; property_co_manager_permissions: unknown }>): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: async () => ({ data: rows, error: null }),
          }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

describe("assertCoManagerBankAccountAccess", () => {
  it("403s a Leasing-role co-manager's READ — no bankAccount grant on any assigned property", async () => {
    const db = fakeDb([
      {
        assigned_property_ids: ["prop-1"],
        // The real "leasing" ROLE_STAMPS shape (co-manager-team-roles.ts):
        // applications/promotion/inbox/calendar/properties/residents/leases —
        // never bankAccount.
        property_co_manager_permissions: {
          "prop-1": { applications: { edit: true, read: true }, leases: { read: true } },
        },
      },
    ]);

    const result = await assertCoManagerBankAccountAccess(db, "co-manager-1", "owner-1", "read");

    expect(result).toEqual({
      ok: false,
      status: 403,
      error: "You do not have permission to view this account's payout details.",
    });
  });

  it("403s the same Leasing co-manager's EDIT too", async () => {
    const db = fakeDb([
      {
        assigned_property_ids: ["prop-1"],
        property_co_manager_permissions: { "prop-1": { applications: { edit: true } } },
      },
    ]);
    const result = await assertCoManagerBankAccountAccess(db, "co-manager-1", "owner-1", "edit");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("200s (ok:true) a Bookkeeper-role co-manager's READ — bankAccount: view is granted", async () => {
    const db = fakeDb([
      {
        assigned_property_ids: ["prop-1"],
        // The real "bookkeeper" stamp includes bankAccount at view (read).
        property_co_manager_permissions: { "prop-1": { bankAccount: { read: true, notification: true } } },
      },
    ]);
    const result = await assertCoManagerBankAccountAccess(db, "co-manager-1", "owner-1", "read");
    expect(result).toEqual({ ok: true });
  });

  it("passes the property owner without ever looking up a grant", async () => {
    const db = fakeDb([]); // would 403 if this were ever queried
    const result = await assertCoManagerBankAccountAccess(db, "owner-1", "owner-1", "read");
    expect(result).toEqual({ ok: true });
  });

  it("passes when there is no owner to scope against (not a co-manager relationship)", async () => {
    const db = fakeDb([]);
    const result = await assertCoManagerBankAccountAccess(db, "user-1", null, "read");
    expect(result).toEqual({ ok: true });
  });
});
