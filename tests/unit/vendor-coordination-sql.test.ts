import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const manager = "11111111-1111-4111-8111-111111111111";
const vendor = "22222222-2222-4222-8222-222222222222";
const resident = "44444444-4444-4444-8444-444444444444";
const otherManager = "33333333-3333-4333-8333-333333333333";
const migration = readFileSync(join(process.cwd(), "supabase/migrations/20261004120000_vendor_coordination.sql"), "utf8");
const calendarFenceMigration = readFileSync(join(process.cwd(), "supabase/migrations/20261004121000_vendor_coordination_calendar_fence.sql"), "utf8");
let db: PGlite;

async function action(input: Record<string, unknown>) {
  const result = await db.query<{ proposal: Record<string, unknown> }>(
    "select public.vendor_coordination_action($1::jsonb) as proposal", [JSON.stringify(input)],
  );
  return result.rows[0].proposal;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key);
    create table public.profiles(id uuid primary key references auth.users(id), phone text, phone_verified_at timestamptz, email text);
    create table public.manager_vendor_records(id text primary key, manager_user_id uuid not null references auth.users(id), vendor_user_id uuid references auth.users(id), row_data jsonb not null);
    create table public.portal_work_order_records(id text primary key, manager_user_id uuid references auth.users(id), vendor_user_id uuid references auth.users(id), resident_email text, resident_user_id uuid references auth.users(id), property_id text, row_data jsonb not null, updated_at timestamptz default now());
    create table public.work_order_vendor_offers(id uuid primary key default gen_random_uuid(), work_order_id text references public.portal_work_order_records(id), manager_user_id uuid references auth.users(id), vendor_directory_id text references public.manager_vendor_records(id), status text not null, expires_at timestamptz);
    create table public.vendor_availability_rules(id uuid primary key default gen_random_uuid(), vendor_user_id uuid not null references auth.users(id), kind text not null, weekday smallint, specific_date date, start_minute smallint not null, end_minute smallint not null, note text);
    create table public.work_order_bids(id uuid primary key default gen_random_uuid(), work_order_id text not null references public.portal_work_order_records(id), manager_user_id uuid not null references auth.users(id), vendor_user_id uuid references auth.users(id), vendor_directory_id text references public.manager_vendor_records(id), amount_cents integer, materials_cents integer default 0, proposed_time timestamptz, bid_submitted_at timestamptz, note text, status text not null default 'submitted', quote_mode text default 'upfront', updated_at timestamptz default now(), unique(work_order_id,vendor_user_id));
    create table public.action_events(id uuid primary key default gen_random_uuid(), event_key text not null unique, domain text not null, event_type text not null, category text not null, manager_user_id uuid not null references auth.users(id), entity_id text not null, sender_user_id uuid references auth.users(id), sender_email text, occurred_at timestamptz not null, payload jsonb not null, processed_at timestamptz);
    create table public.action_event_deliveries(id uuid primary key default gen_random_uuid(), event_id uuid not null references public.action_events(id), audience text not null, recipient_key text not null, recipient_user_id uuid references auth.users(id), recipient_email text, status text not null, next_attempt_at timestamptz, rendered jsonb not null);
  `);
  await db.exec(migration);
  await db.exec(calendarFenceMigration);
  await db.exec(readFileSync(join(process.cwd(), "supabase/migrations/20261104115000_vendor_coordination_current_main_compat.sql"), "utf8"));
  await db.query("insert into auth.users(id) values ($1),($2),($3),($4)", [manager, vendor, otherManager, resident]);
  await db.query("insert into public.profiles(id,phone,phone_verified_at,email) values ($1,'+13175550001',now(),'manager@example.com'),($2,'+13175550002',now(),'vendor@example.com'),($3,null,null,'othermanager@example.com')", [manager, vendor, otherManager]);
  await db.query("insert into public.manager_vendor_records(id,manager_user_id,vendor_user_id,row_data) values ('dir-a',$1,$2,$3::jsonb),('dir-b',$4,null,$5::jsonb),('dir-c',$1,$2,$3::jsonb)",
    [manager, vendor, JSON.stringify({ name: "Vendor A", email: "vendor@example.com" }), otherManager, JSON.stringify({ name: "Vendor B", email: "vendorb@example.com" })]);
  await db.query("insert into public.portal_work_order_records(id,manager_user_id,resident_email,row_data) values ('job-a',$1,'resident@example.com','{}'),('job-b',$2,'residentb@example.com','{\"vendorId\":\"dir-b\"}'),('job-c',$1,'residentc@example.com','{}')", [manager, otherManager]);
  await db.query("update public.portal_work_order_records set resident_user_id=$1", [resident]);
  await db.query("insert into public.work_order_vendor_offers(work_order_id,manager_user_id,vendor_directory_id,status,expires_at) values ('job-a',$1,'dir-a','sent',now()+interval '30 days'),('job-b',$2,'dir-b','sent',now()+interval '30 days'),('job-c',$1,'dir-c','sent',now()+interval '30 days')", [manager, otherManager]);
  await db.query("insert into public.vendor_coordination_phone_bindings(manager_user_id,vendor_directory_id,vendor_user_id,phone_e164) values ($1,'dir-a',$2,'+13175550002'),($3,'dir-b',null,'+13175550002'),($1,'dir-c',$2,'+13175550003')", [manager, vendor, otherManager]);
}, 30_000);
afterAll(async () => { await db?.close(); });

describe("vendor coordination SQL transaction", () => {
  it("migrates with service-only RPC grants and blocks direct client writes", async () => {
    await db.exec(migration);
    await db.exec(calendarFenceMigration);
  await db.exec(readFileSync(join(process.cwd(), "supabase/migrations/20261104115000_vendor_coordination_current_main_compat.sql"), "utf8"));
    const grants = await db.query<{ grantee: string }>(`select grantee from information_schema.role_routine_grants where routine_name='vendor_coordination_action' and privilege_type='EXECUTE'`);
    expect(grants.rows.map((row) => row.grantee)).not.toContain("authenticated");
  });

  it("requires owner, active offer, exact terms, and both replies before repair booking", async () => {
    await expect(action({ kind: "enroll", work_order_id: "job-a", vendor_directory_id: "dir-a", visit_type: "repair", manager_user_id: manager, actor_user_id: otherManager })).rejects.toThrow();
    let proposal = await action({ kind: "enroll", work_order_id: "job-a", vendor_directory_id: "dir-a", visit_type: "repair", manager_user_id: manager, actor_user_id: manager });
    const id = proposal.id as string;
    const next = (kind: string, extras: Record<string, unknown> = {}) => ({ kind, proposal_id: id, expected_version: proposal.version, ...extras });
    await expect(action(next("approve_manager", { actor_user_id: manager }))).rejects.toThrow();
    proposal = await action(next("revise_quote", { actor_user_id: vendor, vendor_directory_id: "dir-a", duration_minutes: 60,
      quote: { laborCents: 12000, materialsCents: 3000, consultationFeeCents: 0, scope: "Repair leak", exclusions: "" } }));
    const start = new Date(Date.now() + 7 * 86400_000).toISOString();
    const end = new Date(Date.parse(start) + 2 * 3600_000).toISOString();
    proposal = await action(next("submit_vendor_windows", { actor_user_id: vendor, vendor_directory_id: "dir-a", windows: [{ startIso: start, endIso: end }] }));
    await expect(action(next("submit_resident_windows", { actor_user_id: otherManager, resident_email: "resident@example.com", windows: [{ startIso: start, endIso: end }] }))).rejects.toThrow(/resident identity mismatch/);
    proposal = await action(next("submit_resident_windows", { actor_user_id: resident, windows: [{ startIso: start, endIso: end }] }));
    proposal = await action(next("select_time", { actor_user_id: manager, selected_start_iso: start }));
    proposal = await action(next("confirm_vendor", { actor_user_id: vendor, vendor_directory_id: "dir-a" }));
    await expect(action(next("approve_manager", { actor_user_id: manager }))).rejects.toThrow();
    proposal = await action(next("confirm_resident", { actor_user_id: resident }));
    expect(proposal.status).toBe("ready");
    await expect(action({ kind: "approve_manager", proposal_id: id, expected_version: 1, actor_user_id: manager })).rejects.toThrow();
    proposal = await action(next("approve_manager", { actor_user_id: manager }));
    expect(proposal.status).toBe("approved");
    const bids = await db.query<{ amount_cents: number; status: string }>("select amount_cents,status from public.work_order_bids where work_order_id='job-a'");
    expect(bids.rows).toEqual([{ amount_cents: 12000, status: "accepted" }]);
    const booked = await db.query<{ count: string }>("select count(*)::text as count from public.vendor_coordination_reservations where status='active'");
    expect(booked.rows[0].count).toBe("1");
    const deliveries = await db.query<{ count: string }>("select count(*)::text as count from public.action_event_deliveries d join public.action_events e on e.id=d.event_id where e.event_type='scheduled'");
    expect(deliveries.rows[0].count).toBe("3");
    const event = await db.query<{ sender_email: string; property_id: string | null; scope: string; sms_text: string }>(`select e.sender_email,
      e.payload->>'propertyId' as property_id, e.payload->>'scope' as scope,
      d.rendered->>'smsText' as sms_text from public.action_events e
      join public.action_event_deliveries d on d.event_id=e.id and d.audience='resident'
      where e.event_type='scheduled'`);
    expect(event.rows[0]).toMatchObject({ sender_email: "manager@example.com", scope: "Repair leak" });
    expect(event.rows[0].sms_text).toContain("booked");
    await expect(db.query("update public.work_order_bids set status='submitted' where work_order_id='job-a'")).rejects.toThrow();
    await expect(db.query("update public.portal_work_order_records set row_data=jsonb_set(row_data,'{scheduledAtIso}','\"2026-12-01T00:00:00Z\"') where id='job-a'")).rejects.toThrow();
  }, 30_000);

  it("allows one message to supply distinct quote and window facts, while rejecting changed retries", async () => {
    let proposal = await action({ kind: "enroll", work_order_id: "job-b", vendor_directory_id: "dir-b", visit_type: "consultation", manager_user_id: otherManager, actor_user_id: otherManager });
    const id = proposal.id as string;
    const next = (kind: string, extras: Record<string, unknown> = {}) => ({ kind, proposal_id: id, expected_version: proposal.version, ...extras });
    const vendorIdentity = { vendor_directory_id: "dir-b", verified_phone_e164: "+13175550002", source_message_id: "SM-shared" };
    const quote = { laborCents: 0, materialsCents: 0, consultationFeeCents: 5000, scope: "Inspect", exclusions: "" };
    await expect(action(next("revise_quote", { ...vendorIdentity, quote }))).rejects.toThrow(/invalid coordination quote/);
    proposal = await action(next("revise_quote", { ...vendorIdentity, duration_minutes: 60, quote }));
    const start = new Date(Date.now() + 21 * 86400_000).toISOString();
    const end = new Date(Date.parse(start) + 2 * 3600_000).toISOString();
    await expect(action(next("submit_vendor_windows", { ...vendorIdentity, windows: null }))).rejects.toThrow(/invalid windows/);
    proposal = await action(next("submit_vendor_windows", { ...vendorIdentity, windows: [{ startIso: start, endIso: end }] }));
    expect(proposal.version).toBe(3);
    const sameQuote = { kind: "revise_quote", proposal_id: id, expected_version: 1, ...vendorIdentity, duration_minutes: 60, quote };
    const retried = await action(sameQuote);
    expect(retried.version).toBe(3);
    await expect(action({ ...sameQuote, quote: { ...quote, consultationFeeCents: 9000 } })).rejects.toThrow(/changed input/);
    proposal = await action(next("request_revision", { actor_user_id: otherManager, reason: "Please clarify the inspection scope" }));
    expect(proposal.vendor_confirmed_revision).toBeNull();
    expect(proposal.quote_revision).toBe(3);
    proposal = await action(next("take_over", { actor_user_id: otherManager, reason: "Manager will coordinate directly" }));
    expect(proposal.manager_takeover).toBe(true);
    await expect(action(next("submit_vendor_windows", { ...vendorIdentity, source_message_id: "SM-new", windows: [{ startIso: start, endIso: end }] }))).rejects.toThrow(/taken over SMS/);
  }, 30_000);

  it("catches an old directory-only reservation after signup and a changed phone", async () => {
    const start = new Date(Date.now() + 14 * 86400_000).toISOString();
    const end = new Date(Date.parse(start) + 2 * 3600_000).toISOString();
    const old = await db.query<{ id: string }>(`insert into public.vendor_coordination_proposals
      (work_order_id,manager_user_id,vendor_directory_id,visit_type,status,version)
      values ('job-b',$1,'dir-b','repair','approved',1) returning id`, [otherManager]);
    await db.query(`insert into public.vendor_coordination_reservations
      (proposal_id,work_order_id,manager_user_id,vendor_directory_id,vendor_phone_e164,starts_at,ends_at)
      values ($1,'job-b',$2,'dir-b','+13175550002',$3::timestamptz,$4::timestamptz)`,
      [old.rows[0].id, otherManager, start, end]);
    await db.query("insert into public.work_order_bids(work_order_id,manager_user_id,vendor_directory_id,amount_cents,status) values ('job-b',$1,'dir-b',9000,'accepted')", [otherManager]);
    await db.query("update public.manager_vendor_records set vendor_user_id=$1 where id='dir-b'", [vendor]);
    const linkedReservation = await db.query<{ vendor_user_id: string }>("select vendor_user_id::text from public.vendor_coordination_reservations where proposal_id=$1", [old.rows[0].id]);
    expect(linkedReservation.rows[0].vendor_user_id).toBe(vendor);
    const linkedBid = await db.query<{ vendor_user_id: string }>("select vendor_user_id::text from public.work_order_bids where work_order_id='job-b'");
    expect(linkedBid.rows[0].vendor_user_id).toBe(vendor);
    const linkedWork = await db.query<{ vendor_user_id: string }>("select vendor_user_id::text from public.portal_work_order_records where id='job-b'");
    expect(linkedWork.rows[0].vendor_user_id).toBe(vendor);

    let proposal = await action({ kind: "enroll", work_order_id: "job-c", vendor_directory_id: "dir-c", visit_type: "repair", manager_user_id: manager, actor_user_id: manager });
    const id = proposal.id as string;
    const next = (kind: string, extras: Record<string, unknown> = {}) => ({ kind, proposal_id: id, expected_version: proposal.version, ...extras });
    proposal = await action(next("revise_quote", { actor_user_id: vendor, vendor_directory_id: "dir-c", duration_minutes: 60,
      quote: { laborCents: 7000, materialsCents: 1000, consultationFeeCents: 0, scope: "Repair", exclusions: "" } }));
    proposal = await action(next("submit_vendor_windows", { actor_user_id: vendor, vendor_directory_id: "dir-c", windows: [{ startIso: start, endIso: end }] }));
    proposal = await action(next("submit_resident_windows", { actor_user_id: resident, windows: [{ startIso: start, endIso: end }] }));
    proposal = await action(next("select_time", { actor_user_id: manager, selected_start_iso: start }));
    proposal = await action(next("confirm_vendor", { actor_user_id: vendor, vendor_directory_id: "dir-c" }));
    proposal = await action(next("confirm_resident", { actor_user_id: resident }));
    await expect(action(next("approve_manager", { actor_user_id: manager }))).rejects.toThrow(/conflicting reservation/);
    const bids = await db.query<{ count: string }>("select count(*)::text as count from public.work_order_bids where work_order_id='job-c'");
    expect(bids.rows[0].count).toBe("0");
  }, 30_000);

  it("fences booked visits against later calendar blocks and calendar blocks against later reservations", async () => {
    const booked = await db.query<{ local_date: string; local_minute: number }>(`select
      (starts_at at time zone 'America/Los_Angeles')::date::text as local_date,
      (extract(hour from starts_at at time zone 'America/Los_Angeles')::integer * 60 +
       extract(minute from starts_at at time zone 'America/Los_Angeles')::integer) as local_minute
      from public.vendor_coordination_reservations where work_order_id='job-a'`);
    const { local_date, local_minute } = booked.rows[0];
    await expect(db.query(`insert into public.vendor_availability_rules
      (vendor_user_id,kind,specific_date,start_minute,end_minute)
      values ($1,'block',$2::date,$3,$4)`, [vendor, local_date, local_minute, local_minute + 30]))
      .rejects.toThrow(/conflicts with booked visit/);
    await db.query(`insert into public.vendor_availability_rules
      (vendor_user_id,kind,specific_date,start_minute,end_minute)
      values ($1,'event',((now()+interval '30 days') at time zone 'America/Los_Angeles')::date,720,780)`, [vendor]);
    await db.query("insert into public.portal_work_order_records(id,manager_user_id,resident_email,row_data) values ('job-d',$1,'residentd@example.com','{}')", [manager]);
    const proposal = await db.query<{ id: string }>(`insert into public.vendor_coordination_proposals
      (work_order_id,manager_user_id,vendor_directory_id,vendor_user_id,visit_type,status)
      values('job-d',$1,'dir-a',$2,'repair','approved') returning id`, [manager, vendor]);
    await expect(db.query(`insert into public.vendor_coordination_reservations
      (proposal_id,work_order_id,manager_user_id,vendor_directory_id,vendor_user_id,vendor_phone_e164,starts_at,ends_at)
      values($1,'job-d',$2,'dir-a',$3,'+13175550002',
        (((now()+interval '30 days') at time zone 'America/Los_Angeles')::date + time '12:30') at time zone 'America/Los_Angeles',
        (((now()+interval '30 days') at time zone 'America/Los_Angeles')::date + time '13:30') at time zone 'America/Los_Angeles')`,
      [proposal.rows[0].id, manager, vendor])).rejects.toThrow(/block conflicts with reservation/);
  }, 30_000);
});
