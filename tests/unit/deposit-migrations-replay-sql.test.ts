import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const read = (name: string) => readFileSync(`supabase/migrations/${name}.sql`, "utf8").toLowerCase();
describe("deposit migrations replay", () => {
  it("guards object creation and only renames the original once", () => {
    const s = read("20261030010000_deposit_return_reservations");
    expect(s).toContain("create table if not exists public.security_deposit_return_attempts");
    expect(s).toContain("create unique index if not exists security_deposit_return_one_active");
    expect(s).toContain("to_regprocedure('public.commit_security_deposit_disposition_unreserved");
    expect(s).toContain("create or replace function public.commit_security_deposit_disposition(");
  });
  it("replaces functions and guards queue columns and primary key", () => {
    expect(read("20261030020000_settle_deposit_returns")).toContain("create or replace function public.settle_security_deposit_return");
    expect(read("20261030030000_deposit_return_provider_status")).toContain("create table if not exists public.security_deposit_unmatched_refunds");
    const s = read("20261030040000_reconcile_external_deposit_refunds");
    expect(s).toContain("add column if not exists status");
    expect(s).toContain("pg_get_constraintdef(c.oid)='primary key (stripe_refund_id, source_charge_id)'");
    expect(s).toContain("create or replace function public.reconcile_external_security_deposit_refund");
  });
});
