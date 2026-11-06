import { describe, expect, it, vi } from "vitest";
import { userHoldsManagerRole } from "@/lib/manager-route-guard.server";

describe("stored manager capability", () => {
  function db(data: unknown, error: unknown = null) {
    const maybeSingle = vi.fn(async () => ({ data, error }));
    const query = { select: vi.fn(), eq: vi.fn(), maybeSingle };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    return { from: vi.fn(() => query) };
  }
  it("allows the stored role", async () => {
    expect(await userHoldsManagerRole(db({ role: "manager" }) as never, "manager-id")).toBe(true);
  });
  it("denies absent and unreadable role records", async () => {
    expect(await userHoldsManagerRole(db(null) as never, "metadata-manager")).toBe(false);
    expect(await userHoldsManagerRole(db({ role: "manager" }, { message: "unavailable" }) as never, "manager-id")).toBe(false);
  });
});
