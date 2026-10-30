import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { loadAccountPurchaseRows, loadPurchaseRowsByEmail } from "@/lib/manager-purchase-account-rows.server";
const owner = "11111111-2222-4333-8444-555555555555";
const other = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
type Purchase = { id: string; email: string; user_id: string | null };
type AuthAnswer =
  | { email: string; confirmed: boolean }
  | { error: { status?: number; code?: string; message: string } }
  | { throws: true };

function fixture(auth: AuthAnswer, rows: Purchase[]) {
  const userRead = vi.fn(async () => {
    if ("throws" in auth) throw new Error("socket hang up");
    if ("error" in auth) return { data: { user: null }, error: auth.error };
    return {
      data: { user: { id: owner, email: auth.email, email_confirmed_at: auth.confirmed ? "2026-01-01" : null } },
      error: null,
    };
  });
  const from = () => {
    const query = {
      select: () => query,
      eq: (_: string, value: string) => Promise.resolve({ data: rows.filter((r) => r.user_id === value), error: null }),
      ilike: () => query,
      or: (filter: string) => {
        const id = filter.split("user_id.eq.")[1];
        return Promise.resolve({ data: rows.filter((r) => r.user_id === null || r.user_id === id), error: null });
      },
    };
    return query;
  };
  return { db: { from, auth: { admin: { getUserById: userRead } } } as never, userRead };
}
const legacy = { id: "legacy", email: "resident@example.test", user_id: null };
const direct = { id: "direct", email: "other@example.test", user_id: owner };
describe("verified account purchase entitlement", () => {
  it("returns an unclaimed exact legacy purchase for the verified matching mailbox", async () => {
    const { db } = fixture({ email: "Resident@Example.test", confirmed: true }, [legacy]);
    expect((await loadAccountPurchaseRows(db, owner, "id")).rows).toEqual([legacy]);
  });
  it("does not return an email-linked purchase for an unconfirmed mailbox", async () => {
    const { db } = fixture({ email: "resident@example.test", confirmed: false }, [legacy]);
    expect((await loadAccountPurchaseRows(db, owner, "id")).rows).toEqual([]);
  });
  it("matches the Auth mailbox, not some other address on the account", async () => {
    const { db } = fixture({ email: "different@example.test", confirmed: true }, [legacy]);
    expect((await loadAccountPurchaseRows(db, owner, "id")).rows).toEqual([]);
  });
  it("reports a transient Auth failure, excludes legacy email rows, and retains direct ownership", async () => {
    const { db } = fixture({ error: { status: 500, message: "auth unavailable" } }, [legacy, direct]);
    const result = await loadAccountPurchaseRows(db, owner, "id");
    expect(result.rows).toEqual([direct]);
    expect(result.readFailed).toBe(true);
    expect(result.error?.message).toBe("auth unavailable");
  });
  it("reports a thrown Auth failure as unreadable rather than as no entitlement", async () => {
    const { db } = fixture({ throws: true }, [legacy, direct]);
    const result = await loadAccountPurchaseRows(db, owner, "id");
    expect(result.rows).toEqual([direct]);
    expect(result.readFailed).toBe(true);
  });
  it("treats a missing Auth user as a conclusive answer, never a read failure", async () => {
    // An orphaned id (no Auth user) owns no email-linked row - that is known, not unknown. Calling it a
    // read failure 500s the admin billing card and fails the promo check closed for nothing.
    for (const error of [
      { status: 404, message: "User not found" },
      { code: "user_not_found", message: "whatever" },
      { message: "User not found" },
    ]) {
      const { db } = fixture({ error }, [legacy, direct]);
      const result = await loadAccountPurchaseRows(db, owner, "id");
      expect(result.rows).toEqual([direct]);
      expect(result.readFailed).toBe(false);
      expect(result.error).toBeNull();
    }
  });
  it("retains direct ownership even when the mailbox is unconfirmed", async () => {
    const { db } = fixture({ email: "resident@example.test", confirmed: false }, [legacy, direct]);
    expect((await loadAccountPurchaseRows(db, owner, "id")).rows).toEqual([direct]);
  });
  it("excludes a matching-email purchase claimed by another user", async () => {
    const { db } = fixture({ email: "resident@example.test", confirmed: true }, [{ ...legacy, user_id: other }]);
    expect((await loadAccountPurchaseRows(db, owner, "id")).rows).toEqual([]);
    expect((await loadPurchaseRowsByEmail(db, legacy.email, "id", { claimedBy: owner })).rows).toEqual([]);
  });
  it("starts the Auth read without waiting on the by-user_id purchase read", async () => {
    // Every portal page resolves a plan through here, so the Auth round trip must not be serialized
    // behind the purchase read. The Auth stub finishes only once the purchase read has been issued:
    // an implementation that awaited Auth first would never get there.
    let purchaseIssued: () => void = () => {};
    const issued = new Promise<void>((resolve) => {
      purchaseIssued = resolve;
    });
    const query: Record<string, unknown> = {
      select: () => query,
      eq: () => {
        purchaseIssued();
        return Promise.resolve({ data: [direct], error: null });
      },
      ilike: () => query,
      or: () => Promise.resolve({ data: [legacy], error: null }),
    };
    const db = {
      from: () => query,
      auth: {
        admin: {
          getUserById: async () => {
            await issued;
            return { data: { user: { id: owner, email: legacy.email, email_confirmed_at: "2026-01-01" } }, error: null };
          },
        },
      },
    } as never;

    const result = await Promise.race([
      loadAccountPurchaseRows<{ id: string }>(db, owner, "id"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Auth read was serialized")), 1000)),
    ]);
    expect((result as { rows: { id: string }[] }).rows.map((r) => r.id).sort()).toEqual(["direct", "legacy"]);
  });
});
