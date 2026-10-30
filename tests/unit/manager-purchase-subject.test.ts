import { describe, expect, it, vi } from "vitest";
import { findManagerPurchaseForAccount } from "@/lib/auth/manager-onboarding";
describe("manager purchase subject", () => {
  it("does not adopt an orphan or another user's purchase by matching email", async () => {
    const filters: Array<[string, unknown]> = [];
    const query = { select: vi.fn().mockReturnThis(), eq: vi.fn((key: string, value: unknown) => { filters.push([key, value]); return query; }), order: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data: null }) };
    const db = { from: vi.fn(() => query) };
    expect(await findManagerPurchaseForAccount(db as never, "current-user", "victim@example.com")).toBeNull();
    expect(filters).toEqual([["user_id", "current-user"]]);
  });
});
