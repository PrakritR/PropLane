/**
 * The twelfth reviewed migration: the durable reservation behind every general charge refund.
 *
 * These assert the SQL's own guarantees, because they are the ones that cannot be re-created in
 * TypeScript: the row locks, the budget arithmetic against authoritative payment evidence, the
 * one-unresolved-attempt index, the once-only money projection under the charge's lock, and that
 * nothing but `service_role` can reach any of it. Running the SQL needs a database; that is
 * root's rollback-only DEV exercise, not this file's claim.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync("supabase/migrations/20261108140000_household_charge_refund_attempts.sql", "utf8");

describe("household charge refund reservation SQL", () => {
  it("is additive and rewrites no historical object", () => {
    expect(sql).toContain("create table if not exists public.household_charge_refund_attempts");
    expect(sql).not.toMatch(/drop table/i);
    expect(sql).not.toMatch(/alter table public\.(portal_household_charge_records|ledger_entries|security_deposit)/i);
    expect(sql).not.toMatch(/drop function/i);
  });

  it("records the immutable basis of one operation", () => {
    for (const column of [
      "operation_key text not null unique",
      "source_charge_id text not null",
      "manager_user_id uuid references auth.users(id) on delete set null",
      "stripe_charge_id text not null",
      "stripe_payment_intent_id text",
      "rail text not null check (rail in ('central','destination','managed'))",
      "amount_cents bigint not null check (amount_cents > 0)",
      "baseline_refunded_cents bigint not null check (baseline_refunded_cents >= 0)",
      "basis jsonb not null check (jsonb_typeof(basis) = 'object')",
      "provider_refund_id text unique",
    ]) expect(sql).toContain(column);
    // The refund can never exceed what was paid, and `succeeded` is exactly the projected state.
    expect(sql).toContain("check (amount_cents + baseline_refunded_cents <= paid_cents)");
    expect(sql).toContain("check ((status = 'succeeded') = (projected_at is not null))");
  });

  it("allows one unresolved reservation per household source", () => {
    expect(sql).toContain("create unique index if not exists household_charge_refund_one_unresolved");
    expect(sql).toMatch(/on public\.household_charge_refund_attempts\(source_charge_id\)\s*\n\s*where status in \('reserved','pending','unknown'\)/);
    // A provider refund binds to at most one attempt, and one platform reservation to one attempt.
    expect(sql).toContain("create unique index if not exists household_charge_refund_platform_key");
  });

  it("is reachable by service_role only, with no client write path", () => {
    expect(sql).toContain("alter table public.household_charge_refund_attempts enable row level security");
    expect(sql).toContain("revoke all on public.household_charge_refund_attempts from public, anon, authenticated");
    expect(sql).toContain("grant all on public.household_charge_refund_attempts to service_role");
    for (const fn of [
      "reserve_household_charge_refund(uuid,text,text,text,text,text,bigint,jsonb)",
      "stamp_household_charge_refund_platform_key(uuid,text)",
      "bind_household_charge_refund(uuid,text,text,bigint,text,text,uuid)",
    ]) {
      expect(sql).toContain(`revoke all on function public.${fn} from public, anon, authenticated`);
      expect(sql).toContain(`grant execute on function public.${fn} to service_role`);
    }
    expect([...sql.matchAll(/security definer set search_path = public, pg_temp/g)]).toHaveLength(3);
  });

  it("reserves under the charge's row lock against the payment ledger", () => {
    expect(sql).toMatch(/from public\.portal_household_charge_records\s*\n?\s*where id = p_charge and manager_user_id = p_owner for update/);
    expect(sql).toMatch(/from public\.ledger_entries\s*\n?\s*where source_charge_id = p_charge and entry_type = 'payment'/);
    expect(sql).toContain("pay.stripe_charge_id is distinct from p_stripe_charge");
    // Paid minus everything already refunded minus everything still held.
    expect(sql).toContain("where source_charge_id = p_charge and status in ('reserved','pending','unknown')");
    expect(sql).toContain("if refunded + reserved_total + p_amount > pay.amount_cents then");
    expect(sql).toContain("raise exception 'Refund requires reconciliation'");
  });

  it("replays one operation key only when the entire basis is identical", () => {
    expect(sql).toContain("where operation_key = p_operation_key");
    for (const compared of [
      "a.source_charge_id is distinct from p_charge",
      "a.manager_user_id is distinct from p_owner",
      "a.stripe_charge_id is distinct from p_stripe_charge",
      "a.stripe_payment_intent_id is distinct from p_payment_intent",
      "a.rail is distinct from p_rail",
      "a.amount_cents is distinct from p_amount",
      "a.basis is distinct from p_basis",
    ]) expect(sql).toContain(compared);
    expect(sql).toContain("raise exception 'Operation key differs from reservation'");
  });

  it("binds only exact re-read provider evidence, and the central rail's exact component", () => {
    expect(sql).toContain("from public.platform_source_refund_evidence where stripe_refund_id = p_refund");
    expect(sql).toContain("e.stripe_charge_id is distinct from p_charge");
    expect(sql).toContain("e.amount_cents is distinct from p_amount");
    expect(sql).toContain("e.status is distinct from p_status");
    expect(sql).toContain("coalesce(lower(p_currency),'usd') <> 'usd'");
    expect(sql).toContain("if p_platform_attempt is null then raise exception 'Central refund reservation required'");
    expect(sql).toContain("h.attempt_key is distinct from a.platform_attempt_key");
    expect(sql).toContain("h.refund_components->0->>'source_id' is distinct from a.source_charge_id");
    expect(sql).toContain("raise exception 'Refund component requires review'");
  });

  it("projects the money once, under the charge's lock, and never regresses a terminal state", () => {
    expect(sql).toMatch(/where id = a\.source_charge_id and manager_user_id = a\.manager_user_id for update/);
    expect(sql).toContain("if refunded < a.baseline_refunded_cents then raise exception");
    expect(sql).toContain("if refunded + a.amount_cents > a.paid_cents then raise exception");
    expect(sql).toContain("'{refundedCents}', to_jsonb(refunded + a.amount_cents), true");
    expect(sql).toContain("status = 'succeeded', projected_at = nowts");
    // A late pending cannot undo a success, and a failure cannot become one.
    expect(sql).toContain("if a.status = 'succeeded' and p_status in ('failed','canceled') then raise exception 'Refund terminal status changed'");
    expect(sql).toContain("if a.status = 'failed' and p_status = 'succeeded' then raise exception 'Refund terminal status changed'");
    // Only the money keys are written, so a concurrent edit elsewhere in the JSON survives.
    expect([...sql.matchAll(/jsonb_set\(/g)].length).toBeGreaterThanOrEqual(3);
    expect(sql).not.toMatch(/update public\.portal_household_charge_records set row_data = jsonb_build_object/);
  });

  it("carries both account-recovery hooks and refuses a conflicting trigger", () => {
    expect(sql).toContain("create trigger account_recovery_write_guard before insert or update or delete");
    expect(sql).toContain("create trigger account_recovery_capture_delete after delete");
    expect(sql).toContain("recovery guard prerequisites missing for household_charge_refund_attempts");
    expect(sql).toContain("conflicts with the required recovery trigger");
  });
});
