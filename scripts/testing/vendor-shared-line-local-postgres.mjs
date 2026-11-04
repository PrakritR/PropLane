/** Disposable, real PostgreSQL proof for revision-fenced shared-line consent.
 * Run with VENDOR_SHARED_LINE_LOCAL_POSTGRES=1. No external DATABASE_URL is accepted.
 */
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import pg from "pg";

const ROOT = resolve(import.meta.dirname, "../..");
const BIN = "/opt/homebrew/bin/";
const MIGRATIONS = [
  "20261004120000_vendor_coordination.sql",
  "20261004121000_vendor_coordination_calendar_fence.sql",
  "20261016120000_vendor_sourcing.sql",
  "20261016130000_vendor_sourcing_decline.sql",
  "20261016140000_vendor_sourcing_recovery.sql",
  "20261016150000_vendor_sourcing_final_lifecycle.sql",
];
const FIX = "20261104110000_vendor_directory_link_serialization.sql";
const MANAGER = "11111111-1111-4111-8111-111111111111";
const VENDOR = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const { Client } = pg;
if (process.env.VENDOR_SHARED_LINE_LOCAL_POSTGRES !== "1" || process.env.DATABASE_URL) {
  throw new Error("Set VENDOR_SHARED_LINE_LOCAL_POSTGRES=1 and unset DATABASE_URL; this runner creates its own loopback PostgreSQL cluster.");
}

const run = (name, args, timeout = 30_000) => execFileSync(`${BIN}${name}`, args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] });
async function freePort() {
  const server = createServer();
  await new Promise((ok, reject) => server.once("error", reject).listen(0, "127.0.0.1", ok));
  const port = server.address().port;
  await new Promise((ok) => server.close(ok));
  return port;
}
async function cluster() {
  for (const name of ["initdb", "pg_ctl", "postgres"]) assert.match(run(name, ["--version"]), /PostgreSQL/);
  const dir = mkdtempSync(join(tmpdir(), "vendor-quote-pg-"));
  const data = join(dir, "data");
  const port = await freePort();
  let started = false;
  try {
    run("initdb", ["-D", data, "--username=postgres", "--auth-local=trust", "--auth-host=trust", "--no-locale", "--encoding=UTF8"]);
    appendFileSync(join(data, "postgresql.conf"), `\nlisten_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories=''\nshared_buffers='16MB'\nmax_connections=10\nmax_worker_processes=0\nmax_parallel_workers=0\nautovacuum=off\ndeadlock_timeout='100ms'\n`);
    run("pg_ctl", ["-D", data, "-l", join(dir, "postgres.log"), "-w", "-t", "30", "start"], 35_000);
    started = true;
    return { dir, data, port };
  } catch (error) {
    if (started) run("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
function stopCluster(owned) {
  if (!owned) return;
  // pg_ctl only acts on this runner's unique data directory; never scan/stop by port.
  try { run("pg_ctl", ["-D", owned.data, "-m", "fast", "-w", "-t", "20", "stop"], 25_000); }
  finally { rmSync(owned.dir, { recursive: true, force: true }); }
}
function config(owned, database) {
  return { host: "127.0.0.1", port: owned.port, user: "postgres", database,
    connectionTimeoutMillis: 5000, options: "-c statement_timeout=12000 -c lock_timeout=8000" };
}
async function connect(owned, database) {
  const db = new Client(config(owned, database));
  await db.connect();
  return db;
}

const BASE_SCHEMA = `
create role anon; create role authenticated; create role service_role;
create schema auth; create table auth.users(id uuid primary key);
create table public.agent_sessions(id uuid primary key default gen_random_uuid(),user_id uuid not null,kind text,vendor_directory_id text);
create table public.profiles(id uuid primary key references auth.users(id),phone text,phone_verified_at timestamptz,email text,full_name text);
create table public.manager_automation_settings(manager_user_id uuid primary key references auth.users(id),vendor_dispatch jsonb not null default '{}'::jsonb,row_data jsonb not null default '{}'::jsonb,updated_at timestamptz default now());
create table public.manager_vendor_records(id text primary key,manager_user_id uuid not null references auth.users(id),vendor_user_id uuid references auth.users(id) on delete set null,row_data jsonb not null,updated_at timestamptz default now());
create table public.portal_work_order_records(id text primary key,manager_user_id uuid references auth.users(id),vendor_user_id uuid references auth.users(id),resident_email text, resident_user_id uuid references auth.users(id),property_id text,row_data jsonb not null,updated_at timestamptz default now());
create table public.work_order_vendor_offers(id uuid primary key default gen_random_uuid(),work_order_id text not null references public.portal_work_order_records(id),manager_user_id uuid not null references auth.users(id),vendor_directory_id text not null references public.manager_vendor_records(id),vendor_user_id uuid references auth.users(id),status text not null default 'sent',expires_at timestamptz,created_at timestamptz default now(),updated_at timestamptz default now(),unique(work_order_id,vendor_directory_id));
create table public.work_order_bids(id uuid primary key default gen_random_uuid(),work_order_id text not null references public.portal_work_order_records(id),manager_user_id uuid not null references auth.users(id),vendor_user_id uuid references auth.users(id),vendor_directory_id text references public.manager_vendor_records(id),amount_cents integer,materials_cents integer default 0,proposed_time timestamptz, bid_submitted_at timestamptz,note text,status text not null default 'submitted',quote_mode text default 'upfront',updated_at timestamptz default now(),unique(work_order_id,vendor_user_id));
create table public.vendor_availability_rules(id uuid primary key default gen_random_uuid(),vendor_user_id uuid not null references auth.users(id),kind text not null,weekday smallint,specific_date date,start_minute smallint not null,end_minute smallint not null,note text);
create table public.action_events(id uuid primary key default gen_random_uuid(),event_key text not null unique,domain text not null,event_type text not null,category text not null,manager_user_id uuid not null references auth.users(id),entity_id text not null,sender_user_id uuid references auth.users(id),sender_email text,occurred_at timestamptz not null,payload jsonb not null,processed_at timestamptz);
create table public.action_event_deliveries(id uuid primary key default gen_random_uuid(),event_id uuid not null references public.action_events(id),audience text not null,recipient_key text not null,recipient_user_id uuid references auth.users(id),recipient_email text,status text not null,next_attempt_at timestamptz,rendered jsonb not null);
create table public.sms_consent_events(id uuid primary key default gen_random_uuid(),recipient_phone_key text not null,manager_user_id uuid not null,messaging_service_sid text,purpose text not null,send_class text not null,conversation_key text,event_type text not null,source text not null,created_at timestamptz default now());
`;
async function install(db, fixed) {
  await db.query(BASE_SCHEMA);
  for (const file of MIGRATIONS) {
    if (file.includes("20261016130000")) {
      await db.query(`create table public.sms_outbox(id uuid primary key default gen_random_uuid(),manager_user_id uuid,purpose text,dedupe_key text,status text,provider_message_sid text,dispatch_started_at timestamptz,blocked_reason text,available_at timestamptz,lease_owner text,lease_expires_at timestamptz,updated_at timestamptz); create table public.sms_delivery_attempts(id uuid primary key default gen_random_uuid(),outbox_id uuid,state text,provider_message_sid text); alter table public.work_order_vendor_offers add column declined_reason text; alter table public.work_order_vendor_offers add column declined_at timestamptz;`);
    }
    await db.query(readFileSync(join(ROOT, "supabase/migrations", file), "utf8"));
  }
  if (fixed) await db.query(readFileSync(join(ROOT, "supabase/migrations", FIX), "utf8"));
  if (fixed) await db.query(readFileSync(join(ROOT, "supabase/migrations/20261104115000_vendor_coordination_current_main_compat.sql"), "utf8"));
  await db.query("insert into auth.users(id) values($1),($2),($3)", [MANAGER, VENDOR, OTHER]);
  await db.query("insert into public.profiles(id,email,phone,phone_verified_at,full_name) values($1,'manager@example.test','+13175550001',now(),'QA Manager'),($2,'vendor@example.test','+13175550002',now(),'QA Vendor'),($3,'other@example.test',null,null,'QA Other')", [MANAGER, VENDOR, OTHER]);
}
async function scalar(db, sql, args = []) { return (await db.query(sql, args)).rows[0]; }
async function seedF1(db, tag) {
  const directory = `dir-${tag}`;
  const service = `svc-${tag}`;
  const lease = randomUUID();
  await db.query("insert into public.manager_vendor_records(id,manager_user_id,row_data) values($1,$2,$3)", [directory, MANAGER, { name: "Phone-linked vendor", email: "vendor@example.test", phone: "+13175550002", active: true }]);
  await db.query("insert into public.portal_work_order_records(id,manager_user_id,resident_email,property_id,row_data) values($1,$2,$3,'property-1',$4)", [service, MANAGER, `${tag}@resident.test`, { bucket: "open", title: "Leaky sink" }]);
  const job = await scalar(db, "select id from public.vendor_sourcing_jobs where work_order_id=$1", [service]);
  assert.ok(job?.id);
  await db.query("update public.vendor_sourcing_jobs set state='waiting',stage=1,lease_token=$2,lease_until=now()+interval '1 hour' where id=$1", [job.id, lease]);
  await db.query("insert into public.work_order_vendor_offers(work_order_id,manager_user_id,vendor_directory_id,status,expires_at) values($1,$2,$3,'sent',now()+interval '2 days')", [service, MANAGER, directory]);
  const repair = await scalar(db, `insert into public.vendor_coordination_proposals(work_order_id,manager_user_id,vendor_directory_id,visit_type,status,scope,labor_cents,materials_cents,consultation_fee_cents,duration_minutes)
    values($1,$2,$3,'repair','cancelled','Repair pipe',10000,2000,0,60) returning id`, [service, MANAGER, directory]);
  const consultation = await scalar(db, "insert into public.vendor_coordination_proposals(work_order_id,manager_user_id,vendor_directory_id,visit_type,status) values($1,$2,$3,'consultation','collecting') returning id", [service, MANAGER, directory]);
  const candidate = await scalar(db, `insert into public.vendor_sourcing_candidates(job_id,manager_user_id,stage,source,dedupe_key,contact,source_directory_id,status,expires_at)
    values($1,$2,1,'roster',$3,$4,$5,'discovered',now()+interval '2 days') returning id`, [job.id, MANAGER, tag, { name: "Phone-linked vendor", email: "vendor@example.test", phone: "+13175550002" }, directory]);
  return { directory, service, lease, job: job.id, candidate: candidate.id, repair: repair.id, consultation: consultation.id };
}

const AUTHORITY = '20261104130000_vendor_quote_sender_authority.sql';
const WORKSPACE = '44444444-4444-4444-8444-444444444444';
const PHONE = '+13175550123', LINE = '+12065550100';
const snapshot = { mode:'software', managerUserId:MANAGER, workspaceId:WORKSPACE, displayName:'QA Manager', legalName:'QA Manager',
 email:'qa@example.test', workPhone:LINE, messagingServiceSid:'MGqa', version:1, transportKind:'shared', selectedLineId:null, providerMessagingServiceSid:'MGshared' };
const senderKey = createHash('sha256').update([snapshot.managerUserId,snapshot.workspaceId,snapshot.mode,snapshot.version,snapshot.email,
 snapshot.displayName,snapshot.legalName,snapshot.workPhone,snapshot.messagingServiceSid,snapshot.transportKind,'',snapshot.providerMessagingServiceSid].join('|')).digest('hex');
async function proof(db, cap, channel='sms', ttl=5000) {
 const r=await scalar(db,'select * from public.read_vendor_quote_sender_authority_revision()');
 return { capabilityId:cap, revision:r.revision, evaluatedAt:r.evaluated_at.toISOString(), validUntil:new Date(r.evaluated_at.getTime()+ttl).toISOString(), channel, senderKey, senderSnapshot:snapshot };
}
async function seed(db, tag) {
 const f=await seedF1(db,tag);
 await db.query("update public.vendor_coordination_proposals set status='collecting' where id=$1",[f.repair]);
 await db.query("update public.vendor_sourcing_candidates set local_directory_id=$2,proposal_id=$3 where id=$1",[f.candidate,f.directory,f.repair]);
 const cap=await scalar(db,`insert into public.vendor_quote_contact_capabilities(token_digest,token_nonce,purpose,manager_user_id,job_id,candidate_id,work_order_id,vendor_directory_id,proposal_id,recipient_email,sender_mode,sender_version,sender_snapshot,expires_at)
 values(encode(sha256(convert_to($8,'UTF8')),'hex'),repeat('c',64),'response',$1,$2,$3,$4,$5,$6,'vendor@example.test','software',1,$7,now()+interval '1 day') returning id`,[MANAGER,f.job,f.candidate,f.service,f.directory,f.repair,snapshot,tag]);
 const version=(await scalar(db,'select version from public.vendor_coordination_proposals where id=$1',[f.repair])).version;
 const challenge=await scalar(db,`insert into public.vendor_quote_sms_consent_challenges(capability_id,manager_user_id,candidate_id,vendor_directory_id,proposal_id,requested_phone,work_phone,messaging_service_sid,sender_version,proposal_version,code_digest,wording_version,expires_at)
 values($1,$2,$3,$4,$5,$6,$7,'MGqa',1,$8,repeat('d',64),'vendor_quote_sms_v1',now()+interval '10 minutes') returning id`,[cap.id,MANAGER,f.candidate,f.directory,f.repair,PHONE,LINE,version]);
 return {...f,cap:cap.id,challenge:challenge.id};
}
const consume = async (db,f,p,sid='SM'+f.cap.replaceAll('-','')) => (await scalar(db,"select public.consume_vendor_quote_sms_challenge($1,repeat('d',64),$2,$3,'MGqa',$4,$5::jsonb) as granted",[f.challenge,PHONE,LINE,sid,p])).granted;
async function cleanEffects(db,f) {
 for (const table of ['vendor_quote_sms_consent_events','vendor_coordination_phone_bindings']) assert.equal((await scalar(db,`select count(*)::int as n from public.${table} where vendor_directory_id=$1`,[f.directory])).n,0);
}
async function main() {
 let owned,db,a,b;
 try {
  owned=await cluster(); db=await connect(owned,'postgres'); await install(db,true);
  await db.query(`create table public.profile_roles(user_id uuid,role text); create table public.manager_sms_numbers(manager_user_id uuid,workspace_id uuid,phone_number text,messaging_service_sid text,provision_state text,released_at timestamptz);
  create table public.manager_property_records(id text primary key,manager_user_id uuid,workspace_id uuid);
  create table public.manager_assistant_emails(workspace_id uuid,manager_user_id uuid,mailbox_local text,inbox_token text,provision_state text);
  alter table public.profiles add column sms_opt_out_at timestamptz; alter table public.profiles add column sms_consent_at timestamptz;
  create table public.sms_consent(phone text primary key,opted_out_at timestamptz,opted_in_at timestamptz);
  alter table public.sms_consent_events add column occurred_at timestamptz default now(); alter table public.sms_consent_events add column wording_version text; alter table public.sms_consent_events add column evidence jsonb;
  alter table public.agent_sessions add column if not exists landlord_id uuid; alter table public.agent_sessions add column if not exists work_order_id text; alter table public.agent_sessions add column if not exists inbox_thread_id text;
  alter table public.agent_sessions add column if not exists vendor_user_id uuid; alter table public.agent_sessions add column if not exists vendor_phone_e164 text;
  alter table public.agent_sessions add column if not exists status text not null default 'active'; alter table public.agent_sessions add column if not exists updated_at timestamptz default now();
  create unique index if not exists agent_sessions_vendor_wo_uidx on public.agent_sessions(work_order_id,vendor_directory_id);
  create table public.portal_inbox_thread_records(id text primary key,scope text,owner_user_id uuid,participant_email text,thread_type text,workspace_id uuid,row_data jsonb,updated_at timestamptz);
  create table public.portal_inbox_thread_aliases(alias_id text primary key,thread_id text not null);
  alter table public.portal_work_order_records add column if not exists assigned_property_id text;`);
  await db.query(readFileSync(join(ROOT,'supabase/migrations/20261104111000_vendor_quote_contact.sql'),'utf8'));
  await db.query(readFileSync(join(ROOT,'supabase/migrations/20261104112000_vendor_quote_inbox.sql'),'utf8'));
  await db.query(readFileSync(join(ROOT,'supabase/migrations/20261104121000_vendor_quote_inbox_current_main_compat.sql'),'utf8'));

  await db.query(`alter table auth.users add column email text, add column email_confirmed_at timestamptz, add column last_sign_in_at timestamptz;
  alter table public.manager_sms_numbers add column id uuid default gen_random_uuid(),add column phone_number_sid text,add column campaign_sid text,add column registration_state text,add column registration_ref text,add column provisioned_at timestamptz,add column requested_at timestamptz,add column attachment_state text,add column number_registration_state text,add column grace_started_at timestamptz,add column grace_expires_at timestamptz,add column quarantined_at timestamptz,add column quarantine_reason text;
  create table public.portal_workspaces(id uuid primary key,owner_user_id uuid,is_default boolean,is_service boolean);
  create table public.workspace_work_numbers(workspace_id uuid,number_id uuid,is_primary boolean);
  create table public.platform_service_settings(singleton boolean,owner_user_id uuid);
  create table public.manager_purchases(id uuid,tier text,billing text,stripe_subscription_id text,stripe_checkout_session_id text,stripe_customer_id text,promo_code text,apple_original_transaction_id text,paid_at timestamptz,user_id uuid,email text,promo_ends_at timestamptz);
  create table public.number_subscriptions(owner_user_id uuid,status text);
  create table public.manager_promo_code_policies(code text,expires_at timestamptz);
  create table public.sms_runtime_config(singleton boolean,mode text,pilot_manager_user_ids uuid[],line_mode text,shared_number_e164 text,shared_messaging_service_sid text,shared_pilot_workspace_ids uuid[]);
  create table public.sms_inbound_receipts(message_sid text primary key,manager_user_id uuid,recipient_phone_key text,status text,attempt_count integer,workspace_id uuid,inbound_payload jsonb,first_received_at timestamptz default now(),completed_at timestamptz,updated_at timestamptz,lease_owner text,lease_expires_at timestamptz);
  create table public.inbound_sms_log(id uuid primary key default gen_random_uuid(),manager_user_id uuid,from_phone text,to_phone text,body text,message_sid text,created_at timestamptz,workspace_id uuid,counterparty_role text,conversation_key text,matched_sender_user_id uuid);
  insert into public.sms_runtime_config values(true,'automatic','{}','shared','+12065550100','MGshared','{}');`);
  await db.query(readFileSync(join(ROOT,'supabase/migrations',AUTHORITY),'utf8'));
  await db.query(readFileSync(join(ROOT,'supabase/migrations',AUTHORITY),'utf8')); // Reapply preserves the singleton and grants.
  await db.query('insert into public.portal_workspaces values($1,$2,true,false)',[WORKSPACE,MANAGER]);
  await db.query("insert into public.manager_property_records values('property-1',$1,$2)",[MANAGER,WORKSPACE]);
  const revision=async()=> (await scalar(db,'select revision from public.vendor_quote_sender_authority_revision')).revision;
  let r=await revision();
  await db.query('update auth.users set last_sign_in_at=now() where id=$1',[MANAGER]); assert.equal(await revision(),r);
  await db.query('update auth.users set email=$2,email_confirmed_at=now() where id=$1',[MANAGER,'qa@example.test']); assert.notEqual(await revision(),r);
  r=await revision(); await db.query("update public.sms_runtime_config set mode=mode"); assert.equal(await revision(),r);
  await db.query('begin');await db.query("insert into public.manager_promo_code_policies values('FRESH',now()+interval '1 minute')");assert.notEqual(await revision(),r);await db.query('rollback');assert.equal(await revision(),r);
  for (const [table,sql] of [
    ['sms_runtime_config',"update public.sms_runtime_config set mode='paused'"],
    ['manager_sms_numbers',"insert into public.manager_sms_numbers(manager_user_id,workspace_id,phone_number) values('"+MANAGER+"','"+WORKSPACE+"','+13175550999')"],
    ['workspace_work_numbers',"insert into public.workspace_work_numbers values('"+WORKSPACE+"',gen_random_uuid(),true)"],
    ['portal_workspaces',"update public.portal_workspaces set is_service=true"],
    ['platform_service_settings',"insert into public.platform_service_settings values(true,'"+OTHER+"')"],
    ['manager_purchases',"insert into public.manager_purchases(id,tier) values(gen_random_uuid(),'pro')"],
    ['number_subscriptions',"insert into public.number_subscriptions values('"+MANAGER+"','active')"],
    ['manager_promo_code_policies',"insert into public.manager_promo_code_policies values('ABSENT',now())"],
    ['profiles',"update public.profiles set full_name='Changed' where id='"+MANAGER+"'"],
    ['manager_assistant_emails',"insert into public.manager_assistant_emails values('"+WORKSPACE+"','"+MANAGER+"','qa','abcdefgh','active')"],
    ['vendor_outreach_workspace_profiles',"insert into public.vendor_outreach_workspace_profiles(manager_user_id) values('"+MANAGER+"')"],
    ['manager_property_records',"update public.manager_property_records set workspace_id=gen_random_uuid()"],
    ['portal_work_order_records',"insert into public.portal_work_order_records(id,manager_user_id,row_data) values('revision-service','"+MANAGER+"','{\"bucket\":\"open\"}')"],
  ]) { await db.query('begin');const before=await revision();await db.query(sql);assert.notEqual(await revision(),before,table);await db.query('rollback'); }
  const stale=await seed(db,'revision-stale'), staleProof=await proof(db,stale.cap);
  await db.query("update public.sms_runtime_config set mode='paused'");
  await assert.rejects(consume(db,stale,staleProof),/sender authority changed/);await cleanEffects(db,stale);
  await db.query("update public.sms_runtime_config set mode='automatic'");
  const expired=await seed(db,'time-expired'), expiredProof=await proof(db,expired.cap,'sms',-1);
  await assert.rejects(consume(db,expired,expiredProof),/sender authority changed/);await cleanEffects(db,expired);
  const bound=await seed(db,'wrong-cap');const wrong=await proof(db,bound.cap);wrong.capabilityId=stale.cap;
  await assert.rejects(consume(db,bound,wrong),/sender authority changed/);await cleanEffects(db,bound);
  await db.query('set role service_role');
  await assert.rejects(db.query("select public.consume_vendor_quote_sms_challenge(null,'','','','','')"),/permission denied/);
  await assert.rejects(db.query("select public.vendor_quote_capability_action('','{}')"),/permission denied/);
  await assert.rejects(db.query("select public.vendor_quote_submit_response('',1,'{}')"),/permission denied/);
  await assert.rejects(db.query('update public.vendor_quote_sender_authority_revision set revision=2'),/permission denied/);await db.query('reset role');
  await db.query('set role anon');await assert.rejects(db.query('select * from public.vendor_quote_sender_authority_revision'),/permission denied/);await db.query('reset role');
  const ok=await seed(db,'shared-no-owned-number');const p=await proof(db,ok.cap);
  assert.equal((await scalar(db,'select count(*)::int as n from public.manager_sms_numbers')).n,0);
  await db.query('set role service_role');assert.equal(await consume(db,ok,p),true);await db.query('reset role');
  assert.equal((await scalar(db,'select body from public.inbound_sms_log where message_sid=$1',['SM'+ok.cap.replaceAll('-','')])).body,'QUOTE [redacted]');
  assert.equal(await consume(db,ok,p),true);assert.equal((await scalar(db,'select count(*)::int as n from public.vendor_quote_sms_consent_events where challenge_id=$1',[ok.challenge])).n,1);
  await db.query('delete from public.vendor_coordination_phone_bindings');
  const failure=await seed(db,'atomic-log-failure');
  await db.query("create function public.test_fail_log() returns trigger language plpgsql as $$begin raise exception 'injected receipt failure';end$$; create trigger test_fail_log before insert on public.inbound_sms_log for each row execute function public.test_fail_log()");
  await assert.rejects(consume(db,failure,await proof(db,failure.cap)),/injected receipt failure/);await cleanEffects(db,failure);
  await db.query('drop trigger test_fail_log on public.inbound_sms_log;drop function public.test_fail_log()');
  a=await connect(owned,'postgres');b=await connect(owned,'postgres');
  const race=await seed(db,'policy-mutation-wins'), raceProof=await proof(db,race.cap);
  await a.query('begin');await a.query("update public.sms_runtime_config set mode='paused'");
  await assert.rejects(consume(b,race,raceProof),error=>error.code==='40001' && /sender authority busy/.test(error.message));
  await a.query('commit');await assert.rejects(consume(b,race,raceProof),/sender authority changed/);await cleanEffects(db,race);
  await db.query("update public.sms_runtime_config set mode='automatic'");
  const grantFirst=await seed(db,'grant-locks-policy');await a.query('begin');assert.equal(await consume(a,grantFirst,await proof(db,grantFirst.cap)),true);
  await assert.rejects(b.query("update public.sms_runtime_config set mode='paused'"),error=>error.code==='40001');
  assert.equal((await scalar(db,'select mode from public.sms_runtime_config')).mode,'automatic');
  await a.query('commit');await b.query("update public.sms_runtime_config set mode='paused'");
  await db.query('delete from public.vendor_coordination_phone_bindings');
  const stopped=await seed(db,'stop-first');await db.query("update public.sms_runtime_config set mode='automatic'");
  await db.query("insert into public.sms_consent(phone) values('3175550123') on conflict do nothing");
  await a.query('begin');await a.query("update public.sms_consent set opted_out_at=clock_timestamp() where phone='3175550123'");
  const stopPending=consume(b,stopped,await proof(db,stopped.cap));await new Promise(resolve=>setTimeout(resolve,80));await a.query('commit');assert.equal(await stopPending,false);await cleanEffects(db,stopped);
  await db.query("update public.sms_consent set opted_in_at=clock_timestamp() where phone='3175550123'");
  const horizon=await seed(db,'cross-time-boundary');
  await a.query('begin');await a.query("select 1 from public.sms_consent where phone='3175550123' for update");
  const horizonPending=consume(b,horizon,await proof(db,horizon.cap,'sms',250));
  const horizonRejected=assert.rejects(horizonPending,/sender authority changed/);
  await new Promise(resolve=>setTimeout(resolve,350));await a.query('commit');await horizonRejected;await cleanEffects(db,horizon);
  assert.equal((await scalar(db,'select attempts from public.vendor_quote_sms_consent_challenges where id=$1',[horizon.challenge])).attempts,0);
  const grantStop=await seed(db,'grant-before-stop');await a.query('begin');assert.equal(await consume(a,grantStop,await proof(db,grantStop.cap)),true);
  let stopDone=false;const stopAfter=b.query("update public.sms_consent set opted_out_at=clock_timestamp() where phone='3175550123'").then(()=>{stopDone=true});
  await new Promise(resolve=>setTimeout(resolve,80));assert.equal(stopDone,false);await a.query('commit');await stopAfter;
  await db.query("update public.sms_consent set opted_in_at=clock_timestamp() where phone='3175550123'");
  await db.query('delete from public.vendor_coordination_phone_bindings');
  // A row lock acquired before the revision mutex cannot deadlock a proof. Its write aborts atomically.
  const tuple=await seed(db,'profile-tuple-contention');
  await a.query('begin');await a.query('select 1 from public.profiles where id=$1 for update',[MANAGER]);
  await b.query('begin');assert.equal(await consume(b,tuple,await proof(db,tuple.cap)),true);
  await assert.rejects(a.query("update public.profiles set full_name='Changed pending name' where id=$1",[MANAGER]),error=>error.code==='40001');
  await a.query('rollback');await b.query('commit');assert.equal((await scalar(db,'select full_name from public.profiles where id=$1',[MANAGER])).full_name,'QA Manager');
  await db.query('delete from public.vendor_coordination_phone_bindings');
  let readyIndex=0;
  async function ready(tag) {
    const f=await seed(db,tag);const start=new Date(Date.now()+(++readyIndex+3)*86400000),end=new Date(start.getTime()+3600000);
    const windows=[{startIso:start.toISOString(),endIso:end.toISOString(),timeZone:'America/Los_Angeles'}];
    await db.query("update public.manager_vendor_records set row_data=row_data||jsonb_build_object('phone',$2::text) where id=$1",[f.directory,PHONE]);
    await db.query("insert into public.vendor_coordination_phone_bindings(manager_user_id,vendor_directory_id,phone_e164,verified_at) values($1,$2,$3,now())",[MANAGER,f.directory,PHONE]);
    await db.query("update public.vendor_coordination_proposals set status='ready',exclusions='',quote_revision=1,vendor_confirmed_revision=1,resident_confirmed_revision=1,labor_cents=10000,materials_cents=0,consultation_fee_cents=0,duration_minutes=60,selected_start_at=$2,vendor_windows=$3,resident_windows=$3 where id=$1",[f.repair,start,JSON.stringify(windows)]);
    return f;
  }
  const approve=(client,f)=>scalar(client,'select public.vendor_coordination_action($1::jsonb) as result',[{kind:'approve_manager',actor_user_id:MANAGER,proposal_id:f.repair,expected_version:1,source_message_id:'manager-approval-'+f.repair}]);
  const managerFirst=await ready('manager-approval-first'),managerFirstProof=await proof(db,managerFirst.cap),beforeApproval=await revision();
  await a.query('begin');assert.equal((await approve(a,managerFirst)).result.status,'approved');
  assert.equal(await revision(),beforeApproval,'booking fields are lifecycle, not sender identity inputs');
  let proofDone=false;const proofAfterApproval=consume(b,managerFirst,managerFirstProof).then(result=>{proofDone=true;return result});
  await new Promise(resolve=>setTimeout(resolve,80));assert.equal(proofDone,false);await a.query('commit');assert.equal(await proofAfterApproval,false);assert.equal((await scalar(db,'select count(*)::int as n from public.vendor_quote_sms_consent_events where capability_id=$1',[managerFirst.cap])).n,0);
  await db.query('delete from public.vendor_coordination_phone_bindings');
  const proofFirst=await ready('quote-proof-first');await a.query('begin');assert.equal(await consume(a,proofFirst,await proof(db,proofFirst.cap)),true);
  let approvalDone=false;const approvalAfterProof=approve(b,proofFirst).then(result=>{approvalDone=true;return result});
  await new Promise(resolve=>setTimeout(resolve,80));assert.equal(approvalDone,false);await a.query('commit');assert.equal((await approvalAfterProof).result.status,'approved');
  // Regression reproduction installs ONLY the pre-correction consume lock order in this disposable cluster.
  const consumeSignature='public.consume_vendor_quote_sms_challenge(uuid,text,text,text,text,text)';
  const canonicalDefinition=(await scalar(db,'select pg_get_functiondef($1::regprocedure) as definition',[consumeSignature])).definition;
  const serviceLock=" perform public.lock_vendor_service((select cap.work_order_id from public.vendor_quote_sms_consent_challenges x join public.vendor_quote_contact_capabilities cap on cap.id=x.capability_id where x.id=p_challenge_id));";
  const directoryLock=" perform public.lock_vendor_directory((select vendor_directory_id from public.vendor_quote_sms_consent_challenges where id=p_challenge_id));";
  assert.ok(canonicalDefinition.includes(directoryLock+'\n'+serviceLock));
  const legacyDefinition=canonicalDefinition.replace(directoryLock+'\n'+serviceLock,serviceLock+'\n'+directoryLock);
  const directoryOperations={
    link:(client,f)=>scalar(client,'select public.link_vendor_directory_account($1,$2,$3) as result',[f.directory,MANAGER,OTHER]),
    sourcingEnrollment:(client,f)=>scalar(client,'select public.enroll_vendor_sourcing_candidate($1,$2) as result',[f.candidate,f.lease]),
    coordinationEnrollment:(client,f)=>scalar(client,'select public.vendor_coordination_action($1::jsonb) as result',[{kind:'enroll',work_order_id:f.service,vendor_directory_id:f.directory,manager_user_id:MANAGER,actor_user_id:MANAGER,visit_type:'repair',source_message_id:'race-enroll-'+f.candidate}]),
  };
  async function waitForAdvisory(client) {
    const pid=(await scalar(client,'select pg_backend_pid() as pid')).pid;
    return pid;
  }
  const bPid=await waitForAdvisory(b);
  async function blockedOnAdvisory(pid) {
    const deadline=Date.now()+2000;
    while(Date.now()<deadline) {
      const row=await scalar(db,"select wait_event_type,wait_event from pg_stat_activity where pid=$1",[pid]);
      if(row?.wait_event_type==='Lock' && row.wait_event==='advisory') return;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    throw new Error('expected advisory-lock barrier was not reached');
  }
  async function settleTransaction(client,operation) {
    try {const result=await operation;await client.query('commit');return {result};}
    catch(error) {await client.query('rollback');return {error};}
  }
  async function seedDirectoryRace(tag) {
    const f=await seed(db,tag);
    await db.query("update public.vendor_sourcing_jobs set state='waiting',lease_token=$2,lease_until=now()+interval '1 hour' where id=$1",[f.job,f.lease]);
    return f;
  }
  const responseSignature='public.vendor_quote_submit_response(text,integer,jsonb)';
  const canonicalResponse=(await scalar(db,'select pg_get_functiondef($1::regprocedure) as definition',[responseSignature])).definition;
  const responseService='  perform public.lock_vendor_service(c.work_order_id);';
  const responseDirectory='  perform public.lock_vendor_directory(c.vendor_directory_id);';
  assert.ok(canonicalResponse.includes(responseDirectory+'\n'+responseService));
  const legacyResponse=canonicalResponse.replace(responseDirectory+'\n'+responseService,responseService+'\n'+responseDirectory);
  const responseBody={laborCents:null,materialsCents:null,diagnosticFeeCents:null,scope:'',exclusions:'',durationMinutes:null,windows:[],question:''};
  const submit=async(client,f,p)=>(await scalar(client,'select public.vendor_quote_submit_response($1,1,$2::jsonb,$3::jsonb) as result',[f.sessionDigest,responseBody,p])).result;
  async function seedProofRace(tag,proofKind) {
    const f=await seedDirectoryRace(tag);
    if(proofKind==='response') {
      f.sessionDigest=createHash('sha256').update('session:'+f.cap).digest('hex');
      await db.query("insert into public.vendor_quote_contact_sessions(session_digest,capability_id,expires_at) values($1,$2,now()+interval '1 hour')",[f.sessionDigest,f.cap]);
    }
    return f;
  }
  for(const proofKind of ['consent','response']) {
    const invokeProof=proofKind==='consent'?consume:submit;
    const currentDefinition=proofKind==='consent'?canonicalDefinition:canonicalResponse;
    const oldDefinition=proofKind==='consent'?legacyDefinition:legacyResponse;
    const channel=proofKind==='consent'?'sms':'email';
    for(const [kind,operation] of Object.entries(directoryOperations)) {
      await db.query('delete from public.vendor_coordination_phone_bindings');
      const f=await seedProofRace('legacy-'+proofKind+'-'+kind,proofKind),p=await proof(db,f.cap,channel);
      await db.query(oldDefinition);
      await a.query('begin');await a.query('select public.lock_vendor_directory($1)',[f.directory]);
      await b.query('begin');const pendingProof=settleTransaction(b,invokeProof(b,f,p));
      await blockedOnAdvisory(bPid);
      const pendingOperation=settleTransaction(a,operation(a,f));
      const outcomes=await Promise.all([pendingProof,pendingOperation]);
      assert.ok(outcomes.some(outcome=>outcome.error?.code==='40P01'),'legacy '+proofKind+' order must reproduce a deadlock against '+kind);
      await db.query(currentDefinition);
      for(const order of ['operation-first','proof-first']) {
        await db.query('delete from public.vendor_coordination_phone_bindings');
        const current=await seedProofRace('canonical-'+proofKind+'-'+kind+'-'+order,proofKind),currentProof=await proof(db,current.cap,channel);
        await a.query('begin');
        if(order==='operation-first') {
          await operation(a,current);
          const pending=invokeProof(b,current,currentProof);await blockedOnAdvisory(bPid);
          await a.query('commit');const result=await pending;
          assert.ok(proofKind==='consent'?result===true:result.ok===true,kind+' operation-first '+proofKind);
        } else {
          const result=await invokeProof(a,current,currentProof);
          assert.ok(proofKind==='consent'?result===true:result.ok===true);
          const pending=operation(b,current).then(result=>({result}),error=>({error}));await blockedOnAdvisory(bPid);
          await a.query('commit');const outcome=await pending;
          if(kind==='sourcingEnrollment' && outcome.error) assert.match(outcome.error.message,/sourcing lease lost/);
          else assert.ok(outcome.result,kind+' proof-first operation');
          assert.notEqual(outcome.error?.code,'40P01');
        }
        const resultTable=proofKind==='consent'?'vendor_quote_sms_consent_events':'vendor_quote_responses';
        assert.equal((await scalar(db,`select count(*)::int as n from public.${resultTable} where capability_id=$1`,[current.cap])).n,1);
      }
    }
  }
  console.log(JSON.stringify({sharedWithoutNumber:'passed',migrationReapply:'passed',allDependencyTriggers:'passed',authSignInNoInvalidation:'passed',rollbackRevision:'passed',staleRevision:'rejected',expiredProof:'rejected',capabilityBinding:'passed',oldOverloads:'revoked',serviceGrants:'passed',redactedAtomicReceipt:'passed',duplicateSid:'idempotent',receiptFailureRollback:'passed',mutationBeforeGrant:'rejected',mutationAfterGrant:'40001 rollback then retry',stopBothOrders:'serialized',exactTimeBoundary:'rolled back',profileTupleContention:'40001 rollback',actualManagerApprovalBothOrders:'serialized',legacyDirectoryInversion:'consume and response40P01 reproduced against link and both enroll RPCs',canonicalDirectoryOrder:'consume and response versus all three RPCs both orders passed'}));
 } finally {if(a)await a.end();if(b)await b.end();if(db)await db.end();stopCluster(owned);}
}
await main();
