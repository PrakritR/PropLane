import { readFileSync } from "node:fs";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
let db: PGlite;
const manager = "11111111-1111-4111-8111-111111111111";
const vendor = "22222222-2222-4222-8222-222222222222";
const outsider = "33333333-3333-4333-8333-333333333333";
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

 await db.exec("alter table work_order_vendor_offers add column declined_reason text; alter table work_order_vendor_offers add column declined_at timestamptz;");
 for (const name of ["20261004120000_vendor_coordination.sql", "20261016120000_vendor_sourcing.sql", "20261016130000_vendor_sourcing_decline.sql"]) {
   await db.exec(readFileSync(`supabase/migrations/${name}`, "utf8"));
 }
 await db.query("insert into auth.users values ($1),($2),($3)", [manager,vendor,outsider]);
 await db.query("insert into profiles(id,email) values ($1,'manager@example.test')",[manager]);
 await db.query("insert into manager_vendor_records(id,manager_user_id,vendor_user_id,row_data) values ('v1',$1,$2,'{}'),('v2',$1,$2,'{}')",[manager,vendor]);

 await db.exec(`create table public.sms_outbox(id uuid primary key default gen_random_uuid(), manager_user_id uuid, purpose text, dedupe_key text, status text, provider_message_sid text, dispatch_started_at timestamptz, blocked_reason text, available_at timestamptz, lease_owner text, lease_expires_at timestamptz, updated_at timestamptz);
 create table public.sms_delivery_attempts(id uuid primary key default gen_random_uuid(),outbox_id uuid,state text,provider_message_sid text);`);
 await db.exec(readFileSync("supabase/migrations/20261016140000_vendor_sourcing_recovery.sql", "utf8"));

 // PGlite has one connection. Advisory shims only allow serial lifecycle tests;
 // genuine lock contention is covered by the separate PostgreSQL harness.
 await db.exec(`create or replace function public.pg_advisory_xact_lock(integer,integer) returns void language plpgsql as $$ begin return; end $$;
 create or replace function public.pg_try_advisory_xact_lock(integer,integer) returns boolean language sql as $$ select true $$;`);
 await db.exec(readFileSync("supabase/migrations/20261016150000_vendor_sourcing_final_lifecycle.sql", "utf8"));
 await db.exec(readFileSync("supabase/migrations/20261104115000_vendor_coordination_current_main_compat.sql", "utf8"));
}, 30_000);
afterAll(async () => { await db?.close(); });
async function seed(id: string, state = "quote_collected", extraVendor = false) {
 await db.query("insert into portal_work_order_records(id,manager_user_id,resident_email,row_data) values ($1,$2,'resident@example.test','{\"bucket\":\"open\"}')",[id,manager]);
 await db.query("update vendor_sourcing_jobs set state=$2,stage=2,lease_token=gen_random_uuid(),lease_until=now()+interval '1 minute' where work_order_id=$1",[id,state]);
 for (const dir of extraVendor ? ["v1","v2"] : ["v1"]) {
  await db.query("insert into work_order_vendor_offers(work_order_id,manager_user_id,vendor_directory_id,vendor_user_id,expires_at) values ($1,$2,$3,$4,now()+interval '1 day')",[id,manager,dir,vendor]);
  await db.query("insert into vendor_coordination_proposals(work_order_id,manager_user_id,vendor_directory_id,vendor_user_id,visit_type,labor_cents,materials_cents,consultation_fee_cents,scope,duration_minutes) values ($1,$2,$3,$4,'repair',100,0,0,'Repair sink',60)",[id,manager,dir,vendor]);
  await db.query("insert into vendor_sourcing_candidates(job_id,manager_user_id,stage,source,dedupe_key,contact,local_directory_id,status) select id,$2,0,'roster',$3,'{}',$3,'responding' from vendor_sourcing_jobs where work_order_id=$1",[id,manager,dir]);
 }
}
async function decline(id: string, actor: string | null = vendor, source = "SM-decline") {
 return db.query<{ result: boolean }>("select decline_vendor_service_quote($1,$2,'v1',$3,null,'Cannot serve',$4) as result",[id,manager,actor,source]);
}
async function job(id: string) {
 return (await db.query<{ state: string; stage: number; lease_token: string | null }>("select state,stage,lease_token from vendor_sourcing_jobs where work_order_id=$1",[id])).rows[0];
}
describe("atomic vendor quote withdrawal lifecycle", () => {
 it.each(["waiting","quote_collected"])("invalidates an exact quote before or after collection (%s) and fences the worker", async (state) => {
  const id=`withdraw-${state}`; await seed(id,state); await decline(id);
  expect(await job(id)).toMatchObject({ state:"queued",stage:2,lease_token:null });
  const p=(await db.query<{ status:string; revision_reason:string; source_message_ids:string[] }>("select status,revision_reason,source_message_ids from vendor_coordination_proposals where work_order_id=$1",[id])).rows[0];
  expect(p).toMatchObject({ status:"declined",revision_reason:"Cannot serve",source_message_ids:["SM-decline"] });
  expect((await db.query("select status,declined_reason,declined_source_message_id from work_order_vendor_offers where work_order_id=$1",[id])).rows[0]).toMatchObject({ status:"declined",declined_reason:"Cannot serve",declined_source_message_id:"SM-decline" });
  expect((await db.query("select vendor_sourcing_has_viable_quote($1,$2) as live",[id,manager])).rows[0]).toEqual({ live:false });
  expect((await db.query("select status from vendor_sourcing_candidates c join vendor_sourcing_jobs j on j.id=c.job_id where j.work_order_id=$1",[id])).rows[0]).toEqual({ status:"declined" });
  await decline(id); expect(await job(id)).toMatchObject({ state:"queued",stage:2 });
  expect((await db.query("select count(*)::integer as count from work_order_bids where work_order_id=$1",[id])).rows[0]).toEqual({ count:0 });
 });
 it("rejects a foreign vendor and manager scope atomically", async () => {
  await seed("foreign"); await expect(decline("foreign",outsider)).rejects.toThrow(/identity unverified/);
  await expect(db.query("select decline_vendor_service_quote('foreign',$1,'v1',$2)",[outsider,vendor])).rejects.toThrow(/service unavailable/);
  expect(await job("foreign")).toMatchObject({ state:"quote_collected" });
 });
 it.each(["declined","cancelled"])("manager %s wakes only when the last live quote disappears", async (status) => {
  const id=`manager-${status}`;await seed(id,"quote_collected",true);
  await db.query("select vendor_coordination_action(jsonb_build_object('kind',$2::text,'proposal_id',id,'actor_user_id',$3::text,'expected_version',version)) from vendor_coordination_proposals where work_order_id=$1 and vendor_directory_id='v1'",[id,status === "declined" ? "decline_manager" : "cancel",manager]);
  expect(await job(id)).toMatchObject({ state:"quote_collected" });
  await db.query("select vendor_coordination_action(jsonb_build_object('kind',$2::text,'proposal_id',id,'actor_user_id',$3::text,'expected_version',version)) from vendor_coordination_proposals where work_order_id=$1 and vendor_directory_id='v2'",[id,status === "declined" ? "decline_manager" : "cancel",manager]);
  expect(await job(id)).toMatchObject({ state:"queued",stage:2 });
 });
 it("excludes expired and withdrawn offers even when their proposal still has exact terms",async () => {
  await seed("stale", "quote_collected",true);
  await db.query("update work_order_vendor_offers set expires_at=now()-interval '1 second' where work_order_id='stale' and vendor_directory_id='v1'");
  await db.query("update work_order_vendor_offers set status='withdrawn' where work_order_id='stale' and vendor_directory_id='v2'");
  expect((await db.query("select vendor_sourcing_has_viable_quote('stale',$1) as live",[manager])).rows[0]).toEqual({ live:false });
 });
 it("reopens collection when a required quote term is removed without changing ordered progress",async () => {
  await seed("incomplete");
  await db.query("update vendor_coordination_proposals set duration_minutes=null,status='collecting' where work_order_id='incomplete'");
  expect(await job("incomplete")).toMatchObject({ state:"queued",stage:2,lease_token:null });
 });
 it("accepts only a current verified directory binding for a directory-only SMS decline",async () => {
  await seed("binding");
  await db.query("update manager_vendor_records set vendor_user_id=null where id='v1'");
  await db.query("insert into vendor_coordination_phone_bindings(manager_user_id,vendor_directory_id,phone_e164) values ($1,'v1','+12025550123')",[manager]);
  await expect(decline("binding",null)).rejects.toThrow(/identity unverified/);
  await db.query("select decline_vendor_service_quote('binding',$1,'v1',null,'+12025550123','Unavailable','SM2')",[manager]);
  expect(await job("binding")).toMatchObject({ state:"queued" });
  await db.query("update manager_vendor_records set vendor_user_id=$1 where id='v1'",[vendor]);
 });
 it("preserves a pause and manager takeover",async () => {
  await seed("paused","paused");await decline("paused");expect(await job("paused")).toMatchObject({ state:"paused" });
  await seed("takeover");await db.query("update vendor_coordination_proposals set manager_takeover=true where work_order_id='takeover'");
  await decline("takeover");expect(await job("takeover")).toMatchObject({ state:"quote_collected" });
 });
 it("refuses vendor withdrawal of an approved financial commitment",async () => {
  await seed("approved");await db.query("update vendor_coordination_proposals set status='approved' where work_order_id='approved'");
  await expect(decline("approved")).rejects.toThrow(/approved commitment/);
  expect((await db.query("select status from work_order_vendor_offers where work_order_id='approved'")).rows[0]).toEqual({ status:"sent" });
 });
 it("closes the last rejected offer but preserves a separate live consultation for the same vendor",async () => {
  await seed("same-vendor");
  await db.query("insert into vendor_coordination_proposals(work_order_id,manager_user_id,vendor_directory_id,vendor_user_id,visit_type) values ('same-vendor',$1,'v1',$2,'consultation')",[manager,vendor]);
  const reject=()=>db.query("select vendor_coordination_action(jsonb_build_object('kind','decline_manager','proposal_id',id,'actor_user_id',$1::text,'expected_version',version)) from vendor_coordination_proposals where work_order_id='same-vendor' and visit_type='repair'",[manager]);
  await reject();
  expect((await db.query("select status from work_order_vendor_offers where work_order_id='same-vendor'")).rows[0]).toEqual({status:"sent"});
  expect((await db.query("select status from vendor_sourcing_candidates c join vendor_sourcing_jobs j on j.id=c.job_id where j.work_order_id='same-vendor'")).rows[0]).toEqual({status:"responding"});
  await db.query("select vendor_coordination_action(jsonb_build_object('kind','cancel','proposal_id',id,'actor_user_id',$1::text,'expected_version',version)) from vendor_coordination_proposals where work_order_id='same-vendor' and visit_type='consultation'",[manager]);
  expect((await db.query("select status from work_order_vendor_offers where work_order_id='same-vendor'")).rows[0]).toEqual({status:"declined"});
  expect(await job("same-vendor")).toMatchObject({state:"queued"});
 });
 it.each([false,true])("reopens a sole expired quote with delayed sweep=%s and makes it claimable",async (delayed) => {
  const id=`expiry-${delayed}`;await seed(id);
  await db.query("update work_order_vendor_offers set expires_at=now()-interval '1 second' where work_order_id=$1",[id]);
  if(!delayed) {
   expect((await db.query("select id from invalidate_vendor_service_offers($1,$2,'expired')",[id,manager])).rows).toHaveLength(1);
   expect(await job(id)).toMatchObject({state:"queued"});
  }
  expect((await db.query("select id from claim_vendor_sourcing(3,$1)",[id])).rows).toHaveLength(1);
  expect(await job(id)).toMatchObject({state:"queued",stage:2});
 });
 it("keeps another current quote, manager pause, takeover and approval protected during expiry recovery",async () => {
  await seed("expiry-multiple","quote_collected",true);
  await db.query("update work_order_vendor_offers set expires_at=now()-interval '1 second' where work_order_id='expiry-multiple' and vendor_directory_id='v1'");
  await db.query("select invalidate_vendor_service_offers('expiry-multiple',$1,'expired')",[manager]);
  expect(await job("expiry-multiple")).toMatchObject({state:"quote_collected"});
  expect((await db.query("select id from claim_vendor_sourcing(3,'expiry-multiple')")).rows).toHaveLength(0);
  for(const guard of ["paused","takeover","approved"]) {
   const id=`expiry-protect-${guard}`;await seed(id,guard==='paused'?'paused':'quote_collected');
   if(guard==='takeover')await db.query("update vendor_coordination_proposals set manager_takeover=true where work_order_id=$1",[id]);
   if(guard==='approved')await db.query("update vendor_coordination_proposals set status='approved' where work_order_id=$1",[id]);
   await db.query("update work_order_vendor_offers set expires_at=now()-interval '1 second' where work_order_id=$1",[id]);
   await db.query("select invalidate_vendor_service_offers($1,$2,'expired')",[id,manager]);
   expect((await db.query("select id from claim_vendor_sourcing(3,$1)",[id])).rows).toHaveLength(0);
   expect(await job(id)).toMatchObject({state:guard==='paused'?'paused':'quote_collected'});
  }
 });
 it("limits decline to the service role",async () => {
  expect((await db.query("select has_function_privilege('authenticated','public.decline_vendor_service_quote(text,uuid,text,uuid,text,text,text)','execute') as allowed")).rows[0]).toEqual({ allowed:false });
 });
});
