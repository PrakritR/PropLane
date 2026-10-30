import { describe, expect, it, vi } from "vitest";
import { disposeSecurityDeposit } from "@/lib/reports/security-deposits";

function dbFixture() {
  const row = { id: "deposit", manager_user_id: "owner", source_charge_id: "charge", resident_email: "r@example.com", amount_cents: 10000, amount_held_cents: 10000, received_date: "2026-01-01", status: "held", itemization: [] };
  const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: row, error: null }) };
  return { from: () => query, rpc: vi.fn(async () => ({ data: row, error: null })) };
}
const input = { managerUserId: "owner", depositId: "deposit", dispositionType: "full_refund" as const, refundCents: 10000, withholdCents: 0 };
describe("offline deposit return evidence", () => {
  it("does not record a refund without an explicit method and reference", async () => {
    const db = dbFixture();
    await expect(disposeSecurityDeposit(db as never, input)).rejects.toThrow(/method and reference/);
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it("records the offline method and reference in the disposition", async () => {
    const db = dbFixture();
    await disposeSecurityDeposit(db as never, { ...input, offlineReturn: { method: "check", reference: "check 123" } });
    expect(db.rpc).toHaveBeenCalledWith("commit_security_deposit_disposition", expect.objectContaining({ p_memo: "Offline return (check): check 123" }));
  });
});
