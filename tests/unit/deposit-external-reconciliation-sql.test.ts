import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const sql = readFileSync("supabase/migrations/20261030040000_reconcile_external_deposit_refunds.sql", "utf8").toLowerCase();
describe("external deposit refund reconciliation", () => {
  it("serializes replay and prevents adoption while another attempt is active", () => {
    expect(sql).toMatch(/security_deposit_unmatched_refunds[\s\S]*?for update/);
    expect(sql).toMatch(/security_deposit_ledger where source_charge_id=p_source for update/);
    expect(sql).toContain("if u.status='reconciled' then return to_jsonb(u)");
    expect(sql).toContain("an active return must be reconciled first");
    expect(sql).toContain("perform public.settle_security_deposit_return(a.id)");
  });
  it("rolls back unsafe candidates and retains a reason for retry", () => {
    expect(sql).toContain("exception when others then");
    expect(sql).toContain("status='review',reason=left(sqlerrm,500)");
    expect(sql).toContain("exact succeeded provider evidence required");
  });
  it("binds central cart refunds to exactly the reserved component", () => {
    expect(sql).toContain("jsonb_array_length(h.refund_components)<>1");
    expect(sql).toContain("h.refund_components->0->>'source_id' is distinct from a.source_charge_id");
    expect(sql).toContain("central refund reservation required");
  });
});
