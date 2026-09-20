import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = join(
  process.cwd(),
  "supabase/migrations/20260915103000_prospect_sms_tour_booking.sql",
);
const migration = readFileSync(migrationPath, "utf8").toLowerCase();
const reminderMigration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260915104500_prospect_sms_tour_reminders.sql"),
  "utf8",
).toLowerCase();

describe("prospect SMS tour booking migration", () => {
  it("has durable state for identity, reservations, and idempotent bookings", () => {
    expect(migration).toContain("create table if not exists public.prospect_tour_scheduling_state");
    expect(migration).toContain("unique (manager_user_id, conversation_key, property_id)");
    expect(migration).toContain("trusted_phone_e164 text not null");
    expect(migration).toContain("create table if not exists public.tour_slot_reservations");
    expect(migration).toContain("unique (manager_user_id, slot_key)");
    expect(migration).toContain("create table if not exists public.prospect_tour_bookings");
    expect(migration).toContain("idempotency_key text not null unique");
    expect(migration).toContain("planned_event_id text not null unique");
    expect(migration).toContain("burst_id uuid not null references public.prospect_sms_bursts");
    expect(migration).toContain("offer_snapshot jsonb not null");
    expect(migration).toContain("event_snapshot jsonb not null");
    expect(migration).toContain("confirmation_outbox_id uuid references public.sms_outbox");
    expect(migration).toContain("confirmation_status text not null default 'pending'");
    expect(migration).toContain("manager_notification_status text not null default 'pending'");
    expect(migration).toContain("calendar_sync_status text not null default 'pending'");
    expect(migration).toContain("unique (burst_id, burst_revision)");
  });

  it("keeps schedule mutations behind one transactional RPC boundary", () => {
    expect(migration).toContain("create or replace function public.mutate_confirmed_tour_schedule");
    expect(migration).toContain("for update");
    expect(migration).toContain("p_operation not in ('append','append_event','cancel','delete','replace','patch')");
    expect(migration).toContain("create or replace function public.confirm_prospect_sms_tour_offer");
    expect(migration).toContain("create or replace function public.prepare_prospect_sms_tour_offer");
    expect(migration).toContain("where idempotency_key=p_idempotency_key and manager_user_id=p_manager_user_id");
    expect(migration).toContain("offer_not_prepared");
    expect(migration).toContain("mutate_confirmed_tour_schedule('append',p_event)");
  });

  it("fails closed for client roles and grants execution only to service_role", () => {
    for (const table of [
      "prospect_tour_scheduling_state",
      "tour_slot_reservations",
      "prospect_tour_bookings",
    ]) {
      expect(migration).toContain(`alter table public.${table} enable row level security`);
      expect(migration).toContain(`public.${table}`);
      expect(migration).toMatch(new RegExp(`revoke all on table [^;]*public\\.${table}[^;]*from anon, authenticated`));
    }
    expect(migration).toContain("revoke execute on function public.confirm_prospect_sms_tour_offer");
    expect(migration).toContain("grant execute on function public.confirm_prospect_sms_tour_offer");
    expect(migration).toContain(") to service_role;");
  });

  it("makes the follow-up one-per-burst, submission-gated, and recoverable", () => {
    expect(reminderMigration).toContain("create table if not exists public.prospect_sms_tour_reminders");
    expect(reminderMigration).toContain("unique (burst_id, burst_revision)");
    expect(reminderMigration).toContain("status in ('waiting_submission','scheduled','processing','enqueued','cancelled','blocked')");
    expect(reminderMigration).toContain("b.status='dispatched' and b.handled_revision=r.burst_revision");
    expect(reminderMigration).toContain("interval '2 hours'");
    expect(reminderMigration).toContain("for update skip locked");
    expect(reminderMigration).toContain("status='cancelled', blocked_reason='attempt_no_longer_current'");
    expect(reminderMigration).toContain("prospect_tour_scheduling_state");
    expect(reminderMigration).toContain("status in ('booked','cancelled','handoff','opted_out','deferred')");
    expect(reminderMigration).toContain("revoke all on table public.prospect_sms_tour_reminders from anon, authenticated");
  });
});
