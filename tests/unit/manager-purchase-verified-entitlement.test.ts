import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { loadAccountPurchaseRows, loadPurchaseRowsByEmail } from "@/lib/manager-purchase-account-rows.server";
const owner = "11111111-2222-4333-8444-555555555555";
const other = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
type Purchase = { id: string; email: string; user_id: string | null };
function fixture(authEmail: string, confirmed: boolean, rows: Purchase[]) {
  const userRead = vi.fn(async () => ({ data: { user: { id: owner, email: authEmail, email_confirmed_at: confirmed ? "2026-01-01" : null } }, error: null }));
  const profile = { select: () => profile, eq: () => profile, maybeSingle: async () => ({ data: { email: "resident@example.test" }, error: null }) };
  const from = (table: string) => {
    if (table === "profiles") return profile;
    const query = { select: () => query,
      eq: (_: string, value: string) => Promise.resolve({ data: rows.filter((r) => r.user_id === value), error: null }),
      ilike: () => query,
      or: (filter: string) => { const id = filter.split("user_id.eq.")[1]; return Promise.resolve({ data: rows.filter((r) => r.user_id === null || r.user_id === id), error: null }); },
    };
    return query;
  };
  return { db: { from, auth: { admin: { getUserById: userRead } } } as never, userRead };
}
const legacy = { id: "legacy", email: "resident@example.test", user_id: null };
describe("verified account purchase entitlement", () => {
  it("returns an unclaimed exact legacy purchase for the verified matching mailbox", async () => {
    const { db } = fixture("Resident@Example.test", true, [legacy]);
    expect((await loadAccountPurchaseRows(db, owner, "id")).rows).toEqual([legacy]);
  });
  it("does not return an email-linked purchase for an unverified user", async () => {
    const { db } = fixture("resident@example.test", false, [legacy]);
    expect((await loadAccountPurchaseRows(db, owner, "id")).rows).toEqual([]);
  });
  it("does not use a stale profile email different from the verified auth email", async () => {
    const { db } = fixture("different@example.test", true, [legacy]);
    expect((await loadAccountPurchaseRows(db, owner, "id")).rows).toEqual([]);
  });
  it("excludes a matching-email purchase claimed by another user", async () => {
    const { db } = fixture("resident@example.test", true, [{ ...legacy, user_id: other }]);
    expect((await loadAccountPurchaseRows(db, owner, "id")).rows).toEqual([]);
    expect((await loadPurchaseRowsByEmail(db, legacy.email, "id", { claimedBy: owner })).rows).toEqual([]);
  });
});
