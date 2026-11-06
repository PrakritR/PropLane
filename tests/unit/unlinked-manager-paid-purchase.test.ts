import { describe, expect, it, vi } from "vitest";
import { hasUnlinkedPaidManagerPurchase } from "@/lib/auth/unlinked-manager-paid-purchase";
function fixture(rows: unknown[], error: unknown = null) {
  const q = { ilike: vi.fn(), is: vi.fn(), not: vi.fn(), like: vi.fn(), limit: vi.fn(async () => ({ data: rows, error })) };
  q.ilike.mockReturnValue(q); q.is.mockReturnValue(q); q.not.mockReturnValue(q); q.like.mockReturnValue(q);
  return { db: { auth: { admin: { getUserById: async () => ({ data: { user: { email: "owner+x@example.test", email_confirmed_at: "now" } }, error: null }) } }, from: () => ({ select: () => q }) }, q };
}
describe("legacy manager purchase guard", () => {
  it("blocks a mixed-case exact email with an unlinked paid Stripe source", async () => {
    const f = fixture([{ email: "OWNER+X@EXAMPLE.TEST", stripe_checkout_session_id: "cs_paid" }]);
    expect(await hasUnlinkedPaidManagerPurchase(f.db as never, "user", "owner+x@example.test")).toBe(true);
    expect(f.q.ilike).toHaveBeenCalledWith("email", "owner+x@example.test");
    expect(f.q.is).toHaveBeenCalledWith("user_id", null);
    expect(f.q.not).toHaveBeenCalledWith("paid_at", "is", null);
    expect(f.q.like).toHaveBeenCalledWith("stripe_checkout_session_id", "cs\\_%");
  });
  it("escapes LIKE wildcards and does not trust a returned different email or axis intent", async () => {
    const f = fixture([{ email: "aXb@example.test", stripe_checkout_session_id: "cs_paid" }, { email: "a_b@example.test", stripe_checkout_session_id: "axis_intent_unclaimed" }]);
    expect(await hasUnlinkedPaidManagerPurchase({ ...f.db, auth: { admin: { getUserById: async () => ({ data: { user: { email: "a_b@example.test", email_confirmed_at: "now" } }, error: null }) } } } as never, "user", "a_b@example.test")).toBe(false);
    expect(f.q.ilike).toHaveBeenCalledWith("email", "a\\_b@example.test");
  });
  it.each([
    { email: "owner+x@example.test", email_confirmed_at: null },
    { email: "wrong@example.test", email_confirmed_at: "now" },
  ])("requires the subject's confirmed matching Auth email", async (user) => {
    const f = fixture([]);
    const db = { ...f.db, auth: { admin: { getUserById: async () => ({ data: { user }, error: null }) } } };
    await expect(hasUnlinkedPaidManagerPurchase(db as never, "user", "owner+x@example.test")).rejects.toThrow(/verified email/);
    expect(f.q.ilike).not.toHaveBeenCalled();
  });
  it("does not issue a PostgREST wildcard query for a literal asterisk", async () => {
    const f = fixture([]);
    await expect(hasUnlinkedPaidManagerPurchase(f.db as never, "user", "a*b@example.test")).rejects.toThrow(/review/);
    expect(f.q.ilike).not.toHaveBeenCalled();
  });
  it("fails closed when the purchase lookup fails", async () => {
    const f = fixture([], { message: "db unavailable" });
    await expect(hasUnlinkedPaidManagerPurchase({ ...f.db, auth: { admin: { getUserById: async () => ({ data: { user: { email: "owner@example.test", email_confirmed_at: "now" } }, error: null }) } } } as never, "user", "owner@example.test")).rejects.toThrow(/review/);
  });
});
