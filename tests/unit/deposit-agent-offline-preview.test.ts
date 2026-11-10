import { describe, expect, it, vi } from "vitest";
import { disposeSecurityDepositTool } from "@/lib/tools/domains/financials-write";
function fixture() {
  const row = { id: "deposit", manager_user_id: "owner", source_charge_id: "charge", resident_email: "r@example.com", amount_cents: 10000, amount_held_cents: 10000, received_date: "2026-01-01", status: "held", itemization: [] };
  const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: row, error: null }) };
  const rpc = vi.fn(async () => ({ data: row, error: null }));
  return { ctx: { landlordId: "owner", db: { from: () => query, rpc } } as never, rpc };
}
describe("agent offline deposit return", () => {
  it("refuses a positive return without evidence before confirmation", async () => {
    const { ctx } = fixture();
    await expect(disposeSecurityDepositTool.preview(ctx, { depositId: "deposit" })).rejects.toThrow(/method and reference/);
  });
  it("shows the evidence in confirmation and carries it to the disposition", async () => {
    const { ctx, rpc } = fixture();
    const input = { depositId: "deposit", offlineReturn: { method: "check" as const, reference: "123" } };
    const preview = await disposeSecurityDepositTool.preview(ctx, input);
    expect(preview.fields).toEqual(expect.arrayContaining([{ label: "Offline return method", value: "check" }, { label: "Return reference", value: "123" }]));
    await disposeSecurityDepositTool.handler(ctx, input);
    expect(rpc).toHaveBeenCalledWith("commit_security_deposit_disposition", expect.objectContaining({ p_memo: "Offline return (check): 123" }));
  });
  it("allows withholding the entire deposit without a refund reference", async () => {
    const { ctx } = fixture();
    await expect(disposeSecurityDepositTool.preview(ctx, { depositId: "deposit", withholdCents: 10000 })).resolves.toBeDefined();
  });
});
