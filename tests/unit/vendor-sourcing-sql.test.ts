import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const managerA = "11111111-1111-4111-8111-111111111111";
const managerB = "22222222-2222-4222-8222-222222222222";
const vendorA = "33333333-3333-4333-8333-333333333333";
const coordinationMigration = readFileSync(join(process.cwd(), "supabase/migrations/20261004120000_vendor_coordination.sql"), "utf8");
const sourcingMigration = readFileSync(join(process.cwd(), "supabase/migrations/20261016120000_vendor_sourcing.sql"), "utf8");
let db: PGlite;

async function insertManager(id: string, email: string) {
  await db.query("insert into auth.users(id) values ($1) on conflict do nothing", [id]);
  await db.query("insert into public.profiles(id,email) values ($1,$2) on conflict (id) do update set email=excluded.email", [id, email]);
}

async function addWorkOrder(id: string, managerId: string) {
  await db.query(
    "insert into public.portal_work_order_records(id,manager_user_id,resident_email,property_id,row_data,resident_user_id) values ($1,$2,$3,$4,$5::jsonb,$2)",
    [id, managerId, `${id}@resident.example`, "property-1", JSON.stringify({ bucket: "open", title: "Leaky sink", category: "plumbing" })],
  );
  const result = await db.query<{ id: string; state: string; stage: number }>(
    "select id,state,stage from public.vendor_sourcing_jobs where work_order_id=$1",
    [id],
  );
  return result.rows[0];
}

async function claim(workOrderId: string) {
  const result = await db.query<{ id: string; lease_token: string; attempts: number }>(
    "select id,lease_token,attempts from public.claim_vendor_sourcing(3,$1)",
    [workOrderId],
  );
  return result.rows[0] ?? null;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users(id uuid primary key);
    create table public.agent_sessions(id uuid primary key default gen_random_uuid(), user_id uuid not null, kind text, vendor_directory_id text);
    create table public.profiles(id uuid primary key references auth.users(id), phone text, phone_verified_at timestamptz, email text);
    create table public.manager_automation_settings(manager_user_id uuid primary key references auth.users(id), vendor_dispatch jsonb not null default '{}'::jsonb, row_data jsonb not null default '{}'::jsonb, updated_at timestamptz default now());
    create table public.manager_vendor_records(id text primary key, manager_user_id uuid not null references auth.users(id), vendor_user_id uuid references auth.users(id), row_data jsonb not null);
    create table public.portal_work_order_records(id text primary key, manager_user_id uuid references auth.users(id), vendor_user_id uuid references auth.users(id), resident_email text, resident_user_id uuid references auth.users(id), property_id text, row_data jsonb not null, updated_at timestamptz default now());
    create table public.work_order_vendor_offers(id uuid primary key default gen_random_uuid(), work_order_id text not null references public.portal_work_order_records(id), manager_user_id uuid not null references auth.users(id), vendor_directory_id text not null references public.manager_vendor_records(id), vendor_user_id uuid references auth.users(id), status text not null default 'sent', expires_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now(), unique(work_order_id,vendor_directory_id));
    create table public.work_order_bids(id uuid primary key default gen_random_uuid(), work_order_id text not null references public.portal_work_order_records(id), manager_user_id uuid not null references auth.users(id), vendor_user_id uuid references auth.users(id), vendor_directory_id text references public.manager_vendor_records(id), amount_cents integer, materials_cents integer default 0, proposed_time timestamptz, bid_submitted_at timestamptz, note text, status text not null default 'submitted', quote_mode text default 'upfront', updated_at timestamptz default now(), unique(work_order_id,vendor_user_id));
    create table public.vendor_availability_rules(id uuid primary key default gen_random_uuid(), vendor_user_id uuid not null references auth.users(id), kind text not null, weekday smallint, specific_date date, start_minute smallint not null, end_minute smallint not null, note text);
    create table public.action_events(id uuid primary key default gen_random_uuid(), event_key text not null unique, domain text not null, event_type text not null, category text not null, manager_user_id uuid not null references auth.users(id), entity_id text not null, sender_user_id uuid references auth.users(id), sender_email text, occurred_at timestamptz not null, payload jsonb not null, processed_at timestamptz);
    create table public.action_event_deliveries(id uuid primary key default gen_random_uuid(), event_id uuid not null references public.action_events(id), audience text not null, recipient_key text not null, recipient_user_id uuid references auth.users(id), recipient_email text, status text not null, next_attempt_at timestamptz, rendered jsonb not null);
    create table public.sms_consent_events(id uuid primary key default gen_random_uuid(), recipient_phone_key text not null, manager_user_id uuid not null, messaging_service_sid text, purpose text not null, send_class text not null, conversation_key text, event_type text not null, source text not null, created_at timestamptz default now());
  `);
  await db.exec(coordinationMigration);
  await db.exec(sourcingMigration);
  await db.exec(`create table public.sms_outbox(id uuid primary key default gen_random_uuid(), manager_user_id uuid, purpose text, dedupe_key text, status text, provider_message_sid text, dispatch_started_at timestamptz, blocked_reason text, available_at timestamptz, lease_owner text, lease_expires_at timestamptz, updated_at timestamptz);
    create table public.sms_delivery_attempts(id uuid primary key default gen_random_uuid(),outbox_id uuid,state text,provider_message_sid text);`);
  await db.exec("alter table work_order_vendor_offers add column declined_reason text; alter table work_order_vendor_offers add column declined_at timestamptz;");
  await db.exec(readFileSync("supabase/migrations/20261016130000_vendor_sourcing_decline.sql", "utf8"));
  await db.exec(readFileSync(join(process.cwd(), "supabase/migrations/20261016140000_vendor_sourcing_recovery.sql"), "utf8"));

 // PGlite has one connection. Advisory shims only allow serial lifecycle tests;
 // genuine lock contention is covered by the separate PostgreSQL harness.
 await db.exec(`create or replace function public.pg_advisory_xact_lock(integer,integer) returns void language plpgsql as $$ begin return; end $$;
 create or replace function public.pg_try_advisory_xact_lock(integer,integer) returns boolean language sql as $$ select true $$;`);
 await db.exec(readFileSync("supabase/migrations/20261016150000_vendor_sourcing_final_lifecycle.sql", "utf8"));
 await db.exec(readFileSync("supabase/migrations/20261104115000_vendor_coordination_current_main_compat.sql", "utf8"));
}, 30_000);

afterAll(async () => { await db?.close(); });

describe("vendor sourcing SQL state and authorization", () => {
  it("creates one dormant or queued job per inserted service based on the global opt-in", async () => {
    const managerOff = "44444444-4444-4444-8444-444444444444";
    const managerOn = "55555555-5555-4555-8555-555555555555";
    await insertManager(managerOff, "off@example.test");
    await insertManager(managerOn, "on@example.test");
    await db.query("insert into manager_automation_settings(manager_user_id,vendor_dispatch) values ($1,$2::jsonb)", [managerOn, JSON.stringify({ quoteSourcingEnabled: true })]);

    const off = await addWorkOrder("source-off", managerOff);
    const on = await addWorkOrder("source-on", managerOn);
    await db.query(
      "insert into portal_work_order_records(id,manager_user_id,resident_email,property_id,row_data,resident_user_id) values ($1,$2,$3,$4,$5::jsonb,$2) on conflict(id) do update set row_data=excluded.row_data",
      ["source-on", managerOn, "source-on@resident.example", "property-1", JSON.stringify({ bucket: "open", title: "Updated" })],
    );

    expect(off.state).toBe("dormant");
    expect(on.state).toBe("queued");
    const jobs = await db.query<{ count: string }>("select count(*)::text as count from vendor_sourcing_jobs where work_order_id in ('source-off','source-on')");
    expect(jobs.rows[0].count).toBe("2");
  });

  it("reclaims expired work with a new lease and fences the old worker from pausing it", async () => {
    const manager = "66666666-6666-4666-8666-666666666666";
    await insertManager(manager, "lease@example.test");
    await db.query("insert into manager_automation_settings(manager_user_id,vendor_dispatch) values ($1,$2::jsonb)", [manager, JSON.stringify({ quoteSourcingEnabled: true })]);
    await addWorkOrder("source-lease", manager);

    const first = await claim("source-lease");
    expect(first).not.toBeNull();
    expect(await claim("source-lease")).toBeNull();
    await db.query("update vendor_sourcing_jobs set lease_until=now()-interval '1 second' where id=$1", [first!.id]);
    const second = await claim("source-lease");
    expect(second?.lease_token).not.toBe(first!.lease_token);
    expect(second?.attempts).toBe(2);

    const stale = await db.query<{ transition_vendor_sourcing: boolean }>(
      "select transition_vendor_sourcing($1,$2,$3::jsonb)",
      [first!.id, first!.lease_token, JSON.stringify({ state: "paused", reason: "stale worker" })],
    );
    expect(stale.rows[0].transition_vendor_sourcing).toBe(false);
    const current = await db.query<{ transition_vendor_sourcing: boolean }>(
      "select transition_vendor_sourcing($1,$2,$3::jsonb)",
      [second!.id, second!.lease_token, JSON.stringify({ state: "paused", reason: "Paused by manager" })],
    );
    expect(current.rows[0].transition_vendor_sourcing).toBe(true);
    const paused = await db.query<{ state: string; lease_token: string | null }>("select state,lease_token from vendor_sourcing_jobs where id=$1", [second!.id]);
    expect(paused.rows[0]).toEqual({ state: "paused", lease_token: null });
  });

  it("atomically creates one offer and proposal when the same sourced vendor is enrolled repeatedly", async () => {
    await insertManager(managerA, "manager-a@example.test");
    await insertManager(vendorA, "vendor-a@example.test");
    await db.query("insert into manager_automation_settings(manager_user_id,vendor_dispatch) values ($1,$2::jsonb)", [managerA, JSON.stringify({ quoteSourcingEnabled: true })]);
    await addWorkOrder("source-enroll", managerA);
    await db.query("insert into manager_vendor_records(id,manager_user_id,vendor_user_id,row_data) values ('owned-vendor',$1,$2,$3::jsonb)", [managerA, vendorA, JSON.stringify({ name: "Owned Vendor", email: "vendor-a@example.test", phone: "+13175550000", active: true })]);

    const job = await claim("source-enroll");
    const candidate = await db.query<{ id: string }>(`insert into vendor_sourcing_candidates(job_id,manager_user_id,stage,source,dedupe_key,contact,source_directory_id,expires_at)
      values ($1,$2,0,'roster','user:vendor-a',$3::jsonb,'owned-vendor',now()+interval '48 hours') returning id`,
      [job!.id, managerA, JSON.stringify({ name: "Owned Vendor", email: "vendor-a@example.test", phone: "+13175550000" })]);

    const enroll = () => db.query<{ result: Record<string, unknown> }>(
      "select enroll_vendor_sourcing_candidate($1,$2) as result",
      [candidate.rows[0].id, job!.lease_token],
    );
    const first = await enroll();
    const second = await enroll();
    expect(first.rows[0].result.proposal_id).toBeTruthy();
    expect(second.rows[0].result.proposal_id).toBe(first.rows[0].result.proposal_id);
    const counts = await db.query<{ offers: string; proposals: string; deliveries: string }>(`select
      (select count(*) from work_order_vendor_offers where work_order_id='source-enroll')::text as offers,
      (select count(*) from vendor_coordination_proposals where work_order_id='source-enroll')::text as proposals,
      (select count(*) from action_event_deliveries d join action_events e on e.id=d.event_id where e.entity_id='source-enroll')::text as deliveries`);
    expect(counts.rows[0].offers).toBe("1");
    expect(counts.rows[0].proposals).toBe("1");
    expect(counts.rows[0].deliveries).toBe("3");
  });

  it("rejects roster ownership mismatches and shared vendors whose owner has not opted into sharing", async () => {
    await insertManager(managerA, "owner-a@example.test");
    await insertManager(managerB, "owner-b@example.test");
    await addWorkOrder("source-private", managerA);
    await db.query("insert into manager_vendor_records(id,manager_user_id,row_data) values ('private-vendor',$1,$2::jsonb)", [managerB, JSON.stringify({ name: "Private vendor", active: true, sharedWithManagers: false })]);

    const job = await claim("source-private");
    const rosterCandidate = await db.query<{ id: string }>(`insert into vendor_sourcing_candidates(job_id,manager_user_id,stage,source,dedupe_key,contact,source_directory_id,expires_at)
      values ($1,$2,0,'roster','private-roster',$3::jsonb,'private-vendor',now()+interval '48 hours') returning id`, [job!.id, managerA, JSON.stringify({ name: "Private vendor" })]);
    await expect(db.query("select enroll_vendor_sourcing_candidate($1,$2)", [rosterCandidate.rows[0].id, job!.lease_token])).rejects.toThrow(/vendor no longer shared or active/);

    const sharedCandidate = await db.query<{ id: string }>(`insert into vendor_sourcing_candidates(job_id,manager_user_id,stage,source,dedupe_key,contact,source_directory_id,expires_at)
      values ($1,$2,1,'shared','private-shared',$3::jsonb,'private-vendor',now()+interval '48 hours') returning id`, [job!.id, managerA, JSON.stringify({ name: "Private vendor" })]);
    await expect(db.query("select enroll_vendor_sourcing_candidate($1,$2)", [sharedCandidate.rows[0].id, job!.lease_token])).rejects.toThrow(/vendor no longer shared or active/);
  });

  it("keeps sourcing tables and lease-fenced RPCs unavailable to raw authenticated clients", async () => {
    const result = await db.query<{ job_select: boolean; candidate_select: boolean; claim_execute: boolean }>(`select
      has_table_privilege('authenticated','public.vendor_sourcing_jobs','select') as job_select,
      has_table_privilege('authenticated','public.vendor_sourcing_candidates','select') as candidate_select,
      has_function_privilege('authenticated','public.claim_vendor_sourcing(integer,text)','execute') as claim_execute`);
    expect(result.rows[0]).toEqual({ job_select: false, candidate_select: false, claim_execute: false });
  });
});

describe("explicit manager sourcing recovery", () => {
  it("pauses collected quotes, preserves proposals, and refuses stale/foreign actions", async () => {
    await insertManager(managerA, "recovery@example.test");
    const job = await addWorkOrder("recover-quote", managerA);
    await db.query("update vendor_sourcing_jobs set state='quote_collected' where id=$1", [job.id]);
    const act = (owner: string, action: string) => db.query<{ ok: boolean }>("select control_vendor_sourcing('recover-quote',$1,$2) as ok",[owner,action]);
    expect((await act(managerB,"pause")).rows[0].ok).toBe(false);
    expect((await act(managerA,"pause")).rows[0].ok).toBe(true);
    expect((await db.query<{state:string}>("select state from vendor_sourcing_jobs where id=$1",[job.id])).rows[0].state).toBe("paused");
    expect((await act(managerA,"pause")).rows[0].ok).toBe(false);
    expect((await act(managerA,"resume")).rows[0].ok).toBe(true);
    expect((await act(managerA,"resume")).rows[0].ok).toBe(false);
  });
  it.each(["queued","blocked"])("resumes pause-blocked opening before/after candidate reconciliation (%s)",async (candidateStatus) => {
    const id=`pause-recover-${candidateStatus}`;const job=await addWorkOrder(id,managerA);
    await db.query("update vendor_sourcing_jobs set state='paused' where id=$1",[job.id]);
    const outbox=(await db.query<{id:string}>("insert into sms_outbox(manager_user_id,purpose,dedupe_key,status,blocked_reason,dispatch_started_at) values ($1,'vendor_quote_request',$2,'blocked','vendor_sourcing_stopped',now()) returning id",[managerA,`vendor-quote:${id}:pause-vendor`])).rows[0];
    await db.query("insert into sms_delivery_attempts(outbox_id,state) values ($1,'pre_dispatch_failed')",[outbox.id]);
    await db.query("insert into vendor_sourcing_candidates(job_id,manager_user_id,stage,source,dedupe_key,contact,status,reason,outbox_id,expires_at) values ($1,$2,0,'roster','pause-vendor','{}',$3,$4,$5,now()+interval '1 day')",[job.id,managerA,candidateStatus,candidateStatus==='queued'?null:'vendor_sourcing_stopped',outbox.id]);
    expect((await db.query<{ok:boolean}>("select control_vendor_sourcing($1,$2,'resume') as ok",[id,managerA])).rows[0].ok).toBe(true);
    expect((await db.query("select status,sourcing_retry_generation,dispatch_started_at from sms_outbox where id=$1",[outbox.id])).rows[0]).toEqual({status:"queued",sourcing_retry_generation:1,dispatch_started_at:null});
    expect((await db.query("select status,reason from vendor_sourcing_candidates where job_id=$1",[job.id])).rows[0]).toEqual({status:"queued",reason:null});
    // Explicit second pause/resume does not add a second intent or reservation generation.
    await db.query("select control_vendor_sourcing($1,$2,'pause')",[id,managerA]);
    await db.query("select control_vendor_sourcing($1,$2,'resume')",[id,managerA]);
    expect((await db.query("select sourcing_retry_generation from sms_outbox where id=$1",[outbox.id])).rows[0]).toEqual({sourcing_retry_generation:1});
  });
  it.each(["declined","expired","unknown","sid","takeover","stop"])("does not revive pause-blocked opening after %s",async (guard) => {
    const id=`pause-terminal-${guard}`;const job=await addWorkOrder(id,managerA);
    await db.query("update vendor_sourcing_jobs set state='paused' where id=$1",[job.id]);
    const outbox=(await db.query<{id:string}>("insert into sms_outbox(manager_user_id,purpose,dedupe_key,status,blocked_reason,provider_message_sid) values ($1,'vendor_quote_request',$2,'blocked',$3,$4) returning id",[managerA,`vendor-quote:${id}:terminal-vendor`,guard==='stop'?'recipient_opted_out':'vendor_sourcing_stopped',guard==='sid'?'SM-exists':null])).rows[0];
    await db.query("insert into vendor_sourcing_candidates(job_id,manager_user_id,stage,source,dedupe_key,contact,status,reason,outbox_id,expires_at) values ($1,$2,0,'roster','terminal-vendor','{}',$3,'vendor_sourcing_stopped',$4,$5)",[job.id,managerA,guard==='declined'?'declined':'blocked',outbox.id,new Date(Date.now()+(guard==='expired'?-1000:86400000)).toISOString()]);
    if(guard==='unknown')await db.query("insert into sms_delivery_attempts(outbox_id,state) values ($1,'unknown')",[outbox.id]);
    if(guard==='takeover') {
      await db.query("insert into vendor_coordination_proposals(work_order_id,manager_user_id,vendor_directory_id,vendor_user_id,visit_type,manager_takeover) values ($1,$2,'owned-vendor',$3,'repair',true)",[id,managerA,vendorA]);
    }
    await db.query("select control_vendor_sourcing($1,$2,'resume')",[id,managerA]);
    expect((await db.query("select status,sourcing_retry_generation from sms_outbox where id=$1",[outbox.id])).rows[0]).toEqual({status:"blocked",sourcing_retry_generation:0});
  });
  it("rearms a single definitively unsent intent but preserves unknown/submitted/sent attempts", async () => {
    const job = await addWorkOrder("recover-send", managerA);
    await db.query("update vendor_sourcing_jobs set state='needs_attention',stage=2 where id=$1",[job.id]);
    const states = ["blocked", "unknown", "submitted", "sent", "blocked"];
    const ids: string[] = [];
    for (const [index,status] of states.entries()) {
      const result = await db.query<{id:string}>("insert into sms_outbox(manager_user_id,purpose,dedupe_key,status,blocked_reason) values ($1,'vendor_quote_request',$2,$3,'runtime_env_paused') returning id",[managerA,`vendor-quote:recover-send:vendor-${index}`,status]);
      ids.push(result.rows[0].id);
      if (index === 4) await db.query("update sms_outbox set provider_message_sid='SM-existing' where id=$1",[ids[index]]);
      await db.query("insert into vendor_sourcing_candidates(job_id,manager_user_id,stage,source,dedupe_key,contact,status,reason,outbox_id,expires_at) values ($1,$2,2,'web',$3,'{}','blocked','runtime_env_paused',$4,now()+interval '1 day')",[job.id,managerA,`vendor-${index}`,ids[index]]);
      if (index) await db.query("insert into sms_delivery_attempts(outbox_id,state) values ($1,$2)",[ids[index],status]);
    }
    expect((await db.query<{ok:boolean}>("select control_vendor_sourcing('recover-send',$1,'resume') as ok",[managerA])).rows[0].ok).toBe(true);
    const rows=await db.query<{status:string}>("select status,sourcing_retry_generation from sms_outbox where id=any($1::uuid[]) order by dedupe_key",[ids]);
    expect(rows.rows.map(r=>r.status)).toEqual(["queued","unknown","submitted","sent","blocked"]);
    expect(rows.rows[0]).toMatchObject({sourcing_retry_generation:1});
    await db.query("update vendor_sourcing_jobs set state='needs_attention' where id=$1",[job.id]);
    await db.query("select control_vendor_sourcing('recover-send',$1,'resume')",[managerA]);
    expect((await db.query<{n:number}>("select count(*)::int n from sms_outbox where id=any($1::uuid[])",[ids])).rows[0].n).toBe(5);
  });
});
