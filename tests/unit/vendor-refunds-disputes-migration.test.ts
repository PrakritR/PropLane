import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261007020000_vendor_refunds_disputes.sql"), "utf8");
const TABLES = ["vendor_payout_refunds", "manager_expense_reversals", "vendor_banking_disputes"];

describe("20261007020000_vendor_refunds_disputes", () => {
  it.each(TABLES)("%s: RLS on, client roles SELECT only, service role writes", (table) => {
    expect(sql).toContain(`alter table public.${table} enable row level security`);
    expect(sql).toContain(`revoke all on table public.${table} from anon, authenticated`);
    expect(sql).toContain(`grant select on table public.${table} to authenticated`);
    expect(sql).toContain(`grant all on table public.${table} to service_role`);
    expect(sql).not.toMatch(new RegExp(`grant (insert|update|delete|all)[^;]*public\\.${table} to authenticated`));
    expect(sql).not.toMatch(new RegExp(`on public\\.${table}\\s+for (all|insert|update|delete)`));
  });

  it("is idempotent: every create is guarded and every policy is dropped first", () => {
    for (const m of sql.matchAll(/create table (?!if not exists)/g)) throw new Error(`unguarded create table at ${m.index}`);
    for (const m of sql.matchAll(/create policy (\w+)/g)) expect(sql).toContain(`drop policy if exists ${m[1]}`);
    expect(sql).not.toMatch(/add column (?!if not exists)/);
  });

  it("one refund request per attempt key, one dispute per Stripe dispute, one reversal per attempt", () => {
    expect(sql).toMatch(/vendor_payout_refunds[\s\S]*attempt_key text not null unique/);
    expect(sql).toMatch(/stripe_dispute_id text not null unique/);
    expect(sql).toMatch(/manager_expense_reversals[\s\S]*attempt_key text not null unique/);
  });

  it("the vendor statement accepts the dispute line", () => {
    expect(sql).toMatch(/kind in \([^)]*'dispute'\)/);
    expect(sql).toMatch(/source in \([^)]*'dispute'\)/);
  });
});
