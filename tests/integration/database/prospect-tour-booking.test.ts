/**
 * Real PostgreSQL transaction evidence for the shared schedule mutation gate.
 * Opt in only against a disposable LOCAL
 * cluster: PROSPECT_TOUR_TEST_PORT=55439 npx vitest run
 * tests/integration/database/prospect-tour-booking.test.ts
 *
 * The test creates and drops one uniquely named database. It never reads or
 * writes DATABASE_URL, Supabase, staging, or production.
 */
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { userInfo } from "node:os";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const dispatcherHarness = vi.hoisted(() => ({
  enabled: vi.fn(),
  send: vi.fn(),
  plan: vi.fn(),
  billing: vi.fn(),
  reserve: vi.fn(),
  finish: vi.fn(),
  suppression: vi.fn(),
  scopedConsent: vi.fn(),
  consent: vi.fn(),
  log: vi.fn(),
  sendability: vi.fn(),
  ownerNumber: vi.fn(),
}));
vi.mock("@/lib/sms/prospect-sms-burst.server", () => ({
  durableProspectSmsEnabled: dispatcherHarness.enabled,
}));
vi.mock("@/lib/twilio", () => ({
  sendSms: dispatcherHarness.send,
  normalizeE164: (value: string) => value,
}));
vi.mock("@/lib/comms-billing/wallet.server", () => ({
  commsPlanBudget: dispatcherHarness.plan,
  reserveCommsCredit: dispatcherHarness.reserve,
  finishCommsCredit: dispatcherHarness.finish,
}));
vi.mock("@/lib/comms-billing/eligibility.server", () => ({
  evaluateManagerCommsBillingGate: dispatcherHarness.billing,
}));
vi.mock("@/lib/sms-consent", () => ({
  readSmsSuppressionState: dispatcherHarness.suppression,
  readScopedSmsConsentState: dispatcherHarness.scopedConsent,
}));
vi.mock("@/lib/sms/application-consent.server", () => ({
  ensureApplicationScopedSmsConsent: dispatcherHarness.consent,
}));
vi.mock("@/lib/manager-sms-messages.server", () => ({
  logManagerSmsMessage: dispatcherHarness.log,
}));
vi.mock("@/lib/sms/manager-workspace-role.server", () => ({
  resolveOwnerSendNumberRow: dispatcherHarness.ownerNumber,
}));
vi.mock("@/lib/sms/number-registration-policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sms/number-registration-policy")>()),
  evaluateManagerSmsNumberSendability: dispatcherHarness.sendability,
}));

const toolHarness = vi.hoisted(() => ({
  listOpenTourSlots: vi.fn(),
  loadConfirmedProspectTourBooking: vi.fn(),
  recoverProspectTourBookingSideEffects: vi.fn(),
}));
const googleProviderHarness = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  connection: vi.fn(),
}));
vi.mock("@/lib/tour-availability.server", () => ({ listOpenTourSlots: toolHarness.listOpenTourSlots }));
vi.mock("@/lib/prospect-tour-booking-recovery.server", () => ({
  loadConfirmedProspectTourBooking: toolHarness.loadConfirmedProspectTourBooking,
  recoverProspectTourBookingSideEffects: toolHarness.recoverProspectTourBookingSideEffects,
}));
vi.mock("@/lib/google-calendar/api.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/google-calendar/api.server")>()),
  createGoogleCalendarEvent: googleProviderHarness.create,
  updateGoogleCalendarEvent: googleProviderHarness.update,
  deleteGoogleCalendarEvent: googleProviderHarness.remove,
}));
vi.mock("@/lib/google-calendar/settings", () => ({
  loadGoogleCalendarConnection: googleProviderHarness.connection,
}));

import type { AgentContext } from "@/lib/tools/context";
import { confirmProspectSmsTourTool, prepareProspectTourConfirmationTool } from "@/lib/tools/domains/tours";
import { mutateConfirmedTourSchedule } from "@/lib/tour-schedule-persistence.server";

const configuredPort = process.env.PROSPECT_TOUR_TEST_PORT;
const owner = "11111111-1111-4111-8111-111111111111";
const database = `prospect_tour_test_${randomUUID().replaceAll("-", "")}`;
const burstMigration = "supabase/migrations/20260912143000_prospect_sms_bursts.sql";
const migration = "supabase/migrations/20260915103000_prospect_sms_tour_booking.sql";
const genericScheduleMigration = "supabase/migrations/20260915105500_atomic_planned_schedule_generic.sql";
const reminderMigration = "supabase/migrations/20260915104500_prospect_sms_tour_reminders.sql";
const budgetOwnershipMigration = "supabase/migrations/20260916100000_prospect_tour_confirmation_budget_ownership.sql";
const googleCreateIntentMigration = "supabase/migrations/20260916100500_prospect_tour_google_create_intents.sql";
const googleChangedWindowCorrectionMigration = "supabase/migrations/20260916101000_prospect_tour_google_changed_window_reconciliation.sql";
const plannedScheduleObservedBaselineMigration = "supabase/migrations/20260916101500_planned_schedule_observed_baseline.sql";
const reminderFinalFenceMigration = "supabase/migrations/20260916102000_prospect_tour_reminder_final_fence.sql";
const googleProviderWriteFenceMigration = "supabase/migrations/20260916102500_prospect_tour_google_provider_write_fence.sql";
const lifecycleCasMigration = "supabase/migrations/20260916103000_confirmed_tour_lifecycle_cas.sql";
const profilesMigration = "supabase/migrations/20250418140000_profiles_manager_purchases.sql";
const automationMigration = "supabase/migrations/20260628120001_payment_automation_settings.sql";
const managerSmsNumbersMigration = "supabase/migrations/20260725120000_manager_sms_numbers.sql";
const smsControlPlaneMigration = "supabase/migrations/20260825120000_sms_control_plane.sql";
const commsBillingMigration = "supabase/migrations/20260905130000_manager_comms_billing.sql";
const communicationCreditsMigration = "supabase/migrations/20260910140000_manager_communication_credits.sql";
const campaignBudgetMigration = "supabase/migrations/20260910190000_sms_outbox_campaign_budget.sql";

describe.skipIf(!configuredPort)("confirmed tour schedule transaction boundary", () => {
  let admin: Client;
  let db: Client;
  let created = false;
  const createdRoles: string[] = [];
  const connections = new Set<Client>();

  const connect = async (name = database) => {
    if (!configuredPort || !/^\d+$/.test(configuredPort) || Number(configuredPort) < 1024 || Number(configuredPort) > 65535) {
      throw new Error("PROSPECT_TOUR_TEST_PORT must explicitly name a local test cluster port (1024..65535).");
    }
    const client = new Client({
      host: "127.0.0.1",
      port: Number(configuredPort),
      database: name,
      user: process.env.PROSPECT_TOUR_TEST_USER || userInfo().username,
      password: process.env.PROSPECT_TOUR_TEST_PASSWORD || "",
      connectionTimeoutMillis: 3_000,
      options: "-c statement_timeout=10000 -c lock_timeout=5000",
    });
    await client.connect();
    connections.add(client);
    return client;
  };

  beforeAll(async () => {
    admin = await connect("postgres");
    await admin.query(`create database "${database}"`);
    created = true;
    db = await connect();
    // A plain local PostgreSQL cluster does not necessarily have Supabase's
    // three client roles. Create them only for this disposable test database's
    // migration privilege probe, and remove only roles this test created.
    const roles = await db.query<{ rolname: string }>(
      "select rolname from pg_roles where rolname in ('anon', 'authenticated', 'service_role')",
    );
    const existingRoles = new Set(roles.rows.map((row) => row.rolname));
    for (const role of ["anon", "authenticated", "service_role"]) {
      if (existingRoles.has(role)) continue;
      await db.query(`create role ${role} noinherit`);
      createdRoles.push(role);
    }
    await db.query(`
      create extension if not exists pgcrypto;
      create schema auth;
      create table auth.users(id uuid primary key);
      insert into auth.users(id) values ('${owner}');
      create table public.portal_schedule_records(
        id text primary key,
        manager_user_id uuid,
        property_id text,
        record_type text,
        starts_at timestamptz,
        ends_at timestamptz,
        row_data jsonb not null default '{}',
        updated_at timestamptz not null default now()
      );
      -- Minimal parent rows required by the booking and durable-burst
      -- migrations' foreign keys and PL/pgSQL bodies.
      create table public.sms_outbox(
        id uuid primary key default gen_random_uuid(), manager_user_id uuid, actor_user_id uuid, recipient_user_id uuid,
        recipient_email text, recipient_phone text, body text, send_class text, purpose text,
        conversation_key text, counterparty_role text, property_id text, recipient_timezone text,
        dedupe_key text, trace_id text, segment_count integer, status text,
        available_at timestamptz, blocked_reason text, lease_owner text, lease_expires_at timestamptz,
        dispatch_started_at timestamptz, provider_message_sid text, provider_from_phone text,
        attempt_number integer, provider_error_code text, provider_status text, provider_status_rank integer,
        provider_status_at timestamptz, conversation_log_status text, conversation_log_attempts integer,
        conversation_log_next_attempt_at timestamptz, conversation_log_last_error text,
        created_at timestamptz not null default now(), updated_at timestamptz default now()
      );
      create table public.sms_delivery_attempts(
        id uuid primary key default gen_random_uuid(), outbox_id uuid references public.sms_outbox(id), attempt_number integer default 1,
        state text, provider_message_sid text, provider_error_code text, started_at timestamptz not null default now(), finished_at timestamptz
      );
      create table public.portal_reminder_records(
        id uuid primary key, manager_user_id uuid, kind text, payload jsonb default '{}', status text,
        lease_owner text, lease_expires_at timestamptz, updated_at timestamptz default now()
      );
      create table public.manager_tour_followup_controls(
        manager_user_id uuid, conversation_key text, archived boolean default false, updated_at timestamptz default now(),
        primary key(manager_user_id,conversation_key)
      );
      create table public.prospect_sms_bursts(
        id uuid primary key default gen_random_uuid(),
        manager_user_id uuid not null default '${owner}' references auth.users(id),
        counterparty_phone_e164 text not null default '+12065550123',
        counterparty_role text not null default 'prospect',
        channel text not null default 'sms',
        reply_from_number text,
        revision integer not null default 1,
        handled_revision integer not null default 0,
        status text not null default 'generating',
        due_at timestamptz not null default now(),
        lease_owner text,
        lease_expires_at timestamptz,
        queue_job_id text,
        published_at timestamptz,
        reply_transport text not null default 'twilio',
        shared_catalog boolean not null default false,
        consumed_source_ids jsonb not null default '[]'::jsonb,
        history_snapshot jsonb,
        candidate_context jsonb,
        candidate_shadow_snapshot jsonb,
        candidate_body text,
        outbox_id uuid,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create table public.prospect_sms_ingress(
        source_message_id text primary key,
        burst_id uuid not null references public.prospect_sms_bursts(id),
        manager_user_id uuid not null default '${owner}' references auth.users(id),
        channel text not null default 'twilio',
        burst_revision integer not null,
        body text not null default 'yes',
        received_at timestamptz not null default now(),
        created_at timestamptz not null default now()
      );
    `);
    await db.query("create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;");
    // Apply the current-main control-plane and communication-credit contracts
    // before the tour chain. The small base tables above only scaffold the
    // older migrations' foreign keys; all credit writes are real ledger writes.
    for (const path of [profilesMigration, automationMigration, managerSmsNumbersMigration, smsControlPlaneMigration, commsBillingMigration, communicationCreditsMigration, campaignBudgetMigration]) {
      try {
        await db.query(await readFile(path, "utf8"));
      } catch (error) {
        throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await db.query("insert into public.profiles(id,email,role) values($1,'manager@example.test','manager')", [owner]);
    await db.query(await readFile(burstMigration, "utf8"));
    await db.query(await readFile(migration, "utf8"));
    await db.query(await readFile(reminderMigration, "utf8"));
    await db.query(await readFile(genericScheduleMigration, "utf8"));
    const correctionMigrations = (await readdir("supabase/migrations"))
      .filter((name) => /^20260915\d+_/.test(name) && /prospect|tour/i.test(name))
      .filter((name) => ![
        "20260915103000_prospect_sms_tour_booking.sql",
        "20260915104500_prospect_sms_tour_reminders.sql",
        "20260915105500_atomic_planned_schedule_generic.sql",
      ].includes(name))
      .sort();
    for (const name of correctionMigrations) await db.query(await readFile(`supabase/migrations/${name}`, "utf8"));
    await db.query(await readFile(budgetOwnershipMigration, "utf8"));
    await db.query(await readFile(googleCreateIntentMigration, "utf8"));
    await db.query(await readFile(googleChangedWindowCorrectionMigration, "utf8"));
    await db.query(await readFile(plannedScheduleObservedBaselineMigration, "utf8"));
    await db.query(await readFile(reminderFinalFenceMigration, "utf8"));
    await db.query(await readFile(googleProviderWriteFenceMigration, "utf8"));
    await db.query(await readFile(lifecycleCasMigration, "utf8"));
    await db.query(
      `insert into portal_schedule_records(id, record_type, row_data)
       values ('axis_admin_planned_events_v1', 'axis_admin_planned_events_v1', $1),
              ('axis_admin_partner_inquiries_v1', 'axis_admin_partner_inquiries_v1', $2)`,
      [{ payload: [] }, { payload: [] }],
    );
  });

  afterAll(async () => {
    for (const client of connections) {
      if (client === admin) continue;
      await client.query("rollback").catch(() => undefined);
      await client.end().catch(() => undefined);
    }
    if (created) await admin.query(`drop database "${database}"`).catch(() => undefined);
    for (const role of createdRoles.reverse()) {
      await admin.query(`drop role if exists ${role}`).catch(() => undefined);
    }
    await admin?.end().catch(() => undefined);
  });

  const event = (id: string, slotKey = "2030-06-10:20", start = "2030-06-10T17:00:00.000Z") => ({
    id,
    kind: "tour",
    managerUserId: owner,
    propertyId: "property-1",
    slotKey,
    start,
    end: new Date(Date.parse(start) + 30 * 60_000).toISOString(),
  });

  const mutate = async (
    client: Client,
    operation: "append" | "cancel" | "replace",
    value: Record<string, unknown>,
    expected?: { start: string; end: string; generation: string | null },
  ) => {
    let observed = expected;
    if (operation === "replace" && !observed) {
      const current = (await client.query<{ event: Record<string, unknown> | null }>(
        `select value event from portal_schedule_records,
          jsonb_array_elements(row_data->'payload') value
         where id='axis_admin_planned_events_v1' and value->>'id'=$1`,
        [String(value.id)],
      )).rows[0]?.event;
      observed = current ? {
        start: String(current.start),
        end: String(current.end),
        generation: typeof current.rescheduleNotificationGeneration === "string" ? current.rescheduleNotificationGeneration : null,
      } : undefined;
    }
    return client.query(
      "select mutate_confirmed_tour_schedule($1, $2::jsonb, $3::text[], $4, $5::timestamptz, $6::timestamptz, $7, $8) result",
      [operation, JSON.stringify(value), [], false, observed?.start ?? null, observed?.end ?? null, observed?.generation ?? null, Boolean(observed)],
    );
  };

  const mutationRpcDb = (client: Client) => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name !== "mutate_confirmed_tour_schedule") throw new Error(`unexpected RPC ${name}`);
      const result = await client.query(
        "select mutate_confirmed_tour_schedule($1, $2::jsonb, $3::text[], $4, $5::timestamptz, $6::timestamptz, $7, $8) result",
        [args.p_operation, JSON.stringify(args.p_event), args.p_remove_inquiry_ids, args.p_allow_conflict,
          args.p_expected_start, args.p_expected_end, args.p_expected_generation, args.p_expected_generation_known],
      );
      return { data: result.rows[0]?.result ?? null, error: null };
    },
  }) as never;

  function googleRecoveryDb(client: Client, options: { hangPersist?: boolean } = {}) {
    return {
      async rpc(name: string, args: Record<string, unknown> = {}) {
        if (name === "claim_prospect_tour_google_calendar_create_reconciliation") {
          const result = await client.query(
            "select * from claim_prospect_tour_google_calendar_create_reconciliation($1,$2)",
            [args.p_worker_id, args.p_lease_seconds],
          );
          return { data: result.rows, error: null };
        }
        if (name === "begin_prospect_tour_google_calendar_reconciliation_write") {
          const result = await client.query<{ value: boolean }>(
            "select begin_prospect_tour_google_calendar_reconciliation_write($1,$2,$3,$4,$5,$6) value",
            [
              args.p_planned_event_id,
              args.p_generation,
              args.p_worker_id,
              args.p_expected_start,
              args.p_expected_end,
              args.p_provider_seconds,
            ],
          );
          return { data: result.rows[0]?.value ?? false, error: null };
        }
        if (name === "validate_prospect_tour_google_calendar_write") {
          const result = await client.query<{ value: boolean }>(
            "select validate_prospect_tour_google_calendar_write($1,$2,$3,$4,$5) value",
            [
              args.p_planned_event_id,
              args.p_generation,
              args.p_expected_start,
              args.p_expected_end,
              args.p_worker_id,
            ],
          );
          return { data: result.rows[0]?.value ?? false, error: null };
        }
        if (name === "persist_confirmed_tour_google_calendar_id") {
          if (options.hangPersist) return new Promise<never>(() => undefined);
          const result = await client.query<{ value: Record<string, unknown> }>(
            "select persist_confirmed_tour_google_calendar_id($1,$2,$3,$4) value",
            [args.p_planned_event_id, args.p_google_calendar_event_id, args.p_expected_start, args.p_expected_end],
          );
          return { data: result.rows[0]?.value ?? null, error: null };
        }
        if (name === "complete_prospect_tour_google_calendar_create_reconciliation") {
          const result = await client.query<{ value: boolean }>(
            "select complete_prospect_tour_google_calendar_create_reconciliation($1,$2,$3,$4) value",
            [args.p_planned_event_id, args.p_generation, args.p_worker_id, args.p_state],
          );
          return { data: result.rows[0]?.value ?? false, error: null };
        }
        return { data: null, error: { message: `unexpected rpc ${name}` } };
      },
      from(table: string) {
        const filters = new Map<string, unknown>();
        let updateValues: Record<string, unknown> | null = null;
        const query = {
          select() { return query; },
          eq(column: string, value: unknown) { filters.set(column, value); return query; },
          update(values: Record<string, unknown>) { updateValues = values; return query; },
          async maybeSingle() {
            if (table !== "portal_schedule_records") return { data: null, error: null };
            const result = await client.query("select row_data from portal_schedule_records where id=$1", [filters.get("id")]);
            return { data: result.rows[0] ?? null, error: null };
          },
          then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
            const operation = async () => {
              if (table !== "prospect_tour_google_calendar_create_intents" || !updateValues) {
                return { data: null, error: null };
              }
              const assignments = Object.keys(updateValues).map((key, index) => `${key}=$${index + 1}`);
              const values = Object.values(updateValues);
              const plannedEventId = filters.get("planned_event_id");
              const generation = filters.get("generation");
              const leaseOwner = filters.get("lease_owner");
              const state = filters.get("state");
              await client.query(
                `update prospect_tour_google_calendar_create_intents set ${assignments.join(",")}
                 where planned_event_id=$${values.length + 1} and generation=$${values.length + 2}
                   and lease_owner=$${values.length + 3} and state=$${values.length + 4}`,
                [...values, plannedEventId, generation, leaseOwner, state],
              );
              return { data: null, error: null };
            };
            return operation().then(resolve, reject);
          },
        };
        return query;
      },
    };
  }

  const seedProspectBooking = async (client: Client, suffix: string) => {
    const burstId = randomUUID();
    const stateId = randomUUID();
    const sourceMessageId = `source-${suffix}`;
    const phone = `+1206555${String(300 + Number(suffix)).padStart(4, "0")}`;
    const slotKey = `2030-07-${String(10 + Number(suffix)).padStart(2, "0")}:20`;
    const start = `2030-07-${String(10 + Number(suffix)).padStart(2, "0")}T17:00:00.000Z`;
    const plannedEvent = event(`planned-ledger-${suffix}`, slotKey, start);
    const offer = {
      propertyId: "property-1",
      slotKey,
      start: plannedEvent.start,
      end: plannedEvent.end,
      label: "Thursday, July 10, 2030 at 10:00 AM Pacific",
      hostUserId: owner,
      policy: "published_only",
    };
    const history = [{
      tool: "prepare_prospect_tour_confirmation",
      input: { propertyId: "property-1" },
      output: { preparedOffer: offer },
    }];
    await client.query(
      `insert into prospect_sms_bursts(
        id, manager_user_id, counterparty_phone_e164, revision, status,
        lease_owner, lease_expires_at, history_snapshot
      ) values ($1, $2, $3, 7, 'generating', 'worker-1', now() + interval '5 minutes', $4::jsonb)`,
      [burstId, owner, phone, JSON.stringify(history)],
    );
    await client.query(
      `insert into prospect_sms_ingress(source_message_id, burst_id, burst_revision, body)
       values ($1, $2, 7, 'YES, I confirm 10am')`,
      [sourceMessageId, burstId],
    );
    await client.query(
      `insert into prospect_tour_scheduling_state(
        id, manager_user_id, conversation_key, property_id, contact_name,
        trusted_phone_e164, selected_offer, status
      ) values ($1, $2, $3, 'property-1', 'Ledger Prospect', $4, $5::jsonb, 'offered')`,
      [stateId, owner, `${owner}:prospect:${phone}`, phone, JSON.stringify(offer)],
    );
    return {
      burstId,
      phone,
      key: `prospect-ledger-${suffix}`,
      plannedEvent,
      offer,
      sourceMessageId,
    };
  };

  const confirmProspect = (
    client: Client,
    args: Awaited<ReturnType<typeof seedProspectBooking>>,
    eventOverride = args.plannedEvent,
    overrides: { propertyId?: string; offer?: Record<string, unknown> } = {},
  ) => {
    const propertyId = overrides.propertyId ?? "property-1";
    const offer = overrides.offer ?? args.offer;
    return client.query(
      `select confirm_prospect_sms_tour_offer(
        $1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9,
        $10::uuid, $11::integer, $12, $13
      ) result`,
      [owner, `${owner}:prospect:${args.phone}`, propertyId, args.phone, "Ledger Prospect", null,
        JSON.stringify(offer), JSON.stringify(eventOverride), args.key, args.burstId, 7,
        args.sourceMessageId, "worker-1"],
    );
  };

  it("is idempotent for a retried append and writes one event and reservation", async () => {
    const planned = event("planned-1");
    const first = (await mutate(db, "append", planned)).rows[0].result;
    const retry = (await mutate(db, "append", planned)).rows[0].result;

    expect(first).toMatchObject({ ok: true, event: planned });
    expect(retry).toMatchObject({ ok: true, idempotent: true });
    expect((await db.query("select count(*)::int as count from tour_slot_reservations where manager_user_id = $1 and slot_key = $2 and status = 'active'", [owner, "2030-06-10:20"])).rows[0].count).toBe(1);
    expect((await db.query("select jsonb_array_length(row_data->'payload')::int as count from portal_schedule_records where id = 'axis_admin_planned_events_v1'")).rows[0].count).toBe(1);
  });

  it("reapplies cleanly and rejects a stale manager-slice replacement after a concurrent append", async () => {
    await db.query(await readFile(migration, "utf8"));
    await db.query(await readFile(genericScheduleMigration, "utf8"));
    // Replaying an older idempotent migration must still finish at the current
    // safe schema. Production migration order always reapplies the additive
    // lifecycle correction after the original four-argument definition.
    await db.query(await readFile(lifecycleCasMigration, "utf8"));
    const ordinary = { ...event("ordinary-1", "2030-06-09:18", "2030-06-09T16:00:00.000Z"), kind: "meeting" };
    const appended = (await db.query(
      "select mutate_planned_schedule_event('append',$1::jsonb,null,null) result",
      [JSON.stringify(ordinary)],
    )).rows[0].result;
    expect(appended).toMatchObject({ ok: true });
    const stale = (await db.query(
      "select replace_manager_planned_schedule_slice($1::uuid,$2::jsonb,$3::jsonb,false) result",
      [owner, JSON.stringify([]), JSON.stringify([])],
    )).rows[0].result;
    expect(stale).toMatchObject({ ok: false, reason: "stale_schedule" });
    expect((await db.query(
      "select row_data->'payload' @> $1::jsonb present from portal_schedule_records where id='axis_admin_planned_events_v1'",
      [JSON.stringify([{ id: "ordinary-1" }])],
    )).rows[0].present).toBe(true);
  });

  it("uses an observed non-tour baseline while preserving bookings and protected owners", async () => {
    const otherManager = "22222222-2222-4222-8222-222222222222";
    const adminActor = "33333333-3333-4333-8333-333333333333";
    const ownTask = { id: "baseline-own-task", kind: "task", managerUserId: owner, title: "Old task", start: "2030-08-01T17:00:00.000Z", end: "2030-08-01T17:30:00.000Z" };
    const unassigned = { id: "baseline-unassigned", kind: "meeting", title: "Legacy unassigned", start: "2030-08-01T18:00:00.000Z", end: "2030-08-01T18:30:00.000Z" };
    const nullOwned = { id: "baseline-null", kind: "meeting", managerUserId: null, title: "Legacy null", start: "2030-08-01T19:00:00.000Z", end: "2030-08-01T19:30:00.000Z" };
    const other = { id: "baseline-other", kind: "meeting", managerUserId: otherManager, title: "Other manager", start: "2030-08-01T20:00:00.000Z", end: "2030-08-01T20:30:00.000Z" };
    await db.query(
      "update portal_schedule_records set row_data=jsonb_build_object('id','axis_admin_planned_events_v1','recordType','axis_admin_planned_events_v1','payload',$1::jsonb) where id='axis_admin_planned_events_v1'",
      [JSON.stringify([unassigned, nullOwned, other, ownTask])],
    );

    // The manager observed A, then an SMS confirmation committed B before the
    // stale task snapshot reached the RPC. B and its relational ledger must
    // survive because generic snapshots do not own tour lifecycle.
    const booking = await seedProspectBooking(db, "20");
    expect((await confirmProspect(db, booking)).rows[0].result).toMatchObject({ ok: true });
    const updatedTask = { ...ownTask, title: "Updated task" };
    const newTask = { ...ownTask, id: "baseline-new-task", title: "New task" };
    expect((await db.query(
      "select replace_manager_planned_schedule_slice($1::uuid,$2::jsonb,$3::jsonb,false) result",
      [owner, JSON.stringify([updatedTask, newTask]), JSON.stringify([ownTask])],
    )).rows[0].result).toMatchObject({ ok: true });
    const payloadAfterBooking = (await db.query(
      "select row_data->'payload' payload from portal_schedule_records where id='axis_admin_planned_events_v1'",
    )).rows[0].payload as Array<Record<string, unknown>>;
    expect(payloadAfterBooking.map((row) => row.id)).toEqual(expect.arrayContaining([
      unassigned.id, nullOwned.id, other.id, updatedTask.id, newTask.id, booking.plannedEvent.id,
    ]));
    expect(payloadAfterBooking.find((row) => row.id === unassigned.id)).not.toHaveProperty("managerUserId");
    expect(payloadAfterBooking.find((row) => row.id === nullOwned.id)).toHaveProperty("managerUserId", null);
    expect((await db.query(
      "select status from tour_slot_reservations where planned_event_id=$1",
      [booking.plannedEvent.id],
    )).rows[0].status).toBe("active");
    expect((await db.query(
      "select status from prospect_tour_bookings where planned_event_id=$1",
      [booking.plannedEvent.id],
    )).rows[0].status).toBe("confirmed");

    // A same-id takeover of the missing-owner row is rejected under the lock.
    expect((await db.query(
      "select replace_manager_planned_schedule_slice($1::uuid,$2::jsonb,$3::jsonb,false) result",
      [owner, JSON.stringify([updatedTask, newTask, { ...unassigned, managerUserId: owner }]), JSON.stringify([updatedTask, newTask])],
    )).rows[0].result).toMatchObject({ ok: false, reason: "event_id_conflict" });

    // A different manager can update only their own slice without adopting the
    // two legacy rows or disturbing this manager's tasks and confirmed tour.
    const updatedOther = { ...other, title: "Other manager updated" };
    expect((await db.query(
      "select replace_manager_planned_schedule_slice($1::uuid,$2::jsonb,$3::jsonb,false) result",
      [otherManager, JSON.stringify([updatedOther]), JSON.stringify([other])],
    )).rows[0].result).toMatchObject({ ok: true });

    // Admin authority is explicit and CAS-bound for non-tour rows. Ownership is
    // preserved byte-for-byte and the tour remains outside this generic write.
    const currentNonTours = [unassigned, nullOwned, updatedOther, updatedTask, newTask];
    const adminUpdatedUnassigned = { ...unassigned, title: "Admin updated legacy row" };
    expect((await db.query(
      "select replace_manager_planned_schedule_slice($1::uuid,$2::jsonb,$3::jsonb,true) result",
      [adminActor, JSON.stringify([adminUpdatedUnassigned, nullOwned, updatedOther, updatedTask, newTask]), JSON.stringify(currentNonTours)],
    )).rows[0].result).toMatchObject({ ok: true });

    // Explicit authorized deletion of a non-tour task is coherent and cannot
    // be repurposed to remove the server-owned confirmed tour.
    expect((await db.query(
      "select replace_manager_planned_schedule_slice($1::uuid,$2::jsonb,$3::jsonb,false) result",
      [owner, JSON.stringify([updatedTask]), JSON.stringify([updatedTask, newTask])],
    )).rows[0].result).toMatchObject({ ok: true });
    const finalPayload = (await db.query(
      "select row_data->'payload' payload from portal_schedule_records where id='axis_admin_planned_events_v1'",
    )).rows[0].payload as Array<Record<string, unknown>>;
    expect(finalPayload.some((row) => row.id === newTask.id)).toBe(false);
    expect(finalPayload.find((row) => row.id === booking.plannedEvent.id)).toMatchObject({
      id: booking.plannedEvent.id,
      kind: "tour",
    });
  });

  it("arbitrates the two-hour and legacy tour-interest queues in both dispatch orderings", async () => {
    const seed = async (oldStatus: "deferred" | "submitted", archived = false) => {
      const burstId = randomUUID(); const stateId = randomUUID(); const reminderId = randomUUID();
      const newOutboxId = randomUUID(); const oldOutboxId = randomUUID(); const attemptId = randomUUID(); const oldReminderId = randomUUID();
      const conversation = `${owner}:prospect:+1206555${Math.floor(Math.random() * 8999 + 1000)}`;
      await db.query("insert into prospect_sms_bursts(id,manager_user_id,counterparty_phone_e164,revision,status,lease_owner,lease_expires_at) values($1,$2,'+12065550999',1,'generating','worker',now()+interval '5 minutes')", [burstId, owner]);
      await db.query("insert into prospect_tour_scheduling_state(id,manager_user_id,conversation_key,property_id,trusted_phone_e164,status,revision) values($1,$2,$3,'property-1','+12065550999','offered',1)", [stateId, owner, conversation]);
      await db.query("insert into prospect_sms_tour_reminders(id,burst_id,burst_revision,manager_user_id,scheduling_state_id,scheduling_state_revision,conversation_key,recipient_phone_e164,property_id,status) values($1,$2,1,$3,$4,1,$5,'+12065550999','property-1','enqueued')", [reminderId, burstId, owner, stateId, conversation]);
      await db.query("insert into sms_outbox(id,manager_user_id,recipient_phone,conversation_key,property_id,status,lease_owner,lease_expires_at,prospect_tour_reminder_id) values($1,$2,'+12065550999',$3,'property-1','claimed','new-worker',now()+interval '5 minutes',$4)", [newOutboxId, owner, conversation, reminderId]);
      await db.query("insert into sms_delivery_attempts(id,outbox_id,state) values($1,$2,'claimed')", [attemptId, newOutboxId]);
      await db.query("insert into portal_reminder_records(id,manager_user_id,kind,payload,status) values($1,$2,'tour_interest',jsonb_build_object('conversationKey',$3::text),case when $4::text='submitted' then 'sent' else 'scheduled' end)", [oldReminderId, owner, conversation, oldStatus]);
      await db.query("insert into sms_outbox(id,manager_user_id,recipient_phone,conversation_key,status,dedupe_key,dispatch_started_at,provider_message_sid) values($1,$2,'+12065550999',$3,$4,'tour-interest:'||$5::text,case when $4='submitted' then now() else null end,case when $4='submitted' then 'SM-old' else null end)", [oldOutboxId, owner, conversation, oldStatus, oldReminderId]);
      await db.query("insert into manager_tour_followup_controls(manager_user_id,conversation_key,archived) values($1,$2,$3) on conflict(manager_user_id,conversation_key) do update set archived=excluded.archived", [owner, conversation, archived]);
      return { reminderId, newOutboxId, oldOutboxId, oldReminderId, attemptId, stateId, burstId, conversation };
    };

    const quiet = await seed("deferred");
    expect((await db.query("select begin_prospect_tour_reminder_submission($1,$2,'new-worker',$3,now()) result", [quiet.reminderId, quiet.newOutboxId, quiet.attemptId])).rows[0].result).toBe("started");
    expect((await db.query("select status from sms_outbox where id=$1", [quiet.oldOutboxId])).rows[0].status).toBe("blocked");
    expect((await db.query("select status from portal_reminder_records where id=$1", [quiet.oldReminderId])).rows[0].status).toBe("cancelled");
    const finalFence = () => db.query(
      "select prospect_tour_reminder_submission_is_current($1,$2,'new-worker',$3,$4,'+12065550999','property-1') result",
      [quiet.reminderId, quiet.newOutboxId, owner, quiet.conversation],
    );
    expect((await finalFence()).rows[0].result).toBe(true);
    for (const status of ["booked", "handoff", "opted_out", "deferred"]) {
      await db.query("update prospect_tour_scheduling_state set status=$1 where id=$2", [status, quiet.stateId]);
      expect((await finalFence()).rows[0].result).toBe(false);
      await db.query("update prospect_tour_scheduling_state set status='offered' where id=$1", [quiet.stateId]);
    }
    await db.query("update manager_tour_followup_controls set archived=true where manager_user_id=$1 and conversation_key=$2", [owner, quiet.conversation]);
    expect((await finalFence()).rows[0].result).toBe(false);
    await db.query("update manager_tour_followup_controls set archived=false where manager_user_id=$1 and conversation_key=$2", [owner, quiet.conversation]);
    await db.query("update prospect_sms_bursts set revision=revision+1 where id=$1", [quiet.burstId]);
    expect((await finalFence()).rows[0].result).toBe(false);

    const oldFirst = await seed("submitted");
    expect((await db.query("select begin_prospect_tour_reminder_submission($1,$2,'new-worker',$3,now()) result", [oldFirst.reminderId, oldFirst.newOutboxId, oldFirst.attemptId])).rows[0].result).toBe("stale");
    expect((await db.query("select status from sms_outbox where id=$1", [oldFirst.newOutboxId])).rows[0].status).toBe("blocked");
  });

  it("honors an archived tour follow-up control without resetting it", async () => {
    const burstId = randomUUID(); const stateId = randomUUID(); const conversation = `${owner}:prospect:+1206555${Math.floor(Math.random() * 8999 + 1000)}`;
    await db.query("insert into prospect_sms_bursts(id,manager_user_id,counterparty_phone_e164,revision,status,lease_owner,lease_expires_at) values($1,$2,'+12065550888',1,'generating','worker',now()+interval '5 minutes')", [burstId, owner]);
    await db.query("insert into prospect_tour_scheduling_state(id,manager_user_id,conversation_key,property_id,trusted_phone_e164,status) values($1,$2,$3,'property-1','+12065550888','offered')", [stateId, owner, conversation]);
    await db.query("insert into manager_tour_followup_controls(manager_user_id,conversation_key,archived) values($1,$2,true)", [owner, conversation]);
    expect((await db.query(
      "select register_prospect_sms_tour_reminder($1,1,$2,$3,'+12065550888','property-1',null) result",
      [burstId, owner, conversation],
    )).rows[0].result).toBe(false);
    expect((await db.query("select archived from manager_tour_followup_controls where manager_user_id=$1 and conversation_key=$2", [owner, conversation])).rows[0].archived).toBe(true);
  });

  it("persists the booking ledger before side effects and retries from that ledger", async () => {
    const seeded = await seedProspectBooking(db, "1");
    const first = (await confirmProspect(db, seeded)).rows[0].result;
    const retryEvent = { ...seeded.plannedEvent, id: "retry-generated-id" };
    const retry = (await confirmProspect(db, seeded, retryEvent)).rows[0].result;

    expect(first).toMatchObject({ ok: true, idempotent: false, plannedEventId: seeded.plannedEvent.id, status: "confirmed" });
    expect(retry).toMatchObject({ ok: true, idempotent: true, plannedEventId: seeded.plannedEvent.id, status: "confirmed" });
    const ledger = (await db.query<{ idempotency_key: string; planned_event_id: string; confirmation_status: string; manager_notification_status: string; calendar_sync_status: string }>(
      "select idempotency_key, planned_event_id, confirmation_status, manager_notification_status, calendar_sync_status from prospect_tour_bookings where burst_id = $1",
      [seeded.burstId],
    )).rows[0];
    expect(ledger).toMatchObject({
      idempotency_key: seeded.key,
      planned_event_id: seeded.plannedEvent.id,
      confirmation_status: "pending",
      manager_notification_status: "pending",
      calendar_sync_status: "pending",
    });
    expect((await db.query("select count(*)::int as count from prospect_tour_bookings where burst_id = $1", [seeded.burstId])).rows[0].count).toBe(1);
    expect((await db.query("select count(*)::int as count from portal_schedule_records where id = 'axis_admin_planned_events_v1' and row_data->'payload' @> $1::jsonb", [JSON.stringify([{ id: seeded.plannedEvent.id }])])).rows[0].count).toBe(1);
  });

  it("rejects a prior-property prepared offer even when the slot and reply are identical", async () => {
    const seeded = await seedProspectBooking(db, "2");
    const priorPropertyOffer = { ...seeded.offer, propertyId: "property-2" };
    const priorPropertyEvent = { ...seeded.plannedEvent, propertyId: "property-2" };
    const result = (await confirmProspect(db, seeded, priorPropertyEvent, {
      propertyId: "property-2",
      offer: priorPropertyOffer,
    })).rows[0].result;

    expect(result).toMatchObject({ ok: false, reason: "offer_not_prepared" });
    expect((await db.query("select count(*)::int as count from prospect_tour_bookings where burst_id = $1", [seeded.burstId])).rows[0].count).toBe(0);
  });

  it("rejects a competing reservation and leaves the existing event intact", async () => {
    const result = (await mutate(db, "append", event("planned-2"))).rows[0].result;
    expect(result).toMatchObject({ ok: false, reason: "conflict" });
    expect((await db.query("select count(*)::int as count from tour_slot_reservations where manager_user_id = $1 and slot_key = $2 and status = 'active'", [owner, "2030-06-10:20"])).rows[0].count).toBe(1);
  });

  it("arbitrates concurrent attempts for one manager and slot", async () => {
    const a = await connect();
    const b = await connect();
    try {
      const [left, right] = await Promise.all([
        mutate(a, "append", event("planned-3a", "2030-06-11:20", "2030-06-11T17:00:00.000Z")),
        mutate(b, "append", event("planned-3b", "2030-06-11:20", "2030-06-11T17:00:00.000Z")),
      ]);
      const results = [left.rows[0].result, right.rows[0].result];
      expect(results.filter((result) => result.ok === true)).toHaveLength(1);
      expect(results.filter((result) => result.reason === "conflict")).toHaveLength(1);
      expect((await db.query("select count(*)::int as count from tour_slot_reservations where manager_user_id = $1 and slot_key = $2 and status = 'active'", [owner, "2030-06-11:20"])).rows[0].count).toBe(1);
      const payload = (await db.query<{ payload: Record<string, unknown>[] }>(
        "select row_data->'payload' payload from portal_schedule_records where id = 'axis_admin_planned_events_v1'",
      )).rows[0].payload;
      expect(payload.filter((item) => item.id === "planned-3a" || item.id === "planned-3b")).toHaveLength(1);
    } finally {
      await a.end();
      await b.end();
      connections.delete(a);
      connections.delete(b);
    }
  });

  it("rejects cancel-first and ABA stale replacements under the lifecycle CAS", async () => {
    const original = event("lifecycle-cas", "2030-07-01:20", "2030-07-01T17:00:00.000Z");
    expect((await mutate(db, "append", original)).rows[0].result).toMatchObject({ ok: true });
    const expected = { start: String(original.start), end: String(original.end), generation: null };
    expect((await mutate(db, "cancel", original)).rows[0].result).toMatchObject({ ok: true });
    const staleAfterCancel = { ...original, start: "2030-07-02T17:00:00.000Z", end: "2030-07-02T17:30:00.000Z", slotKey: "2030-07-02:20", rescheduleNotificationGeneration: "move-b" };
    expect((await mutate(db, "replace", staleAfterCancel, expected)).rows[0].result).toMatchObject({ ok: false, reason: "stale_event" });

    const aba = event("lifecycle-aba", "2030-07-03:20", "2030-07-03T17:00:00.000Z");
    expect((await mutate(db, "append", aba)).rows[0].result).toMatchObject({ ok: true });
    const abaExpected = { start: String(aba.start), end: String(aba.end), generation: null };
    const moved = { ...aba, start: "2030-07-04T17:00:00.000Z", end: "2030-07-04T17:30:00.000Z", slotKey: "2030-07-04:20", rescheduleNotificationGeneration: "move-b" };
    expect((await mutate(db, "replace", moved, abaExpected)).rows[0].result).toMatchObject({ ok: true });
    const returnedToA = { ...aba, rescheduleNotificationGeneration: "move-c" };
    expect((await mutate(db, "replace", returnedToA, { start: moved.start, end: moved.end, generation: "move-b" })).rows[0].result).toMatchObject({ ok: true });
    expect((await mutate(db, "replace", { ...moved, rescheduleNotificationGeneration: "stale-b" }, abaExpected)).rows[0].result)
      .toMatchObject({ ok: false, reason: "stale_event" });
  });

  it("treats conflict override as append-only and preserves a failed replacement reservation", async () => {
    const source = event("replace-override-source", "2041-01-01:20", "2041-01-01T17:00:00.000Z");
    const occupied = event("replace-override-occupied", "2041-01-02:20", "2041-01-02T17:00:00.000Z");
    expect((await mutate(db, "append", source)).rows[0].result).toMatchObject({ ok: true });
    expect((await mutate(db, "append", occupied)).rows[0].result).toMatchObject({ ok: true });

    const replacement = { ...source, start: occupied.start, end: occupied.end, slotKey: occupied.slotKey };
    const attempted = await db.query(
      "select mutate_confirmed_tour_schedule('replace', $1::jsonb, '{}'::text[], true, $2::timestamptz, $3::timestamptz, null, true) result",
      [JSON.stringify(replacement), source.start, source.end],
    );
    expect(attempted.rows[0].result).toMatchObject({ ok: false, reason: "conflict" });

    const activeSource = await db.query<{ count: number }>(
      "select count(*)::int count from tour_slot_reservations where manager_user_id=$1 and planned_event_id=$2 and slot_key=$3 and status='active'",
      [owner, source.id, source.slotKey],
    );
    expect(activeSource.rows[0].count).toBe(1);
    const payload = (await db.query<{ payload: Record<string, unknown>[] }>(
      "select row_data->'payload' payload from portal_schedule_records where id='axis_admin_planned_events_v1'",
    )).rows[0].payload;
    expect(payload.find((item) => item.id === source.id)).toMatchObject({
      start: source.start,
      end: source.end,
      slotKey: source.slotKey,
    });
  });

  it("uses active reservation intervals as durable authority, including concurrent writers", async () => {
    await db.query(
      `insert into tour_slot_reservations(manager_user_id,property_id,slot_key,starts_at,ends_at,planned_event_id,status)
       values($1,'property-1','orphan-1000','2030-07-10T17:00:00Z','2030-07-10T17:30:00Z','orphan-interval','active')`,
      [owner],
    );
    const overlap = event("orphan-overlap", "2030-07-10:1945", "2030-07-10T16:45:00.000Z");
    expect((await mutate(db, "append", overlap)).rows[0].result).toMatchObject({ ok: false, reason: "conflict" });
    const adjacent = event("orphan-adjacent", "2030-07-10:2030", "2030-07-10T17:30:00.000Z");
    expect((await mutate(db, "append", adjacent)).rows[0].result).toMatchObject({ ok: true });

    const a = await connect(); const b = await connect();
    try {
      const [left, right] = await Promise.all([
        mutate(a, "append", event("interval-race-a", "2040-01-11:20", "2040-01-11T18:00:00.000Z")),
        mutate(b, "append", event("interval-race-b", "2040-01-11:1945", "2040-01-11T17:45:00.000Z")),
      ]);
      const results = [left.rows[0].result, right.rows[0].result];
      expect(results.filter((result) => result.ok === true)).toHaveLength(1);
      expect(results.filter((result) => result.reason === "conflict")).toHaveLength(1);
    } finally {
      await a.end(); await b.end(); connections.delete(a); connections.delete(b);
    }

    const otherManager = "22222222-2222-4222-8222-222222222222";
    await db.query("insert into auth.users(id) values($1) on conflict do nothing", [otherManager]);
    await db.query(
      `insert into tour_slot_reservations(manager_user_id,property_id,slot_key,starts_at,ends_at,planned_event_id,status)
       values($1,'property-1','other-host-held','2030-07-12T17:00:00Z','2030-07-12T17:30:00Z','other-host-event','active')`,
      [otherManager],
    );
    expect((await mutate(db, "append", event("different-host-overlap", "2030-07-12:20", "2030-07-12T17:00:00.000Z"))).rows[0].result)
      .toMatchObject({ ok: true });
  });

  it("threads lifecycle CAS through the real TypeScript persistence wrapper", async () => {
    const original = event("wrapper-cas", "2030-07-13:20", "2030-07-13T17:00:00.000Z");
    expect((await mutate(db, "append", original)).rows[0].result).toMatchObject({ ok: true });
    const expected = { start: String(original.start), end: String(original.end), generation: null };
    const a = await connect(); const b = await connect();
    try {
      const left = { ...original, start: "2030-07-14T17:00:00.000Z", end: "2030-07-14T17:30:00.000Z", slotKey: "2030-07-14:20", rescheduleNotificationGeneration: "wrapper-b" };
      const right = { ...original, start: "2030-07-15T17:00:00.000Z", end: "2030-07-15T17:30:00.000Z", slotKey: "2030-07-15:20", rescheduleNotificationGeneration: "wrapper-c" };
      const results = await Promise.all([
        mutateConfirmedTourSchedule(mutationRpcDb(a), { operation: "replace", event: left, expected }),
        mutateConfirmedTourSchedule(mutationRpcDb(b), { operation: "replace", event: right, expected }),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok && result.reason === "stale_event")).toHaveLength(1);
    } finally {
      await a.end(); await b.end(); connections.delete(a); connections.delete(b);
    }
  });

  it("exposes only the safe lifecycle-CAS RPC signature", async () => {
    const signatures = (await db.query<{ signature: string }>(
      `select oid::regprocedure::text signature from pg_proc
       where pronamespace='public'::regnamespace and proname='mutate_confirmed_tour_schedule'`,
    )).rows.map((row) => row.signature);
    expect(signatures).toEqual([
      "mutate_confirmed_tour_schedule(text,jsonb,text[],boolean,timestamp with time zone,timestamp with time zone,text,boolean)",
    ]);
  });

  it("preserves different-slot appends and releases a cancelled slot for reuse", async () => {
    const first = event("planned-4", "2030-06-15:20", "2030-06-15T17:00:00.000Z");
    const second = event("planned-5", "2030-06-16:20", "2030-06-16T17:00:00.000Z");
    expect((await mutate(db, "append", first)).rows[0].result).toMatchObject({ ok: true });
    expect((await mutate(db, "append", second)).rows[0].result).toMatchObject({ ok: true });

    const payload = (await db.query<{ payload: Record<string, unknown>[] }>(
      "select row_data->'payload' payload from portal_schedule_records where id = 'axis_admin_planned_events_v1'",
    )).rows[0].payload;
    expect(payload.some((item) => item.id === first.id)).toBe(true);
    expect(payload.some((item) => item.id === second.id)).toBe(true);

    expect((await mutate(db, "cancel", first)).rows[0].result).toMatchObject({ ok: true });
    expect((await db.query<{ status: string }>(
      "select status from tour_slot_reservations where manager_user_id = $1 and slot_key = $2",
      [owner, first.slotKey],
    )).rows[0].status).toBe("cancelled");

    const reused = (await mutate(db, "append", event("planned-6", first.slotKey, first.start as string))).rows[0].result;
    expect(reused).toMatchObject({ ok: true });

    const moved = event("planned-6", "2030-06-17:20", "2030-06-17T17:00:00.000Z");
    expect((await mutate(db, "replace", moved)).rows[0].result).toMatchObject({ ok: true });
    expect((await db.query<{ status: string }>(
      "select status from tour_slot_reservations where manager_user_id = $1 and planned_event_id = $2 and slot_key = $3",
      [owner, moved.id, moved.slotKey],
    )).rows[0].status).toBe("active");
    expect((await db.query<{ count: number }>(
      "select count(*)::int count from tour_slot_reservations where manager_user_id = $1 and slot_key = $2 and status = 'active'",
      [owner, moved.slotKey],
    )).rows[0].count).toBe(1);
  });

  it("claims every ingress revision and rejects a confirmation with an incomplete source snapshot", async () => {
    const phone = "+12065557777";
    const first = await db.query(
      `select * from record_prospect_sms_ingress($1,$2,$3,'twilio',$4,null,1)`,
      ["correction-source-1", owner, phone, "Friday at 3 pm"],
    );
    const burstId = String(first.rows[0].burst_id);
    const second = await db.query(
      `select * from record_prospect_sms_ingress($1,$2,$3,'twilio',$4,null,1)`,
      ["correction-source-2", owner, phone, "YES"],
    );
    const revision = Number(second.rows[0].revision);
    await db.query("update prospect_sms_bursts set due_at=now() where id=$1", [burstId]);
    const claim = await db.query(
      "select * from claim_prospect_sms_burst($1,$2,'agreement-worker',120)",
      [burstId, revision],
    );
    const claimedIds = (claim.rows[0].source_ids ?? []) as string[];
    expect(claim.rows[0].claimed).toBe(true);
    expect(claimedIds).toEqual(["correction-source-1", "correction-source-2"]);
    expect((await db.query<{ consumed_source_ids: string[] }>(
      "select consumed_source_ids from prospect_sms_bursts where id=$1", [burstId],
    )).rows[0].consumed_source_ids).toEqual(claimedIds);

    const offer = {
      propertyId: "property-1", slotKey: "2099-09-10:20",
      start: "2099-09-10T17:00:00.000Z", end: "2099-09-10T17:30:00.000Z",
      label: "Thursday, September 10, 2099 at 10:00 AM Pacific",
      hostUserId: owner, policy: "published_only",
    };
    await db.query(
      `insert into prospect_tour_scheduling_state(
        id,manager_user_id,conversation_key,property_id,contact_name,
        trusted_phone_e164,selected_offer,status
      ) values($1,$2,$3,'property-1','Revision Prospect',$4,$5::jsonb,'offered')`,
      [randomUUID(), owner, `${owner}:prospect:${phone}`, phone, JSON.stringify(offer)],
    );
    await db.query("update prospect_sms_bursts set history_snapshot=$2::jsonb where id=$1", [burstId, JSON.stringify([{
      tool: "prepare_prospect_tour_confirmation", input: { propertyId: "property-1" }, output: { preparedOffer: offer },
    }])]);

    const functionRow = await db.query<{ proargnames: string[] }>(
      `select p.proargnames from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='confirm_prospect_sms_tour_offer'
         and array_to_string(p.proargnames, ',') like '%claimed_source%' limit 1`,
    );
    const argNames = functionRow.rows[0]?.proargnames ?? [];
    const claimedArg = argNames.find((name) => /claimed_source/i.test(name));
    if (!claimedArg) throw new Error("Correction migration must expose p_claimed_source_ids on the booking RPC.");

    const valuesByName: Record<string, unknown> = {
      p_manager_user_id: owner,
      p_conversation_key: `${owner}:prospect:${phone}`,
      p_property_id: "property-1",
      p_trusted_phone_e164: phone,
      p_contact_name: "Revision Prospect",
      p_contact_email: null,
      p_offer: JSON.stringify(offer),
      p_event: JSON.stringify({
        id: "revision-event", kind: "tour", managerUserId: owner, adminUserId: owner,
        propertyId: "property-1", slotKey: offer.slotKey, start: offer.start, end: offer.end,
      }),
      p_idempotency_key: "revision-incomplete-source",
      p_burst_id: burstId,
      p_burst_revision: revision,
      p_agreement_source_message_id: "correction-source-2",
      p_worker_id: "agreement-worker",
      [claimedArg]: ["correction-source-2"],
    };
    const params: unknown[] = [];
    const callArgs = argNames.map((name) => {
      params.push(valuesByName[name]);
      const index = params.length;
      return `${name} => $${index}${name === "p_offer" || name === "p_event" ? "::jsonb" : name === claimedArg ? "::text[]" : ""}`;
    }).join(", ");
    const result = (await db.query(`select public.confirm_prospect_sms_tour_offer(${callArgs}) result`, params)).rows[0].result;
    expect(result).toMatchObject({ ok: false });
    expect((await db.query("select count(*)::int count from prospect_tour_bookings where burst_id=$1", [burstId])).rows[0].count).toBe(0);
  });

  it("keeps Google-id writes lifecycle-safe across move, cancel, and delete", async () => {
    const initial = event("google-lifecycle-1", "2099-08-10:20", "2099-08-10T17:00:00.000Z");
    expect((await mutate(db, "append", initial)).rows[0].result).toMatchObject({ ok: true });

    const persisted = (await db.query(
      `select persist_confirmed_tour_google_calendar_id($1,$2,$3,$4) result`,
      [initial.id, "google-event-1", initial.start, initial.end],
    )).rows[0].result;
    expect(persisted).toMatchObject({ ok: true });
    const stored = (await db.query<{ payload: Record<string, unknown>[] }>(
      "select row_data->'payload' payload from portal_schedule_records where id='axis_admin_planned_events_v1'",
    )).rows[0].payload.find((row) => row.id === initial.id);
    expect(stored).toMatchObject({ id: initial.id, start: initial.start, end: initial.end, googleCalendarEventId: "google-event-1" });

    const moved = event(initial.id, "2099-08-11:20", "2099-08-11T17:00:00.000Z");
    expect((await mutate(db, "replace", moved)).rows[0].result).toMatchObject({ ok: true });
    const staleMove = (await db.query(
      `select persist_confirmed_tour_google_calendar_id($1,$2,$3,$4) result`,
      [initial.id, "google-event-stale", initial.start, initial.end],
    )).rows[0].result;
    expect(staleMove).toMatchObject({ ok: false, reason: "changed" });
    const currentAfterMove = (await db.query<{ payload: Record<string, unknown>[] }>(
      "select row_data->'payload' payload from portal_schedule_records where id='axis_admin_planned_events_v1'",
    )).rows[0].payload.find((row) => row.id === initial.id);
    expect(currentAfterMove).toMatchObject({ id: initial.id, start: moved.start, end: moved.end });
    expect(currentAfterMove?.googleCalendarEventId).not.toBe("google-event-stale");

    expect((await mutate(db, "cancel", moved)).rows[0].result).toMatchObject({ ok: true });
    const cancelled = (await db.query(
      `select persist_confirmed_tour_google_calendar_id($1,$2,$3,$4) result`,
      [initial.id, "google-event-after-cancel", moved.start, moved.end],
    )).rows[0].result;
    expect(cancelled).toMatchObject({ ok: false, reason: "cancelled" });

    const deleted = event("google-lifecycle-2", "2099-08-12:20", "2099-08-12T17:00:00.000Z");
    expect((await mutate(db, "append", deleted)).rows[0].result).toMatchObject({ ok: true });
    expect((await mutate(db, "delete", deleted)).rows[0].result).toMatchObject({ ok: true });
    const missing = (await db.query(
      `select persist_confirmed_tour_google_calendar_id($1,$2,$3,$4) result`,
      [deleted.id, "google-event-after-delete", deleted.start, deleted.end],
    )).rows[0].result;
    expect(missing).toMatchObject({ ok: false, reason: "missing" });
  });

  /**
   * Continuous non-provider harness: real ingress revisions and claim run
   * through PostgreSQL, then typed prepare/confirm handlers call the applied
   * SQL booking boundary and its outbox submission is delivered to an
   * in-process sink. This test intentionally does not call Twilio, Google,
   * email, or a hosted Supabase endpoint.
   */
  it("joins real ingress, typed prepare/confirm, booking SQL, and the provider sink", async () => {
    toolHarness.listOpenTourSlots.mockReset().mockResolvedValue({
      ok: true,
      resolution: "resolved",
      slotHosts: { "2099-10-10:20": [{ userId: owner, label: "Akhil" }] },
    });
    toolHarness.recoverProspectTourBookingSideEffects.mockReset().mockResolvedValue({
      calendarSync: { ok: true, skipped: true }, managerNotification: { ok: true, suppressed: true },
    });
    let bookingForHandler: Record<string, unknown> | null = null;
    toolHarness.loadConfirmedProspectTourBooking.mockReset().mockImplementation(async () => bookingForHandler);
    const phone = "+12065558888";
    const slot = {
      slotKey: "2099-10-10:20",
      start: "2099-10-10T17:00:00.000Z",
      end: "2099-10-10T17:30:00.000Z",
      hostUserId: owner,
    };
    const first = (await db.query(
      "select * from record_prospect_sms_ingress($1,$2,$3,'twilio',$4,null,1)",
      ["typed-source-1", owner, phone, "Thursday at 10"],
    )).rows[0];
    const burstId = String(first.burst_id);
    const firstRevision = Number(first.revision);
    await db.query("update prospect_sms_bursts set due_at=now() where id=$1", [burstId]);
    const firstClaim = (await db.query(
      "select * from claim_prospect_sms_burst($1,$2,'typed-worker-1',120)", [burstId, firstRevision],
    )).rows[0];

    const pgToolDb = {
      from(table: string) {
        if (table !== "prospect_sms_ingress") throw new Error(`unexpected typed-harness table ${table}`);
        const filters: Record<string, unknown> = {};
        let sourceIds: string[] = [];
        const query: Record<string, unknown> = {};
        query.select = () => query;
        query.eq = (column: string, value: unknown) => { filters[column] = value; return query; };
        query.in = (_column: string, values: string[]) => { sourceIds = values; return query; };
        query.order = () => query;
        query.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
          const args = [filters.burst_id, sourceIds];
          return db.query(
            "select source_message_id,body,received_at from prospect_sms_ingress where burst_id=$1 and source_message_id=any($2::text[]) order by received_at,source_message_id",
            args,
          ).then((result) => resolve({ data: result.rows, error: null }), reject);
        };
        return query;
      },
      async rpc(name: string, args: Record<string, unknown>) {
        if (name === "prepare_prospect_sms_tour_offer") {
          const result = (await db.query(
            "select public.prepare_prospect_sms_tour_offer($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10) result",
            [args.p_manager_user_id, args.p_conversation_key, args.p_property_id, args.p_trusted_phone_e164,
              args.p_contact_name, args.p_contact_email, JSON.stringify(args.p_offer), args.p_burst_id,
              args.p_burst_revision, args.p_worker_id],
          )).rows[0].result;
          return { data: result, error: null };
        }
        if (name === "confirm_prospect_sms_tour_offer") {
          const result = (await db.query(
            `select public.confirm_prospect_sms_tour_offer(
              $1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13::text[],$14
            ) result`,
            [args.p_manager_user_id, args.p_conversation_key, args.p_property_id, args.p_trusted_phone_e164,
              args.p_contact_name, args.p_contact_email, JSON.stringify(args.p_offer), JSON.stringify(args.p_event),
              args.p_idempotency_key, args.p_burst_id, args.p_burst_revision, args.p_agreement_source_message_id,
              args.p_claimed_source_ids, args.p_worker_id],
          )).rows[0].result;
          if (result?.ok === true) {
            bookingForHandler = {
              id: String((await db.query<{ id: string }>("select id from prospect_tour_bookings where idempotency_key=$1", [args.p_idempotency_key])).rows[0].id),
              manager_user_id: owner, planned_event_id: result.plannedEventId, burst_id: burstId,
              burst_revision: Number(args.p_burst_revision), offer_snapshot: args.p_offer as Record<string, unknown>,
              event_snapshot: args.p_event as Record<string, unknown>, confirmation_body: "Tour confirmed",
              confirmation_outbox_id: null, confirmation_status: "pending", manager_notification_status: "completed",
              calendar_sync_status: "skipped", status: "confirmed",
            };
          }
          return { data: result, error: null };
        }
        throw new Error(`unexpected typed-harness RPC ${name}`);
      },
    };
    const ctx = {
      landlordId: owner, userId: owner, email: "", roles: ["leasing_sms_agent"], isAdmin: false,
      db: pgToolDb, leasingScope: {
        sessionId: "typed-session", prospectPhoneE164: phone, workNumber: "+12055550100",
        prospectBurst: { burstId, revision: firstRevision, workerId: "typed-worker-1", claimedSourceIds: ["typed-source-1"] },
      },
    } as unknown as AgentContext;
    expect(firstClaim.claimed).toBe(true);
    const prepared = await prepareProspectTourConfirmationTool.handler(ctx, {
      propertyId: "property-1", propertyTitle: "Ballard House", ...slot, name: "Jordan Lee",
    });
    expect(prepared).toMatchObject({ preparedOffer: { slotKey: slot.slotKey, policy: "published_only" } });
    await db.query("update prospect_sms_bursts set history_snapshot=$2::jsonb,handled_revision=$3,status='queued',lease_owner=null,lease_expires_at=null,due_at=now() where id=$1", [burstId, JSON.stringify([{ tool: "prepare_prospect_tour_confirmation", input: { propertyId: "property-1" }, output: { preparedOffer: { ...slot, propertyId: "property-1", policy: "published_only" } } }]), firstRevision]);

    const second = (await db.query(
      "select * from record_prospect_sms_ingress($1,$2,$3,'twilio',$4,null,1)",
      ["typed-source-2", owner, phone, "YES"],
    )).rows[0];
    const secondRevision = Number(second.revision);
    await db.query("update prospect_sms_bursts set due_at=now() where id=$1", [burstId]);
    const secondClaim = (await db.query("select * from claim_prospect_sms_burst($1,$2,'typed-worker-2',120)", [burstId, secondRevision])).rows[0];
    const confirmCtx = { ...ctx, leasingScope: { ...ctx.leasingScope!, prospectBurst: { burstId, revision: secondRevision, workerId: "typed-worker-2", claimedSourceIds: ["typed-source-2"] } } } as unknown as AgentContext;
    const confirmed = await confirmProspectSmsTourTool.handler(confirmCtx, {
      propertyId: "property-1", propertyTitle: "Ballard House", ...slot, name: "Jordan Lee",
    });
    expect(secondClaim.claimed).toBe(true);
    expect(confirmed).toMatchObject({ booking: { status: "confirmed" } });
    expect(bookingForHandler?.id).toBeTruthy();

    const outboxId = randomUUID();
    const attemptId = randomUUID();
    await db.query(
      `insert into sms_outbox(id,manager_user_id,recipient_phone,body,status,lease_owner,lease_expires_at,prospect_tour_booking_confirmation_id)
       values($1,$2,$3,'Tour confirmed','claimed','typed-sink',now()+interval '5 minutes',$4)`,
      [outboxId, owner, phone, bookingForHandler?.id],
    );
    await db.query("insert into sms_delivery_attempts(id,outbox_id,state) values($1,$2,'submitting')", [attemptId, outboxId]);
    const sinkBoundary = (await db.query(
      "select begin_prospect_tour_booking_confirmation_submission($1,$2,'typed-sink',$3,now()) result",
      [bookingForHandler?.id, outboxId, attemptId],
    )).rows[0].result;
    expect(sinkBoundary).toBe("started");
    await db.query("update sms_outbox set status='submitted',provider_message_sid='TYPED-SINK-1' where id=$1", [outboxId]);
    expect((await db.query("select count(*)::int count from sms_outbox where provider_message_sid='TYPED-SINK-1'", [])).rows[0].count).toBe(1);
  });

  it("runs the confirmation outbox boundary through a deterministic provider sink", async () => {
    const seeded = await seedProspectBooking(db, "8");
    expect((await confirmProspect(db, seeded)).rows[0].result).toMatchObject({ ok: true });
    const bookingRow = (await db.query<{ id: string }>(
      "select id from prospect_tour_bookings where burst_id=$1",
      [seeded.burstId],
    )).rows[0];
    const outboxId = randomUUID();
    const attemptId = randomUUID();
    await db.query(
      `insert into sms_outbox(
        id,manager_user_id,recipient_phone,body,status,lease_owner,lease_expires_at,
        prospect_tour_booking_confirmation_id
      ) values($1,$2,$3,'Tour confirmed', 'claimed','sink-worker',now()+interval '5 minutes',$4)`,
      [outboxId, owner, seeded.phone, bookingRow.id],
    );
    await db.query("insert into sms_delivery_attempts(id,outbox_id,state) values($1,$2,'submitting')", [attemptId, outboxId]);
    const started = (await db.query(
      `select begin_prospect_tour_booking_confirmation_submission($1,$2,'sink-worker',$3,now()) result`,
      [bookingRow.id, outboxId, attemptId],
    )).rows[0].result;
    expect(started).toBe("started");

    // This is the deterministic delivery sink: no Twilio call is made. The
    // acceptance is recorded exactly once after the no-retry DB boundary.
    await db.query(
      "update sms_outbox set status='submitted',provider_message_sid='SINK-1',updated_at=now() where id=$1 and status='submitting'",
      [outboxId],
    );
    expect((await db.query<{ count: number }>(
      "select count(*)::int count from sms_outbox where prospect_tour_booking_confirmation_id=$1 and status='submitted'",
      [bookingRow.id],
    )).rows[0].count).toBe(1);
    const retry = (await db.query(
      `select begin_prospect_tour_booking_confirmation_submission($1,$2,'sink-worker',$3,now()) result`,
      [bookingRow.id, outboxId, attemptId],
    )).rows[0].result;
    expect(retry).toBe("unavailable");
    expect((await db.query<{ count: number }>(
      "select count(*)::int count from sms_outbox where prospect_tour_booking_confirmation_id=$1 and provider_message_sid='SINK-1'",
      [bookingRow.id],
    )).rows[0].count).toBe(1);

    const cancelledSeed = await seedProspectBooking(db, "9");
    expect((await confirmProspect(db, cancelledSeed)).rows[0].result).toMatchObject({ ok: true });
    const cancelledBooking = (await db.query<{ id: string }>(
      "select id from prospect_tour_bookings where burst_id=$1",
      [cancelledSeed.burstId],
    )).rows[0];
    const cancelledOutbox = randomUUID();
    const cancelledAttempt = randomUUID();
    await db.query(
      `insert into sms_outbox(id,manager_user_id,recipient_phone,body,status,lease_owner,lease_expires_at,prospect_tour_booking_confirmation_id)
       values($1,$2,$3,'Tour confirmed','claimed','sink-worker',now()+interval '5 minutes',$4)`,
      [cancelledOutbox, owner, cancelledSeed.phone, cancelledBooking.id],
    );
    await db.query("insert into sms_delivery_attempts(id,outbox_id,state) values($1,$2,'submitting')", [cancelledAttempt, cancelledOutbox]);
    expect((await mutate(db, "cancel", cancelledSeed.plannedEvent)).rows[0].result).toMatchObject({ ok: true });
    const stale = (await db.query(
      `select begin_prospect_tour_booking_confirmation_submission($1,$2,'sink-worker',$3,now()) result`,
      [cancelledBooking.id, cancelledOutbox, cancelledAttempt],
    )).rows[0].result;
    expect(stale).toBe("stale");
    expect((await db.query<{ status: string; provider_message_sid: string | null }>(
      "select status,provider_message_sid from sms_outbox where id=$1",
      [cancelledOutbox],
    )).rows[0]).toMatchObject({ status: "blocked", provider_message_sid: null });
  });

  it("spends campaign and communication credit once when recovery claims before normal attach", async () => {
    dispatcherHarness.enabled.mockReturnValue(true);
    dispatcherHarness.plan.mockResolvedValue({ allowance: 1500, legacy: 1500 });
    dispatcherHarness.billing.mockResolvedValue({ allowed: true });
    dispatcherHarness.sendability.mockReturnValue({ sendable: true });
    dispatcherHarness.ownerNumber.mockResolvedValue({
      data: {
        manager_user_id: owner,
        workspace_id: "workspace-1",
        phone_number: "+12065550999",
        phone_number_sid: "PN-SINK",
        messaging_service_sid: "MG-SINK",
        campaign_sid: "CA-SINK",
        provision_state: "active",
        registration_state: "approved",
        registration_ref: "registration-1",
        attachment_state: "attached",
        number_registration_state: "registered",
        grace_started_at: null,
        grace_expires_at: null,
        quarantined_at: null,
        quarantine_reason: null,
      },
      error: null,
    });
    dispatcherHarness.suppression.mockResolvedValue({ ok: true, optedOut: false });
    dispatcherHarness.scopedConsent.mockResolvedValue({ ok: true, state: "granted" });
    dispatcherHarness.consent.mockResolvedValue({ ok: true, granted: true });
    dispatcherHarness.log.mockResolvedValue(true);
    dispatcherHarness.reserve.mockResolvedValue({ allowed: true, duplicate: false, state: "reserved" });
    dispatcherHarness.finish.mockImplementation(async (_adapter: unknown, managerUserId: string, key: string) => {
      await db.query("select public.finish_comms_credit($1,$2,false)", [managerUserId, key]);
    });
    dispatcherHarness.send.mockResolvedValue({ sent: true, sid: "SM-RECOVERY-FIRST", providerAttempted: true });
    vi.stubEnv("SMS_RUNTIME_ENABLED", "1");
    vi.stubEnv("SMS_OUTBOX_SCHEDULER_READY", "1");
    vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MG-SINK");
    vi.stubEnv("TWILIO_CAMPAIGN_SID", "CA-SINK");

    await db.query("truncate sms_segment_usage");
    await db.query("update sms_runtime_config set campaign_daily_segment_limit=1 where singleton=true");

    const seeded = await seedProspectBooking(db, "21");
    expect((await confirmProspect(db, seeded)).rows[0].result).toMatchObject({ ok: true });
    const bookingId = (await db.query<{ id: string }>(
      "select id from prospect_tour_bookings where burst_id=$1",
      [seeded.burstId],
    )).rows[0].id;
    const prepared = (await db.query<{ outbox_id: string; status: string }>(
      `select * from prepare_prospect_tour_booking_confirmation(
        $1,$2,$2,null,$3,$4,'Tour confirmed','transactional','manager_conversation',
        $5,'prospect','property-1','America/Los_Angeles',$6,null,1,'queued',now(),null
      )`,
      [bookingId, owner, seeded.phone, seeded.phone, `${owner}:prospect:${seeded.phone}`, `booking-confirmation:${bookingId}`],
    )).rows[0];
    expect(prepared.status).toBe("queued");

    type Filter = { column: string; operator: "eq" | "is" | "lt" | "gt"; value: unknown };
    const rpcCalls: string[] = [];
    const dispatcherDb = {
      from(table: string) {
        let updateValues: Record<string, unknown> | null = null;
        let insertValues: Record<string, unknown> | null = null;
        const filters: Filter[] = [];
        const query: Record<string, unknown> = {};
        const self = () => query;
        const run = async () => {
          if (insertValues) {
            if (table !== "sms_delivery_attempts") throw new Error(`unexpected insert table ${table}`);
            const inserted = await db.query(
              `insert into sms_delivery_attempts(id,outbox_id,attempt_number,state)
               values(coalesce($1::uuid,gen_random_uuid()),$2,$3,$4) returning id`,
              [insertValues.id, insertValues.outbox_id, insertValues.attempt_number ?? 1, insertValues.state],
            );
            return { data: inserted.rows[0], error: null };
          }
          if (updateValues) {
            const columns = Object.keys(updateValues).filter((column) => /^[a-z_]+$/.test(column));
            if (!columns.length) return { data: null, error: null };
            const params: unknown[] = [];
            const assignments = columns.map((column) => {
              params.push(updateValues?.[column]);
              return `${column}=$${params.length}`;
            });
            const where = filters.map((filter) => {
              if (filter.operator === "is") return `${filter.column} is null`;
              params.push(filter.value);
              const operator = filter.operator === "eq" ? "=" : filter.operator === "lt" ? "<" : ">";
              return `${filter.column}${operator}$${params.length}`;
            });
            if (!where.length) throw new Error(`unscoped update on ${table}`);
            const result = await db.query(
              `update public.${table} set ${assignments.join(",")} where ${where.join(" and ")} returning id`,
              params,
            );
            return { data: result.rows[0] ?? null, error: null };
          }
          if (table === "sms_outbox") {
            const id = filters.find((filter) => filter.column === "id")?.value;
            if (!id) return { data: [], error: null };
            const result = await db.query("select * from sms_outbox where id=$1", [id]);
            return { data: result.rows[0] ?? null, error: null };
          }
          if (table === "sms_runtime_config") {
            return { data: { mode: "automatic", pilot_manager_user_ids: [owner] }, error: null };
          }
          if (table === "sms_delivery_attempts") return { data: [], error: null };
          if (table === "sms_delivery_events") return { data: null, error: null };
          return { data: null, error: null };
        };
        query.select = self;
        query.update = (values: Record<string, unknown>) => { updateValues = values; return query; };
        query.insert = (values: Record<string, unknown>) => { insertValues = values; return query; };
        query.eq = (column: string, value: unknown) => { filters.push({ column, operator: "eq", value }); return query; };
        query.is = (column: string) => { filters.push({ column, operator: "is", value: null }); return query; };
        query.lt = (column: string, value: unknown) => { filters.push({ column, operator: "lt", value }); return query; };
        query.gt = (column: string, value: unknown) => { filters.push({ column, operator: "gt", value }); return query; };
        query.in = self;
        query.order = self;
        query.limit = self;
        query.maybeSingle = run;
        query.single = run;
        query.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => run().then(resolve, reject);
        return query;
      },
      rpc: async (name: string, args: Record<string, unknown>) => {
        rpcCalls.push(name);
        if (name === "claim_sms_outbox") {
          const claimed = (await db.query("select * from sms_outbox where id=$1 and status in ('queued','deferred')", [prepared.outbox_id])).rows[0];
          if (!claimed) return { data: [], error: null };
          await db.query(
            "update sms_outbox set status='claimed',lease_owner=$2,lease_expires_at=now()+interval '5 minutes' where id=$1",
            [prepared.outbox_id, args.p_worker_id],
          );
          const staleSnapshot = (await db.query("select * from sms_outbox where id=$1", [prepared.outbox_id])).rows[0];
          expect(staleSnapshot.prospect_burst_id).toBeNull();
          const attached = (await db.query(
            `select * from prepare_prospect_tour_booking_confirmation(
              $1,$2,$2,null,$3,$4,'Tour confirmed','transactional','manager_conversation',
              $5,'prospect','property-1','America/Los_Angeles',$6,null,1,'queued',now(),null,
              $7,7,'worker-1','twilio',null,$8::jsonb,$9::jsonb
            )`,
            [bookingId, owner, seeded.phone, seeded.phone, `${owner}:prospect:${seeded.phone}`, `booking-confirmation:${bookingId}`,
              seeded.burstId, JSON.stringify([{ tool: "confirm_prospect_tour" }]), JSON.stringify({ primaryOutput: "Tour confirmed" })],
          )).rows[0];
          expect(attached.outbox_id).toBe(prepared.outbox_id);
          // The recovery claim and normal worker attachment are one durable
          // handoff. Return the adopted row so the dispatcher selects the
          // booking-specific fence rather than the legacy burst-only path.
          const adoptedSnapshot = (await db.query("select * from sms_outbox where id=$1", [prepared.outbox_id])).rows[0];
          return { data: [{ ...adoptedSnapshot, status: "claimed", lease_owner: args.p_worker_id }], error: null };
        }
        if (name === "begin_prospect_tour_booking_confirmation_submission_v2") {
          const result = await db.query(
            `select public.begin_prospect_tour_booking_confirmation_submission_v2(
              $1,$2,$3,$4,$5,$6,$7,$8,$9
            ) result`,
            [args.p_booking_id, args.p_outbox_id, args.p_outbox_worker_id, args.p_attempt_id, args.p_dispatch_started_at,
              args.p_allowance, args.p_legacy_allowance, args.p_unit_cents, args.p_provider_from_phone],
          );
          expect(result.rows[0].result).toEqual({ outcome: "started", costs_reserved: true });
          return { data: result.rows[0].result, error: null };
        }
        if (name === "begin_sms_outbox_submission") {
          const result = await db.query(
            `select public.begin_sms_outbox_submission($1,$2,$3,$4,$5,$6,$7,$8) result`,
            [args.p_outbox_id, args.p_outbox_worker_id, args.p_attempt_id, args.p_dispatch_started_at,
              args.p_allowance, args.p_legacy_allowance, args.p_unit_cents, args.p_provider_from_phone],
          );
          return { data: result.rows[0].result, error: null };
        }
        if (name === "spend_sms_segment_budget") {
          const result = await db.query("select public.spend_sms_segment_budget($1) result", [args.p_segments]);
          return { data: result.rows[0].result, error: null };
        }
        if (name === "apply_sms_delivery_status") return { data: true, error: null };
        return { data: null, error: null };
      },
    };

    vi.resetModules();
    vi.doMock("@/lib/sms/prospect-sms-burst.server", () => ({ durableProspectSmsEnabled: dispatcherHarness.enabled }));
    vi.doMock("@/lib/twilio", () => ({ sendSms: dispatcherHarness.send, normalizeE164: (value: string) => value }));
    vi.doMock("@/lib/comms-billing/wallet.server", () => ({
      commsPlanBudget: dispatcherHarness.plan,
      reserveCommsCredit: dispatcherHarness.reserve,
      finishCommsCredit: dispatcherHarness.finish,
    }));
    vi.doMock("@/lib/comms-billing/eligibility.server", () => ({ evaluateManagerCommsBillingGate: dispatcherHarness.billing }));
    vi.doMock("@/lib/sms-consent", () => ({ readSmsSuppressionState: dispatcherHarness.suppression, readScopedSmsConsentState: dispatcherHarness.scopedConsent }));
    vi.doMock("@/lib/sms/application-consent.server", () => ({ ensureApplicationScopedSmsConsent: dispatcherHarness.consent }));
    vi.doMock("@/lib/manager-sms-messages.server", () => ({ logManagerSmsMessage: dispatcherHarness.log }));
    vi.doMock("@/lib/reminders/subjects/tour-interest.server", () => ({
      materializeTourInterestFromOutbox: vi.fn().mockResolvedValue(true),
    }));
    vi.doMock("@/lib/sms/manager-workspace-role.server", () => ({ resolveOwnerSendNumberRow: dispatcherHarness.ownerNumber }));
    vi.doMock("@/lib/sms/number-registration-policy", async () => ({
      estimateSmsSegments: (body: string) => ({ segmentCount: body.length ? 1 : 0 }),
      evaluateManagerSmsNumberSendability: dispatcherHarness.sendability,
      quietHoursBlocks: () => false,
    }));
    const { dispatchOwnerSmsOutbox } = await import("@/lib/sms/owner-sms-dispatcher.server");
    const first = await dispatchOwnerSmsOutbox({ workerId: "recovery-worker", outboxId: prepared.outbox_id }, dispatcherDb as never);
    const firstOutboxState = (await db.query("select status,blocked_reason from sms_outbox where id=$1", [prepared.outbox_id])).rows[0];
    expect(first, `result: ${JSON.stringify(first)}; RPC calls: ${rpcCalls.join(", ")}; outbox: ${JSON.stringify(firstOutboxState)}`).toMatchObject({ ok: true, claimed: 1, submitted: 1, blocked: 0, unknown: 0 });
    expect(dispatcherHarness.send).toHaveBeenCalledTimes(1);
    expect(dispatcherHarness.reserve).not.toHaveBeenCalled();
    expect(dispatcherHarness.finish).toHaveBeenCalledWith(dispatcherDb, owner, `sms_outbound:${prepared.outbox_id}`);
    expect((await db.query<{ segment_count: number }>(
      "select segment_count from sms_segment_usage where usage_date=(now() at time zone 'utc')::date",
    )).rows).toEqual([{ segment_count: 1 }]);
    expect((await db.query("select idempotency_key,credit_state from manager_comms_usage_events")).rows).toEqual([
      { idempotency_key: `sms_outbound:${prepared.outbox_id}`, credit_state: "settled" },
    ]);
    expect((await db.query<{ status: string; handled_revision: number; history_snapshot: unknown }>(
      "select status,handled_revision,history_snapshot from prospect_sms_bursts where id=$1",
      [seeded.burstId],
    )).rows[0]).toMatchObject({
      status: "dispatched",
      handled_revision: 7,
      history_snapshot: [{ tool: "confirm_prospect_tour" }],
    });
    expect((await db.query<{ status: string; provider_message_sid: string | null }>(
      "select status,provider_message_sid from sms_outbox where id=$1",
      [prepared.outbox_id],
    )).rows[0]).toMatchObject({ status: "submitted", provider_message_sid: "SM-RECOVERY-FIRST" });

    const retry = await dispatchOwnerSmsOutbox({ workerId: "recovery-worker-retry", outboxId: prepared.outbox_id }, dispatcherDb as never);
    expect(retry).toMatchObject({ ok: true, claimed: 0, submitted: 0, blocked: 0, unknown: 0 });
    expect(dispatcherHarness.send).toHaveBeenCalledTimes(1);
    expect((await db.query<{ segment_count: number }>(
      "select segment_count from sms_segment_usage where usage_date=(now() at time zone 'utc')::date",
    )).rows).toEqual([{ segment_count: 1 }]);
    expect((await db.query("select count(*)::int count from manager_comms_usage_events where idempotency_key=$1", [`sms_outbound:${prepared.outbox_id}`])).rows[0].count).toBe(1);
  });

  it("arbitrates normal and recovery confirmation preparation around one booking", async () => {
    const prepareBooking = async (bookingId: string, seeded: Awaited<ReturnType<typeof seedProspectBooking>>) => {
      const result = (await db.query(
        `select * from prepare_prospect_tour_booking_confirmation(
          $1,$2,$2,null,$3,$4,'Tour confirmed','transactional','manager_conversation',
          $5,'prospect','property-1','America/Los_Angeles',$6,null,1,'queued',now(),null
        )`,
        [bookingId, owner, seeded.phone, seeded.phone, `${owner}:prospect:${seeded.phone}`, `booking-confirmation:${bookingId}`],
      )).rows[0];
      return result;
    };

    const prepareLegacyBurst = async (seeded: Awaited<ReturnType<typeof seedProspectBooking>>) => {
      const result = (await db.query(
        `select * from prepare_prospect_sms_delivery(
          $1,7,'worker-1',$2,$2,null,null,$3,'Tour confirmed','transactional',
          'manager_conversation',$4,'prospect','property-1','America/Los_Angeles',$5,null,1,
          'queued',now(),null,'twilio',null,null,null
        )`,
        [seeded.burstId, owner, seeded.phone, `${owner}:prospect:${seeded.phone}`, `legacy:${seeded.burstId}`],
      )).rows[0];
      return result;
    };

    // Normal worker prepares first. Recovery adopts that exact queued legacy
    // row before either path can submit a provider request.
    const normalFirst = await seedProspectBooking(db, "10");
    expect((await confirmProspect(db, normalFirst)).rows[0].result).toMatchObject({ ok: true });
    const normalBooking = (await db.query<{ id: string }>("select id from prospect_tour_bookings where burst_id=$1", [normalFirst.burstId])).rows[0];
    const legacy = await prepareLegacyBurst(normalFirst);
    expect(legacy).toMatchObject({ prepared: true, deduplicated: false });
    const adopted = await prepareBooking(normalBooking.id, normalFirst);
    expect(adopted).toMatchObject({ outbox_id: legacy.outbox_id, terminal: false, status: "queued" });
    expect((await db.query<{ count: number }>("select count(*)::int count from sms_outbox where prospect_burst_id=$1", [normalFirst.burstId])).rows[0].count).toBe(1);
    expect((await db.query<{ confirmation_outbox_id: string }>("select confirmation_outbox_id from prospect_tour_bookings where id=$1", [normalBooking.id])).rows[0].confirmation_outbox_id).toBe(legacy.outbox_id);

    // Recovery prepares first. A second normal-worker selection adopts the
    // same booking-keyed intent and never creates a burst-only replacement.
    const recoveryFirst = await seedProspectBooking(db, "11");
    expect((await confirmProspect(db, recoveryFirst)).rows[0].result).toMatchObject({ ok: true });
    const recoveryBooking = (await db.query<{ id: string }>("select id from prospect_tour_bookings where burst_id=$1", [recoveryFirst.burstId])).rows[0];
    const first = await prepareBooking(recoveryBooking.id, recoveryFirst);
    const second = await prepareBooking(recoveryBooking.id, recoveryFirst);
    expect(first).toMatchObject({ terminal: false, status: "queued" });
    expect(second).toMatchObject({ outbox_id: first.outbox_id, terminal: false, status: "queued" });
    expect((await db.query<{ count: number }>("select count(*)::int count from sms_outbox where prospect_tour_booking_confirmation_id=$1", [recoveryBooking.id])).rows[0].count).toBe(1);

    // Resume the paused normal worker after recovery created the row. It must
    // attach that same row to the burst and retain candidate history instead
    // of creating or submitting another confirmation.
    const resumed = (await db.query(
      `select * from prepare_prospect_tour_booking_confirmation(
        $1,$2,$2,null,$3,$4,'Tour confirmed','transactional','manager_conversation',
        $5,'prospect','property-1','America/Los_Angeles',$6,null,1,'queued',now(),null,
        $7,7,'worker-1','twilio',null,$8::jsonb,$9::jsonb
      )`,
      [
        recoveryBooking.id, owner, recoveryFirst.phone, recoveryFirst.phone,
        `${owner}:prospect:${recoveryFirst.phone}`, `booking-confirmation:${recoveryBooking.id}`,
        recoveryFirst.burstId, JSON.stringify([{ tool: "confirm_prospect_tour" }]),
        JSON.stringify({ primaryOutput: "Tour confirmed" }),
      ],
    )).rows[0];
    expect(resumed).toMatchObject({ outbox_id: first.outbox_id, terminal: false, status: "queued" });
    expect((await db.query<{ status: string; outbox_id: string; candidate_context: unknown }>(
      "select status,outbox_id,candidate_context from prospect_sms_bursts where id=$1",
      [recoveryFirst.burstId],
    )).rows[0]).toMatchObject({ status: "prepared", outbox_id: first.outbox_id, candidate_context: [{ tool: "confirm_prospect_tour" }] });

    // If recovery already crossed the provider boundary, resuming the worker
    // records handled history but never revives or replaces the accepted row.
    const terminalFirst = await seedProspectBooking(db, "15");
    expect((await confirmProspect(db, terminalFirst)).rows[0].result).toMatchObject({ ok: true });
    const terminalBooking = (await db.query<{ id: string }>("select id from prospect_tour_bookings where burst_id=$1", [terminalFirst.burstId])).rows[0];
    const terminalOutbox = await prepareBooking(terminalBooking.id, terminalFirst);
    await db.query("update sms_outbox set status='submitted',provider_message_sid='RECOVERY-FIRST-SINK' where id=$1", [terminalOutbox.outbox_id]);
    const terminalResume = (await db.query(
      `select * from prepare_prospect_tour_booking_confirmation(
        $1,$2,$2,null,$3,$4,'Tour confirmed','transactional','manager_conversation',
        $5,'prospect','property-1','America/Los_Angeles',$6,null,1,'queued',now(),null,
        $7,7,'worker-1','twilio',null,$8::jsonb,$9::jsonb
      )`,
      [
        terminalBooking.id, owner, terminalFirst.phone, terminalFirst.phone,
        `${owner}:prospect:${terminalFirst.phone}`, `booking-confirmation:${terminalBooking.id}`,
        terminalFirst.burstId, JSON.stringify([{ tool: "confirm_prospect_tour" }]),
        JSON.stringify({ primaryOutput: "Tour confirmed" }),
      ],
    )).rows[0];
    expect(terminalResume).toMatchObject({ outbox_id: terminalOutbox.outbox_id, terminal: true, status: "submitted" });
    expect((await db.query<{ status: string; handled_revision: number; history_snapshot: unknown }>(
      "select status,handled_revision,history_snapshot from prospect_sms_bursts where id=$1",
      [terminalFirst.burstId],
    )).rows[0]).toMatchObject({ status: "dispatched", handled_revision: 7, history_snapshot: [{ tool: "confirm_prospect_tour" }] });
    expect((await db.query<{ count: number }>(
      "select count(*)::int count from sms_outbox where prospect_tour_booking_confirmation_id=$1",
      [terminalBooking.id],
    )).rows[0].count).toBe(1);

    // Two recovery workers racing on the same booking serialize on the
    // schedule advisory lock and converge on one durable outbox row.
    const race = await seedProspectBooking(db, "12");
    expect((await confirmProspect(db, race)).rows[0].result).toMatchObject({ ok: true });
    const raceBooking = (await db.query<{ id: string }>("select id from prospect_tour_bookings where burst_id=$1", [race.burstId])).rows[0];
    const left = await connect();
    const right = await connect();
    try {
      const [leftResult, rightResult] = await Promise.all([
        (async () => (await left.query(
          `select * from prepare_prospect_tour_booking_confirmation($1,$2,$2,null,$3,$4,'Tour confirmed','transactional','manager_conversation',$5,'prospect','property-1','America/Los_Angeles',$6,null,1,'queued',now(),null)`,
          [raceBooking.id, owner, race.phone, race.phone, `${owner}:prospect:${race.phone}`, `race:${raceBooking.id}`],
        )).rows[0])(),
        (async () => (await right.query(
          `select * from prepare_prospect_tour_booking_confirmation($1,$2,$2,null,$3,$4,'Tour confirmed','transactional','manager_conversation',$5,'prospect','property-1','America/Los_Angeles',$6,null,1,'queued',now(),null)`,
          [raceBooking.id, owner, race.phone, race.phone, `${owner}:prospect:${race.phone}`, `race:${raceBooking.id}`],
        )).rows[0])(),
      ]);
      expect(leftResult.outbox_id).toBe(rightResult.outbox_id);
      expect((await db.query<{ count: number }>("select count(*)::int count from sms_outbox where prospect_tour_booking_confirmation_id=$1", [raceBooking.id])).rows[0].count).toBe(1);
    } finally {
      await left.end(); await right.end(); connections.delete(left); connections.delete(right);
    }

    // A pre-correction worker may already have claimed a burst-only row when
    // the tour is cancelled or moved. The generic fence must hand that exact
    // row to the booking fence even after the booking leaves `confirmed`, so
    // no obsolete confirmation can cross the provider boundary.
    for (const lifecycle of ["cancel", "replace"] as const) {
      const staleSeed = await seedProspectBooking(db, lifecycle === "cancel" ? "13" : "14");
      expect((await confirmProspect(db, staleSeed)).rows[0].result).toMatchObject({ ok: true });
      const staleBooking = (await db.query<{ id: string }>(
        "select id from prospect_tour_bookings where burst_id=$1",
        [staleSeed.burstId],
      )).rows[0];
      const staleLegacy = await prepareLegacyBurst(staleSeed);
      const staleAttempt = randomUUID();
      await db.query(
        "update sms_outbox set status='claimed',lease_owner='legacy-worker',lease_expires_at=now()+interval '5 minutes' where id=$1",
        [staleLegacy.outbox_id],
      );
      await db.query(
        "insert into sms_delivery_attempts(id,outbox_id,state) values($1,$2,'submitting')",
        [staleAttempt, staleLegacy.outbox_id],
      );
      const nextEvent = lifecycle === "replace"
        ? { ...staleSeed.plannedEvent, slotKey: `${staleSeed.plannedEvent.slotKey}-moved`, start: "2099-12-20T18:00:00.000Z", end: "2099-12-20T18:30:00.000Z" }
        : staleSeed.plannedEvent;
      expect((await mutate(db, lifecycle, nextEvent)).rows[0].result).toMatchObject({ ok: true });
      expect((await db.query(
        "select begin_sms_outbox_submission($1,'legacy-worker',$2,now(),1500,1500,3,'+12065550999') result",
        [staleLegacy.outbox_id, staleAttempt],
      )).rows[0].result).toBe("booking_required");
      expect((await db.query(
        "select begin_prospect_tour_booking_confirmation_submission($1,$2,'legacy-worker',$3,now()) result",
        [staleBooking.id, staleLegacy.outbox_id, staleAttempt],
      )).rows[0].result).toBe("stale");
      expect((await db.query<{ status: string; provider_message_sid: string | null }>(
        "select status,provider_message_sid from sms_outbox where id=$1",
        [staleLegacy.outbox_id],
      )).rows[0]).toMatchObject({ status: "blocked", provider_message_sid: null });
    }
  });

  it("holds cleanup open until an in-flight Google create is reconciled after cancellation", async () => {
    await db.query("delete from prospect_tour_google_calendar_cleanup");
    await db.query("delete from prospect_tour_google_calendar_create_intents");
    const pendingCreate = event("google-create-race-1", "2099-11-09:20", "2099-11-09T17:00:00.000Z");
    expect((await mutate(db, "append", pendingCreate)).rows[0].result).toMatchObject({ ok: true });

    const intent = (await db.query<{ result: { allowed: boolean; generation: string; googleCalendarEventId: string } }>(
      `select begin_prospect_tour_google_calendar_create($1,$2,$3,$4,'create-worker',120) result`,
      [owner, pendingCreate.id, pendingCreate.start, pendingCreate.end],
    )).rows[0].result;
    expect(intent).toMatchObject({ allowed: true });
    expect(intent.googleCalendarEventId).toMatch(/^[0-9a-f]{64}$/);

    // This is the provider request's in-flight window. Cancellation commits
    // locally while the deterministic remote insert may still succeed.
    expect((await mutate(db, "cancel", pendingCreate)).rows[0].result).toMatchObject({ ok: true });
    expect((await db.query(
      "select * from claim_prospect_tour_google_calendar_cleanup('early-cleanup-worker',120)",
    )).rows).toHaveLength(0);

    // A crashed creator never records its provider result. Only after its
    // bounded deadline can reconciliation own that deterministic remote id.
    await db.query(
      "update prospect_tour_google_calendar_create_intents set provider_deadline_at=now()-interval '1 second',lease_expires_at=now()-interval '1 second' where planned_event_id=$1",
      [pendingCreate.id],
    );
    const claimedIntent = (await db.query(
      "select * from claim_prospect_tour_google_calendar_create_reconciliation('create-recovery-worker',120)",
    )).rows[0];
    expect(claimedIntent).toMatchObject({
      planned_event_id: pendingCreate.id,
      google_calendar_event_id: intent.googleCalendarEventId,
      generation: intent.generation,
    });
    expect((await db.query(
      "select * from claim_prospect_tour_google_calendar_cleanup('still-too-early-worker',120)",
    )).rows).toHaveLength(0);

    // A recovery worker can die after claiming. Its expired reconciling lease
    // must be reclaimable rather than blocking this id and cleanup forever.
    await db.query(
      "update prospect_tour_google_calendar_create_intents set lease_expires_at=now()-interval '1 second' where planned_event_id=$1",
      [pendingCreate.id],
    );
    expect((await db.query(
      "select * from claim_prospect_tour_google_calendar_create_reconciliation('replacement-recovery-worker',120)",
    )).rows[0]).toMatchObject({
      planned_event_id: pendingCreate.id,
      generation: intent.generation,
    });

    expect((await db.query<{ completed: boolean }>(
      "select complete_prospect_tour_google_calendar_create_reconciliation($1,$2,'replacement-recovery-worker','reconciled') completed",
      [pendingCreate.id, intent.generation],
    )).rows[0].completed).toBe(true);
    expect((await db.query(
      "select state from prospect_tour_google_calendar_create_intents where planned_event_id=$1",
      [pendingCreate.id],
    )).rows[0]).toMatchObject({ state: "tombstone" });
    const cleanup = (await db.query(
      "select * from claim_prospect_tour_google_calendar_cleanup('final-cleanup-worker',120)",
    )).rows[0];
    expect(cleanup).toMatchObject({
      planned_event_id: pendingCreate.id,
      google_calendar_event_id: intent.googleCalendarEventId,
    });
    expect((await db.query<{ completed: boolean }>(
      "select complete_prospect_tour_google_calendar_cleanup($1,'final-cleanup-worker') completed",
      [pendingCreate.id],
    )).rows[0].completed).toBe(true);

    // A first post-deadline DELETE may see 404 before the original POST
    // commits. The tombstone remains reclaimable for a later deterministic
    // delete even though the ordinary cleanup row is already terminal.
    await db.query(
      "update prospect_tour_google_calendar_create_intents set provider_deadline_at=now()-interval '1 second' where planned_event_id=$1",
      [pendingCreate.id],
    );
    expect((await db.query(
      "select * from claim_prospect_tour_google_calendar_create_reconciliation('late-create-sweeper',120)",
    )).rows[0]).toMatchObject({
      planned_event_id: pendingCreate.id,
      google_calendar_event_id: intent.googleCalendarEventId,
    });
  });

  it("lets recovery persist a rescheduled window without invalidating its lease", async () => {
    await db.query("delete from prospect_tour_google_calendar_create_intents");
    const initial = event("google-reschedule-recovery-1", "2099-11-20:20", "2099-11-20T17:00:00.000Z");
    expect((await mutate(db, "append", initial)).rows[0].result).toMatchObject({ ok: true });
    const intent = (await db.query<{ result: { generation: string; googleCalendarEventId: string } }>(
      "select begin_prospect_tour_google_calendar_create($1,$2,$3,$4,'original-create',120) result",
      [owner, initial.id, initial.start, initial.end],
    )).rows[0].result;
    const moved = { ...initial, slotKey: "2099-11-21:20", start: "2099-11-21T17:00:00.000Z", end: "2099-11-21T17:30:00.000Z" };
    expect((await mutate(db, "replace", moved)).rows[0].result).toMatchObject({ ok: true });
    await db.query(
      "update prospect_tour_google_calendar_create_intents set provider_deadline_at=now()-interval '1 second' where planned_event_id=$1",
      [initial.id],
    );
    expect((await db.query(
      "select * from claim_prospect_tour_google_calendar_create_reconciliation('reschedule-recovery',120)",
    )).rows[0]).toMatchObject({ planned_event_id: initial.id, generation: intent.generation });

    expect((await db.query(
      "select persist_confirmed_tour_google_calendar_id($1,$2,$3,$4) result",
      [initial.id, intent.googleCalendarEventId, moved.start, moved.end],
    )).rows[0].result).toMatchObject({ ok: true });
    expect((await db.query(
      "select state,lease_owner from prospect_tour_google_calendar_create_intents where planned_event_id=$1",
      [initial.id],
    )).rows[0]).toMatchObject({ state: "reconciling", lease_owner: "reschedule-recovery" });
    expect((await db.query<{ completed: boolean }>(
      "select complete_prospect_tour_google_calendar_create_reconciliation($1,$2,'reschedule-recovery','settled') completed",
      [initial.id, intent.generation],
    )).rows[0].completed).toBe(true);

    const secondIntent = (await db.query<{ result: { generation: string } }>(
      "select begin_prospect_tour_google_calendar_create($1,$2,$3,$4,'second-create',120) result",
      [owner, initial.id, moved.start, moved.end],
    )).rows[0].result;
    await db.query(
      "update prospect_tour_google_calendar_create_intents set provider_deadline_at=now()-interval '1 second' where planned_event_id=$1",
      [initial.id],
    );
    expect((await db.query(
      "select * from claim_prospect_tour_google_calendar_create_reconciliation('second-recovery',120)",
    )).rows).toHaveLength(1);
    const movedAgain = { ...moved, slotKey: "2099-11-22:20", start: "2099-11-22T17:00:00.000Z", end: "2099-11-22T17:30:00.000Z" };
    expect((await mutate(db, "replace", movedAgain)).rows[0].result).toMatchObject({ ok: true });
    expect((await db.query<{ completed: boolean }>(
      "select complete_prospect_tour_google_calendar_create_reconciliation($1,$2,'second-recovery','settled') completed",
      [initial.id, secondIntent.generation],
    )).rows[0].completed).toBe(false);
    expect((await db.query(
      "select state from prospect_tour_google_calendar_create_intents where planned_event_id=$1",
      [initial.id],
    )).rows[0]).toMatchObject({ state: "reconcile_current" });
  });

  it("keeps a successful stale create reclaimable until the current window is durably reconciled", async () => {
    await db.query("delete from prospect_tour_google_calendar_create_intents");
    const initial = event("google-stale-create-current-recovery-1", "2099-11-23:20", "2099-11-23T17:00:00.000Z");
    expect((await mutate(db, "append", initial)).rows[0].result).toMatchObject({ ok: true });
    const intent = (await db.query<{ result: { generation: string; googleCalendarEventId: string } }>(
      "select begin_prospect_tour_google_calendar_create($1,$2,$3,$4,'original-create',120) result",
      [owner, initial.id, initial.start, initial.end],
    )).rows[0].result;
    const moved = { ...initial, slotKey: "2099-11-24:20", start: "2099-11-24T17:00:00.000Z", end: "2099-11-24T17:30:00.000Z" };
    expect((await mutate(db, "replace", moved)).rows[0].result).toMatchObject({ ok: true });

    // The stale provider result is known, but a worker crash before the B
    // follow-up must leave B's reconciliation visible to the sweeper.
    expect((await db.query(
      "select settle_prospect_tour_google_calendar_create($1,$2,'cleanup_ready') result",
      [initial.id, intent.generation],
    )).rows[0].result).toMatchObject({ ok: true, state: "reconcile_current" });
    expect((await db.query(
      "select * from claim_prospect_tour_google_calendar_cleanup('stale-cleanup-worker',120)",
    )).rows).toHaveLength(0);
    expect((await db.query(
      "select * from claim_prospect_tour_google_calendar_create_reconciliation('current-window-worker',120)",
    )).rows[0]).toMatchObject({ planned_event_id: initial.id, generation: intent.generation });

    // A claimed worker that dies is reclaimable. Its successor can settle only
    // the exact B window, so a second move cannot be silently marked complete.
    await db.query(
      "update prospect_tour_google_calendar_create_intents set state='reconcile_current',lease_owner=null,lease_expires_at=null where planned_event_id=$1",
      [initial.id],
    );
    expect((await db.query<{ settled: boolean }>(
      "select settle_prospect_tour_google_calendar_current_reconciliation($1,$2,$3,$4) settled",
      [initial.id, intent.generation, moved.start, moved.end],
    )).rows[0].settled).toBe(true);
    expect((await db.query(
      "select state,expected_start,expected_end from prospect_tour_google_calendar_create_intents where planned_event_id=$1",
      [initial.id],
    )).rows[0]).toMatchObject({ state: "settled", expected_start: new Date(moved.start), expected_end: new Date(moved.end) });
  });

  it("serializes expired recovery writers and converges the provider sink to the latest window after process death", async () => {
    const { recoverExpiredProspectTourGoogleCalendarCreates } = await vi.importActual<
      typeof import("@/lib/prospect-tour-booking-recovery.server")
    >("@/lib/prospect-tour-booking-recovery.server");
    const { GoogleCalendarWriteSupersededError } = await vi.importActual<
      typeof import("@/lib/google-calendar/api.server")
    >("@/lib/google-calendar/api.server");
    googleProviderHarness.connection.mockResolvedValue({ connected: true, syncEnabled: true });
    googleProviderHarness.create.mockReset();
    googleProviderHarness.update.mockReset();

    await db.query("delete from prospect_tour_google_calendar_create_intents");
    const initial = event("google-provider-ordering-1", "2099-11-25:20", "2099-11-25T17:00:00.000Z");
    const movedB = { ...initial, slotKey: "2099-11-26:20", start: "2099-11-26T17:00:00.000Z", end: "2099-11-26T17:30:00.000Z" };
    const movedC = { ...initial, slotKey: "2099-11-27:20", start: "2099-11-27T17:00:00.000Z", end: "2099-11-27T17:30:00.000Z" };
    expect((await mutate(db, "append", initial)).rows[0].result).toMatchObject({ ok: true });
    const intent = (await db.query<{ result: { generation: string; googleCalendarEventId: string } }>(
      "select begin_prospect_tour_google_calendar_create($1,$2,$3,$4,'original-create',120) result",
      [owner, initial.id, initial.start, initial.end],
    )).rows[0].result;
    expect((await mutate(db, "replace", movedB)).rows[0].result).toMatchObject({ ok: true });
    expect((await db.query(
      "select settle_prospect_tour_google_calendar_create($1,$2,'cleanup_ready') result",
      [initial.id, intent.generation],
    )).rows[0].result).toMatchObject({ ok: true, state: "reconcile_current" });

    let releasePatchB!: () => void;
    const patchB = new Promise<void>((resolve) => {
      releasePatchB = resolve;
    });
    let providerVersion = 1;
    let providerSink = { start: initial.start, end: initial.end };
    googleProviderHarness.update.mockImplementation(async (
      _db,
      _manager,
      _id,
      input: { start: string; end: string },
      conditional?: { validateCurrent?: () => Promise<boolean> },
    ) => {
      // Model Google's GET ETag -> durable revalidation -> PATCH If-Match
      // protocol. Both writers can read v1, but only one can commit it.
      const readVersion = providerVersion;
      if (!conditional?.validateCurrent || !await conditional.validateCurrent()) {
        throw new GoogleCalendarWriteSupersededError();
      }
      if (input.start === movedB.start) await patchB;
      if (readVersion !== providerVersion) throw new GoogleCalendarWriteSupersededError();
      providerSink = { start: input.start, end: input.end };
      providerVersion += 1;
      return intent.googleCalendarEventId;
    });

    const abandonedWorker = recoverExpiredProspectTourGoogleCalendarCreates(googleRecoveryDb(db) as never, 1);
    await vi.waitFor(() => expect(googleProviderHarness.update).toHaveBeenCalledTimes(1));
    expect((await mutate(db, "replace", movedC)).rows[0].result).toMatchObject({ ok: true });

    // Simulate a worker whose bounded lease and deadline expired while PATCH B
    // is still delayed at the provider. The successor resolves C from the real
    // database and conditionally writes it first.
    await db.query(
      "update prospect_tour_google_calendar_create_intents set provider_deadline_at=now()-interval '1 second',lease_expires_at=now()-interval '1 second' where planned_event_id=$1",
      [initial.id],
    );
    await expect(recoverExpiredProspectTourGoogleCalendarCreates(googleRecoveryDb(db) as never, 1)).resolves.toEqual({
      scanned: 1,
      reconciled: 1,
      failed: 0,
    });
    expect(providerSink).toEqual({ start: movedC.start, end: movedC.end });
    expect(providerVersion).toBe(2);

    // The old PATCH B resumes only after C is terminal. Its stale ETag gets
    // 412 semantics, so it cannot overwrite C and is never locally persisted.
    releasePatchB();
    await expect(abandonedWorker).resolves.toEqual({
      scanned: 1,
      reconciled: 0,
      failed: 1,
    });
    expect(providerSink).toEqual({ start: movedC.start, end: movedC.end });
    expect(providerVersion).toBe(2);

    // A still-slower stale worker that only finishes GET after C also fails the
    // post-GET durable check even though it observed C's fresh provider ETag.
    expect((await db.query<{ valid: boolean }>(
      "select validate_prospect_tour_google_calendar_write($1,$2,$3,$4,'expired-b-worker') valid",
      [initial.id, intent.generation, movedB.start, movedB.end],
    )).rows[0].valid).toBe(false);
    const stored = (await db.query<{ row_data: { payload: Array<Record<string, unknown>> } }>(
      "select row_data from portal_schedule_records where id='axis_admin_planned_events_v1'",
    )).rows[0].row_data.payload.find((row) => row.id === initial.id);
    expect(stored).toMatchObject({ start: movedC.start, end: movedC.end, googleCalendarEventId: intent.googleCalendarEventId });
    expect((await db.query(
      "select state,expected_start,expected_end from prospect_tour_google_calendar_create_intents where planned_event_id=$1",
      [initial.id],
    )).rows[0]).toMatchObject({ state: "settled", expected_start: new Date(movedC.start), expected_end: new Date(movedC.end) });
  });

  it("keeps Google cleanup durable across cancel/delete retries and preserves a moved event", async () => {
    // Earlier lifecycle tests intentionally cancel tours and therefore leave
    // valid cleanup work behind in this shared disposable database. Isolate
    // this claim-order scenario from those fixtures.
    await db.query("delete from prospect_tour_google_calendar_cleanup");
    // No Google id was persisted locally: this models a crash after the
    // remote insert and before metadata persistence. The trigger must derive
    // the deterministic id and retain cleanup after cancellation.
    const cancelled = event("cleanup-cancel-1", "2099-11-10:20", "2099-11-10T17:00:00.000Z");
    expect((await mutate(db, "append", cancelled)).rows[0].result).toMatchObject({ ok: true });
    expect((await mutate(db, "cancel", cancelled)).rows[0].result).toMatchObject({ ok: true });

    const pendingAfterCancel = (await db.query<{ status: string; google_calendar_event_id: string; attempts: number }>(
      "select status,google_calendar_event_id,attempts from prospect_tour_google_calendar_cleanup where planned_event_id=$1",
      [cancelled.id],
    )).rows[0];
    expect(pendingAfterCancel).toMatchObject({ status: "pending", attempts: 0 });
    expect(pendingAfterCancel.google_calendar_event_id).toMatch(/^[0-9a-f]{64}$/);

    // Re-enqueueing the same deterministic remote identity is idempotent and
    // resets a failed attempt to pending without creating a second obligation.
    await db.query("select enqueue_prospect_tour_google_calendar_cleanup($1,$2,$3)", [owner, cancelled.id, pendingAfterCancel.google_calendar_event_id]);
    const firstClaim = (await db.query(
      "select * from claim_prospect_tour_google_calendar_cleanup('cleanup-worker-1',120)",
    )).rows[0];
    expect(firstClaim).toMatchObject({ planned_event_id: cancelled.id, google_calendar_event_id: pendingAfterCancel.google_calendar_event_id });
    expect((await db.query<{ attempts: number; status: string }>(
      "select attempts,status from prospect_tour_google_calendar_cleanup where planned_event_id=$1", [cancelled.id],
    )).rows[0]).toMatchObject({ attempts: 1, status: "running" });

    // A provider delete failure is retryable, not terminal and not forgotten.
    await db.query(
      "update prospect_tour_google_calendar_cleanup set status='pending',last_error='provider timeout',lease_owner=null,lease_expires_at=null where planned_event_id=$1",
      [cancelled.id],
    );
    const secondClaim = (await db.query(
      "select * from claim_prospect_tour_google_calendar_cleanup('cleanup-worker-2',120)",
    )).rows[0];
    expect(secondClaim).toMatchObject({ planned_event_id: cancelled.id, google_calendar_event_id: pendingAfterCancel.google_calendar_event_id });
    expect((await db.query<{ attempts: number }>(
      "select attempts from prospect_tour_google_calendar_cleanup where planned_event_id=$1", [cancelled.id],
    )).rows[0].attempts).toBe(2);
    await db.query(
      "update prospect_tour_google_calendar_cleanup set status='completed',last_error=null,completed_at=now(),lease_owner=null,lease_expires_at=null where planned_event_id=$1",
      [cancelled.id],
    );
    expect((await db.query("select * from claim_prospect_tour_google_calendar_cleanup('cleanup-worker-3',120)")).rows).toHaveLength(0);
    expect((await db.query<{ count: number }>(
      "select count(*)::int count from prospect_tour_google_calendar_cleanup where planned_event_id=$1", [cancelled.id],
    )).rows[0].count).toBe(1);

    const deleted = { ...event("cleanup-delete-1", "2099-11-11:20", "2099-11-11T17:00:00.000Z"), googleCalendarEventId: "google-cleanup-delete" };
    expect((await mutate(db, "append", deleted)).rows[0].result).toMatchObject({ ok: true });
    expect((await mutate(db, "delete", deleted)).rows[0].result).toMatchObject({ ok: true });
    expect((await db.query<{ status: string; google_calendar_event_id: string }>(
      "select status,google_calendar_event_id from prospect_tour_google_calendar_cleanup where planned_event_id=$1", [deleted.id],
    )).rows[0]).toMatchObject({ status: "pending", google_calendar_event_id: deleted.googleCalendarEventId });

    const moved = { ...event("cleanup-move-1", "2099-11-12:20", "2099-11-12T17:00:00.000Z"), googleCalendarEventId: "google-cleanup-move" };
    expect((await mutate(db, "append", moved)).rows[0].result).toMatchObject({ ok: true });
    const movedAgain = { ...moved, slotKey: "2099-11-13:20", start: "2099-11-13T17:00:00.000Z", end: "2099-11-13T17:30:00.000Z" };
    expect((await mutate(db, "replace", movedAgain)).rows[0].result).toMatchObject({ ok: true });
    expect((await db.query<{ count: number }>(
      "select count(*)::int count from prospect_tour_google_calendar_cleanup where planned_event_id=$1", [moved.id],
    )).rows[0].count).toBe(0);
    const movedRow = (await db.query<{ payload: Record<string, unknown>[] }>(
      "select row_data->'payload' payload from portal_schedule_records where id='axis_admin_planned_events_v1'",
    )).rows[0].payload.find((row) => row.id === moved.id);
    expect(movedRow).toMatchObject({ slotKey: movedAgain.slotKey, googleCalendarEventId: moved.googleCalendarEventId });
  });
});
