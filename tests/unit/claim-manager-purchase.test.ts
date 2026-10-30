import { describe, expect, it, vi } from "vitest";
import { claimManagerPurchase } from "@/lib/auth/claim-manager-purchase.server";
function client(owner: string | null, winner: boolean) {
  const filters: unknown[] = [];
  const db = { from: () => ({ update: () => { const q = { eq: (key: string, value: unknown) => { filters.push([key, value]); return q; }, is: (key: string, value: unknown) => { filters.push([key, value]); return q; }, select: () => q, maybeSingle: async () => ({ data: winner ? { id: "purchase" } : null, error: null }) }; return q; }, select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: owner ? { user_id: owner } : null, error: null }) }) }) }) };
  return { db, filters };
}
describe("manager purchase claim", () => {
  it("claims an unowned purchase conditionally", async () => {
    const { db, filters } = client(null, true);
    expect(await claimManagerPurchase(db as never, "purchase", "user")).toBe(true);
    expect(filters).toContainEqual(["user_id", null]);
  });
  it("allows a retry only by the same user", async () => {
    expect(await claimManagerPurchase(client("user", false).db as never, "purchase", "user")).toBe(true);
    expect(await claimManagerPurchase(client("other", false).db as never, "purchase", "user")).toBe(false);
  });
});
