import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync("supabase/migrations/20261030020000_settle_deposit_returns.sql", "utf8").toLowerCase();

describe("provider deposit settlement", () => {
  it("requires exact succeeded provider, payment, refund and journal evidence before mutation", () => {
    const mutation = sql.indexOf("insert into public.gl_journal_entries");
    for (const check of ["e.status is distinct from 'succeeded'", "e.stripe_charge_id is distinct from pay.stripe_charge_id", "e.amount_cents is distinct from a.refund_cents", "r.amount_cents is distinct from a.refund_cents", "r.gl_journal_entry_id is distinct from j.id", "debit_total <> a.refund_cents", "credit_total <> a.refund_cents"]) {
      expect(sql.indexOf(check)).toBeGreaterThan(0);
      expect(sql.indexOf(check)).toBeLessThan(mutation);
    }
    expect(sql).toContain("source_id='refund:'||a.source_charge_id||':'||a.provider_refund_id");
  });
  it("locks attempt and deposit, replays idempotently, and books only a distinct withholding journal", () => {
    expect(sql).toMatch(/security_deposit_return_attempts where id=p_attempt for update/);
    expect(sql).toMatch(/security_deposit_ledger where id=a.deposit_id[\s\S]*?for update/);
    expect(sql).toContain("if a.status='reconciled' then return to_jsonb(a)");
    expect(sql).toContain("'deposit-withhold:'||a.id::text");
    expect(sql).not.toMatch(/values\([^;]*?'refund'\s*,/);
    expect(sql).toContain("status='reconciled'");
  });
  it("serializes bill allocations and restricts the RPC to the service role", () => {
    expect(sql).toMatch(/order by b.id for update/);
    expect(sql).toContain("claimed+proposed>bill.amount_cents");
    expect(sql).toContain("revoke all on function public.settle_security_deposit_return(uuid) from public, anon, authenticated");
  });
});
