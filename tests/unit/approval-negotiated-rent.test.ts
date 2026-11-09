import { beforeEach, describe, expect, it, vi } from "vitest";
const upsert = vi.fn();
const row = { id: "app", application: { managerRentOverride: "800" } } as never;
vi.mock("@/lib/manager-applications-storage", () => ({ upsertApplicationRowToServerAwait: (...args: unknown[]) => upsert(...args) }));
import { persistApprovalNegotiatedRent } from "@/lib/approval-negotiated-rent";
beforeEach(() => upsert.mockReset());
describe("approval negotiated rent", () => {
  it("writes only a positive negotiated value and returns the confirmed server row", async () => {
    upsert.mockResolvedValue({ ok: true, row: { id: "app", application: { managerRentOverride: "900" } } });
    expect(await persistApprovalNegotiatedRent(row, 900)).toMatchObject({ application: { managerRentOverride: "900" } });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ application: { managerRentOverride: "900" } }), { timeoutMs: 20_000, publishConfirmedRow: false });
  });
  it("returns null on failed or unconfirmed writes", async () => {
    upsert.mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true });
    expect(await persistApprovalNegotiatedRent(row, 900)).toBeNull();
    expect(await persistApprovalNegotiatedRent(row, 900)).toBeNull();
  });
});
