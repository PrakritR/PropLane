/** Disposable, real PostgreSQL proof for quote response, consent, and delivery transactions.
 * Run with VENDOR_QUOTE_LOCAL_POSTGRES=1. No external DATABASE_URL is accepted.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
if (process.env.VENDOR_QUOTE_LOCAL_POSTGRES !== "1" || process.env.DATABASE_URL) {
  throw new Error("Set VENDOR_QUOTE_LOCAL_POSTGRES=1 and unset DATABASE_URL; this runner creates its own loopback PostgreSQL cluster.");
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
async function main() {
 let owned,db;
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
  await db.query("insert into public.profile_roles values($1,'admin')",[OTHER]);
  const f=await seedF1(db,'quote-page');
  const workspace='44444444-4444-4444-8444-444444444444', requested='+13175550123', line='+13175550999';
  await db.query("insert into public.manager_property_records(id,manager_user_id,workspace_id) values('property-1',$1,$2)",[MANAGER,workspace]);
  await db.query("insert into public.manager_assistant_emails(workspace_id,manager_user_id,mailbox_local,inbox_token,provision_state) values($1,$2,'qa','abcdefgh','active')",[workspace,MANAGER]);
  await db.query("insert into public.manager_sms_numbers values($1,$2,$3,'MGqa','active',null)",[MANAGER,workspace,line]);
  await db.query("update public.vendor_coordination_proposals set status='collecting' where id=$1",[f.repair]);
  await db.query("update public.vendor_sourcing_candidates set local_directory_id=$2,proposal_id=$3 where id=$1",[f.candidate,f.directory,f.repair]);
  const snapshot={mode:'software',managerUserId:MANAGER,workspaceId:workspace,displayName:'QA Manager',legalName:'QA Manager',email:'qa@example.test',workPhone:line,messagingServiceSid:'MGqa',version:1};
  const cap=await scalar(db,`insert into public.vendor_quote_contact_capabilities(token_digest,token_nonce,purpose,manager_user_id,job_id,candidate_id,work_order_id,vendor_directory_id,proposal_id,recipient_email,sender_mode,sender_version,sender_snapshot,expires_at) values(repeat('a',64),repeat('c',64),'response',$1,$2,$3,$4,$5,$6,'vendor@example.test','software',1,$7,now()+interval '1 day') returning id`,[MANAGER,f.job,f.candidate,f.service,f.directory,f.repair,snapshot]);
  await db.query("insert into public.vendor_quote_contact_sessions(session_digest,capability_id,expires_at) values(repeat('b',64),$1,now()+interval '1 hour')",[cap.id]);
  const action={kind:'revise_quote',expected_version:1,source_message_id:'quote-1',duration_minutes:60,quote:{laborCents:10000,materialsCents:1000,consultationFeeCents:0,scope:'Repair sink',exclusions:''}};
  const result=await scalar(db,"select public.vendor_quote_capability_action(repeat('b',64),$1::jsonb) as result",[action]);
  assert.equal(result.result.labor_cents,10000);assert.equal(result.result.vendor_confirmed_revision,null);
  const replay=await scalar(db,"select public.vendor_quote_capability_action(repeat('b',64),$1::jsonb) as result",[action]);assert.equal(replay.result.version,result.result.version);
  await assert.rejects(db.query("select public.vendor_quote_capability_action(repeat('b',64),$1::jsonb)",[{...action,quote:{...action.quote,laborCents:20000}}]),/reused|stale/);
  for(const kind of ['confirm_vendor','approve_manager','enroll']) await assert.rejects(db.query("select public.vendor_quote_capability_action(repeat('b',64),$1::jsonb)",[{kind,expected_version:result.result.version}]),/not allowed/);
  await assert.rejects(db.query("select public.assign_vendor_outreach_mode($1,'managed',$2,'PropLane','PropLane','managed@example.test','+13175550099','MGtest')",[MANAGER,VENDOR]),/staff authorization/);
  await db.query('set role anon');await assert.rejects(db.query('select * from public.vendor_quote_contact_capabilities'),/permission denied/);await assert.rejects(db.query("select public.vendor_quote_capability_action(repeat('b',64),'{}')"),/permission denied/);await db.query('reset role');
  // Form responses are atomic and a replay cannot replace a prior response.
  const form={laborCents:15000,materialsCents:2000,diagnosticFeeCents:0,scope:'Replace pipe',exclusions:'',durationMinutes:60,windows:[],question:''};
  const saved=await scalar(db,"select public.vendor_quote_submit_response(repeat('b',64),$1,$2::jsonb) as result",[result.result.version,form]);
  const replayForm=await scalar(db,"select public.vendor_quote_submit_response(repeat('b',64),$1,$2::jsonb) as result",[result.result.version,form]);assert.equal(replayForm.result.idempotent,true);
  await assert.rejects(db.query("select public.vendor_quote_submit_response(repeat('b',64),$1,$2::jsonb)",[result.result.version,{...form,laborCents:1}]),/reused/);
  await db.query("update public.vendor_sourcing_jobs set state='quote_collected',lease_token=null,lease_until=null where id=$1",[f.job]);
  const partial={laborCents:null,materialsCents:null,diagnosticFeeCents:null,scope:'',exclusions:'',durationMinutes:null,windows:[],question:'What kind of pipe is it?'};
  const followUpStart=new Date(Date.now()+2*86400000),followUpEnd=new Date(followUpStart.getTime()+3600000);
  const postCollectionFollowup=await scalar(db,"select public.vendor_quote_submit_response(repeat('b',64),$1,$2::jsonb) as result",[saved.result.proposal.version,{...form,windows:[{startIso:followUpStart.toISOString(),endIso:followUpEnd.toISOString(),timeZone:'America/Los_Angeles'}],question:'Could you share dates?'}]);
  assert.ok(postCollectionFollowup.result.proposal.version>saved.result.proposal.version);
  assert.equal((await scalar(db,"select state from public.vendor_sourcing_jobs where id=$1",[f.job])).state,'quote_collected');
  const firstQuestion=await scalar(db,"select public.vendor_quote_submit_response(repeat('b',64),$1,$2::jsonb) as result",[postCollectionFollowup.result.proposal.version,partial]);
  const secondQuestion=await scalar(db,"select public.vendor_quote_submit_response(repeat('b',64),$1,$2::jsonb) as result",[firstQuestion.result.proposal.version,{...partial,question:'Can the manager clarify the pipe size?'}]);assert.ok(secondQuestion.result.proposal.version>firstQuestion.result.proposal.version);
  // A blank diagnostic fee stays unknown, yet every accepted partial advances
  // the request version so the vendor can correct it without a reload/replay trap.
  const missingFee={...form,laborCents:19000,diagnosticFeeCents:null};
  const missingFeeNoWindow=await scalar(db,"select public.vendor_quote_submit_response(repeat('b',64),$1,$2::jsonb) as result",[secondQuestion.result.proposal.version,missingFee]);
  assert.ok(missingFeeNoWindow.result.proposal.version>secondQuestion.result.proposal.version);
  assert.equal(missingFeeNoWindow.result.response.diagnosticFeeCents,null);
  assert.equal(missingFeeNoWindow.result.proposal.labor_cents,missingFee.laborCents);
  assert.equal(missingFeeNoWindow.result.proposal.consultation_fee_cents,null);
  assert.equal(missingFeeNoWindow.result.proposal.vendor_windows.length,0);
  const fixedFee=await scalar(db,"select public.vendor_quote_submit_response(repeat('b',64),$1,$2::jsonb) as result",[missingFeeNoWindow.result.proposal.version,form]);
  assert.ok(fixedFee.result.proposal.version>missingFeeNoWindow.result.proposal.version);
  assert.equal(fixedFee.result.proposal.consultation_fee_cents,0);
  const start=new Date(Date.now()+86400000),end=new Date(start.getTime()+3600000);
  const feeWithWindow={...missingFee,windows:[{startIso:start.toISOString(),endIso:end.toISOString(),timeZone:'America/Los_Angeles'}]};
  const missingFeeWindow=await scalar(db,"select public.vendor_quote_submit_response(repeat('b',64),$1,$2::jsonb) as result",[fixedFee.result.proposal.version,feeWithWindow]);
  assert.ok(missingFeeWindow.result.proposal.version>fixedFee.result.proposal.version);
  assert.equal(missingFeeWindow.result.response.diagnosticFeeCents,null);
  assert.equal(missingFeeWindow.result.proposal.labor_cents,missingFeeWindow.result.response.laborCents);
  assert.equal(missingFeeWindow.result.proposal.consultation_fee_cents,null);
  assert.equal(missingFeeWindow.result.proposal.vendor_windows.length,1);
  const fixedFeeWindow=await scalar(db,"select public.vendor_quote_submit_response(repeat('b',64),$1,$2::jsonb) as result",[missingFeeWindow.result.proposal.version,{...feeWithWindow,diagnosticFeeCents:0}]);
  assert.ok(fixedFeeWindow.result.proposal.version>missingFeeWindow.result.proposal.version);
  await db.query("update public.vendor_coordination_proposals set vendor_confirmed_revision=quote_revision,resident_confirmed_revision=quote_revision,status='ready' where id=$1",[f.repair]);
  const clearAll={...form,laborCents:null,materialsCents:null,diagnosticFeeCents:null,scope:'',exclusions:'',durationMinutes:null,windows:[],question:''};
  const cleared=await scalar(db,"select public.vendor_quote_submit_response(repeat('b',64),$1,$2::jsonb) as result",[fixedFeeWindow.result.proposal.version,clearAll]);
  assert.equal(cleared.result.proposal.labor_cents,null);assert.equal(cleared.result.proposal.materials_cents,null);assert.equal(cleared.result.proposal.consultation_fee_cents,null);
  assert.equal(cleared.result.proposal.scope,null);assert.equal(cleared.result.proposal.duration_minutes,null);assert.equal(cleared.result.proposal.vendor_windows.length,0);
  assert.equal(cleared.result.proposal.vendor_confirmed_revision,null);assert.equal(cleared.result.proposal.resident_confirmed_revision,null);assert.equal(cleared.result.proposal.status,'collecting');
  assert.equal((await scalar(db,"select public.vendor_sourcing_has_viable_quote($1,$2) as viable",[f.service,MANAGER])).viable,false);
  assert.equal((await scalar(db,"select state from public.vendor_sourcing_jobs where id=$1",[f.job])).state,'queued');
  const corrected=await scalar(db,"select public.vendor_quote_submit_response(repeat('b',64),$1,$2::jsonb) as result",[cleared.result.proposal.version,{...form,windows:fixedFeeWindow.result.response.windows}]);
  assert.ok(corrected.result.proposal.version>cleared.result.proposal.version);
  assert.equal((await scalar(db,"select public.vendor_sourcing_has_viable_quote($1,$2) as viable",[f.service,MANAGER])).viable,true);
  await db.query("select public.append_vendor_quote_inbox($1,'page-message-1','Exact quote submitted','portal','Oct 18, 3:00 PM')",[cap.id]);
  await db.query("select public.append_vendor_quote_inbox($1,'page-message-1','Exact quote submitted','portal','Oct 18, 3:00 PM')",[cap.id]);
  const thread=await scalar(db,"select row_data from public.portal_inbox_thread_records where id=$1",[`vendor_quote_${f.service}_${f.directory}`]);assert.equal(thread.row_data.messages.length,1);assert.equal(thread.row_data.recordRef.id,f.service);
  // A durable fold deletes the service row. Its alias is a storage pointer,
  // while the capability remains the source of owner, recipient and service authority.
  const logicalQuote=`vendor_quote_${f.service}_${f.directory}`, canonicalQuote='canonical-quote-person';
  await db.query("insert into public.portal_inbox_thread_records select $1,scope,owner_user_id,participant_email,thread_type,workspace_id,row_data||jsonb_build_object('id',$1::text,'subject','Existing person subject','from','Existing person','folder','sent'),updated_at from public.portal_inbox_thread_records where id=$2",[canonicalQuote,logicalQuote]);
  await db.query("insert into public.portal_inbox_thread_aliases values($1,$2)",[logicalQuote,canonicalQuote]);
  await db.query("delete from public.portal_inbox_thread_records where id=$1",[logicalQuote]);
  const appendAlias=async(id=cap.id,message='alias-message-1')=>db.query("select public.append_vendor_quote_inbox($1,$2,'Alias reply','email','Nov 4, 10:00 AM')",[id,message]);
  await appendAlias(); await appendAlias();
  const canonical=await scalar(db,"select row_data,workspace_id from public.portal_inbox_thread_records where id=$1",[canonicalQuote]);
  assert.equal(canonical.row_data.subject,'Existing person subject'); assert.equal(canonical.row_data.from,'Existing person'); assert.equal(canonical.row_data.folder,'sent');
  assert.equal(canonical.workspace_id,workspace); assert.equal(canonical.row_data.messages.length,2);
  const aliasTurn=canonical.row_data.messages.find(m=>m.id==='alias-message-1');
  assert.equal(aliasTurn.recordRef.id,f.service); assert.equal(aliasTurn.houseId,'property-1'); assert.equal(aliasTurn.quoteCapabilityId,cap.id);
  assert.equal((await scalar(db,"select count(*)::int as n from public.portal_inbox_thread_records where id=$1",[logicalQuote])).n,0);
  const second=await seedF1(db,'alias-second');
  const secondCap=await scalar(db,`insert into public.vendor_quote_contact_capabilities(token_digest,token_nonce,purpose,manager_user_id,job_id,candidate_id,work_order_id,vendor_directory_id,proposal_id,recipient_email,sender_mode,sender_version,sender_snapshot,expires_at) values(repeat('8',64),repeat('9',64),'response',$1,$2,$3,$4,$5,$6,'vendor@example.test','software',1,$7,now()+interval '1 day') returning id`,[MANAGER,second.job,second.candidate,second.service,second.directory,second.repair,snapshot]);
  await db.query("insert into public.portal_inbox_thread_aliases values($1,$2)",[`vendor_quote_${second.service}_${second.directory}`,canonicalQuote]);
  await appendAlias(secondCap.id,'alias-second-message');
  const both=await scalar(db,"select row_data from public.portal_inbox_thread_records where id=$1",[canonicalQuote]);
  assert.deepEqual(both.row_data.quoteReplySources.map(source=>source.threadId).sort(),[logicalQuote,`vendor_quote_${second.service}_${second.directory}`].sort());
  assert.equal(both.row_data.recordRef.id,f.service); assert.equal(both.row_data.messages.at(-1).recordRef.id,second.service);
  for(const [column,value] of [['owner_user_id',OTHER],['workspace_id','55555555-5555-4555-8555-555555555555']]) {
    await db.query(`update public.portal_inbox_thread_records set ${column}=$1 where id=$2`,[value,canonicalQuote]);
    await assert.rejects(appendAlias(cap.id,`reject-${column}`),/quote conversation unavailable/);
    await db.query(`update public.portal_inbox_thread_records set ${column}=$1 where id=$2`,[column==='owner_user_id'?MANAGER:workspace,canonicalQuote]);
  }
  await db.query("update public.portal_inbox_thread_records set row_data=jsonb_set(row_data,'{email}','\"wrong@example.test\"') where id=$1",[canonicalQuote]);
  await assert.rejects(appendAlias(cap.id,'reject-recipient'),/quote conversation unavailable/);
  await db.query("update public.portal_inbox_thread_records set row_data=jsonb_set(row_data,'{email}','\"vendor@example.test\"') where id=$1",[canonicalQuote]);
  await db.query("insert into public.manager_property_records values('assigned-property',$1,'55555555-5555-4555-8555-555555555555')",[MANAGER]);
  await db.query("update public.portal_work_order_records set assigned_property_id='assigned-property' where id=$1",[f.service]);
  await assert.rejects(appendAlias(cap.id,'reject-assigned-workspace'),/quote conversation unavailable/);
  await db.query("update public.portal_work_order_records set assigned_property_id=null where id=$1",[f.service]);
  await db.query("update public.portal_inbox_thread_aliases set thread_id='missing-canonical' where alias_id=$1",[logicalQuote]);
  await assert.rejects(appendAlias(cap.id,'reject-missing'),/quote conversation unavailable/);
  await db.query("update public.portal_inbox_thread_aliases set thread_id=$2 where alias_id=$1",[logicalQuote,canonicalQuote]);
  // Correct signed-inbound challenge: wrong phone/line/code fail, and the exact
  // scope grants once while updating only the manager directory and candidate.
  await db.query("update public.vendor_quote_contact_capabilities set sender_snapshot=$2 where id=$1",[cap.id,snapshot]);
  await db.query("update public.vendor_sourcing_jobs set state='quote_collected' where id=$1",[f.job]);
  const version=corrected.result.proposal.version;
  const challenge=await scalar(db,`insert into public.vendor_quote_sms_consent_challenges(capability_id,manager_user_id,candidate_id,vendor_directory_id,proposal_id,requested_phone,work_phone,messaging_service_sid,sender_version,proposal_version,code_digest,wording_version,expires_at) values($1,$2,$3,$4,$5,$6,$7,'MGqa',1,$8,repeat('d',64),'vendor_quote_sms_v1',now()+interval '10 minutes') returning id`,[cap.id,MANAGER,f.candidate,f.directory,f.repair,requested,line,version]);
  const insertChallenge=async(char) => scalar(db,`insert into public.vendor_quote_sms_consent_challenges(capability_id,manager_user_id,candidate_id,vendor_directory_id,proposal_id,requested_phone,work_phone,messaging_service_sid,sender_version,proposal_version,code_digest,wording_version,expires_at) values($1,$2,$3,$4,$5,$6,$7,'MGqa',1,$8,repeat($9,64),'vendor_quote_sms_v1',now()+interval '10 minutes') returning id`,[cap.id,MANAGER,f.candidate,f.directory,f.repair,requested,line,version,char]);
  const attemptChallenge=async(id,char,event) => (await scalar(db,"select public.consume_vendor_quote_sms_challenge($1,$2,$3,$4,'MGqa',$5) as granted",[id,char.repeat(64),requested,line,event])).granted;
  const consume=async(phone=requested,to=line,digest='d'.repeat(64),sid='SMproof') => (await scalar(db,"select public.consume_vendor_quote_sms_challenge($1,$2,$3,$4,'MGqa',$5) as granted",[challenge.id,digest,phone,to,sid])).granted;
  assert.equal(await consume('+13175550124'),false);assert.equal(await consume(requested,'+13175550998'),false);assert.equal(await consume(requested,line,'e'.repeat(64)),false);
  const staleProbe=async(char,change,restore,event) => { const next=await insertChallenge(char); await db.query(change); assert.equal(await attemptChallenge(next.id,char,event),false); await db.query(restore); };
  await staleProbe('1',"update public.profiles set full_name='Changed Manager' where id='11111111-1111-4111-8111-111111111111'","update public.profiles set full_name='QA Manager' where id='11111111-1111-4111-8111-111111111111'",'stale-name');
  await staleProbe('2',"update public.manager_assistant_emails set mailbox_local='changed' where manager_user_id='11111111-1111-4111-8111-111111111111'","update public.manager_assistant_emails set mailbox_local='qa' where manager_user_id='11111111-1111-4111-8111-111111111111'",'stale-mailbox');
  await staleProbe('3',"update public.manager_property_records set workspace_id='55555555-5555-4555-8555-555555555555' where id='property-1'","update public.manager_property_records set workspace_id='44444444-4444-4444-8444-444444444444' where id='property-1'",'stale-workspace');
  await staleProbe('4',"update public.manager_sms_numbers set phone_number='+13175550098' where manager_user_id='11111111-1111-4111-8111-111111111111'","update public.manager_sms_numbers set phone_number='+13175550999' where manager_user_id='11111111-1111-4111-8111-111111111111'",'stale-line');
  await staleProbe('5',"insert into public.vendor_outreach_workspace_profiles(manager_user_id,mode,managed_display_name,managed_legal_name,managed_email,managed_work_phone,managed_messaging_service_sid,version) values('11111111-1111-4111-8111-111111111111','managed','Managed QA','Managed QA LLC','managed@example.test','+13175550999','MGqa',2)","delete from public.vendor_outreach_workspace_profiles where manager_user_id='11111111-1111-4111-8111-111111111111'",'stale-mode');
  const concurrentChallenge=await insertChallenge('6');
  const blocker=await connect(owned,'postgres'),observer=await connect(owned,'postgres');
  let pendingConsume;
  try {
    await blocker.query('begin');
    await blocker.query("update public.profiles set full_name='Concurrent Change' where id=$1",[MANAGER]);
    const backend=await scalar(db,'select pg_backend_pid() as pid');
    pendingConsume=db.query("select public.consume_vendor_quote_sms_challenge($1,$2,$3,$4,'MGqa','concurrent-name') as granted",[concurrentChallenge.id,'6'.repeat(64),requested,line]);
    let blocked=false;
    for(let i=0;i<40;i++) {
      const activity=await scalar(observer,"select wait_event_type from pg_stat_activity where pid=$1",[backend.pid]);
      if(activity?.wait_event_type==='Lock') { blocked=true; break; }
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    assert.equal(blocked,true,'challenge consume should wait for the sender identity row lock');
    await blocker.query('commit');
    assert.equal((await pendingConsume).rows[0].granted,false);
    await db.query("update public.profiles set full_name='QA Manager' where id=$1",[MANAGER]);
  } finally {
    await blocker.query('rollback').catch(()=>{});
    if(pendingConsume) await Promise.resolve(pendingConsume).catch(()=>{});
    await blocker.end(); await observer.end();
  }
  const freshChallenge=await insertChallenge('7');
  assert.equal(await attemptChallenge(freshChallenge.id,'7','SMfresh'),true);
  assert.equal(await attemptChallenge(freshChallenge.id,'7','SMfresh-replay'),false);
  const grant=await scalar(db,"select event_type,evidence from public.sms_consent_events where source='verified_vendor_quote_inbound_challenge'");assert.equal(grant.event_type,'granted');assert.equal(grant.evidence.candidateId,f.candidate);
  assert.equal((await scalar(db,"select row_data->>'phone' as phone from public.manager_vendor_records where id=$1",[f.directory])).phone,requested);
  assert.equal((await scalar(db,"select state from public.vendor_sourcing_jobs where id=$1",[f.job])).state,'quote_collected');
  const vendorSession=await scalar(db,"select landlord_id,user_id,kind,vendor_directory_id,work_order_id,vendor_phone_e164,status from public.agent_sessions where work_order_id=$1 and vendor_directory_id=$2",[f.service,f.directory]);
  assert.equal(vendorSession.landlord_id,MANAGER);assert.equal(vendorSession.user_id,null);assert.equal(vendorSession.kind,'vendor_work_order');
  assert.equal(vendorSession.vendor_phone_e164,requested);assert.equal(vendorSession.status,'active');
  // STOP must win before a new challenge can grant the number again.
  const stoppedChallenge=await scalar(db,`insert into public.vendor_quote_sms_consent_challenges(capability_id,manager_user_id,candidate_id,vendor_directory_id,proposal_id,requested_phone,work_phone,messaging_service_sid,sender_version,proposal_version,code_digest,wording_version,expires_at) values($1,$2,$3,$4,$5,$6,$7,'MGqa',1,$8,repeat('f',64),'vendor_quote_sms_v1',now()+interval '10 minutes') returning id`,[cap.id,MANAGER,f.candidate,f.directory,f.repair,requested,line,version]);
  await db.query("update public.sms_consent set opted_out_at=now() where phone=$1",[requested.replace(/^\+1/,'')]);
  const stopped=await scalar(db,"select public.consume_vendor_quote_sms_challenge($1,repeat('f',64),$2,$3,'MGqa','SMstopped') as granted",[stoppedChallenge.id,requested,line]);assert.equal(stopped.granted,false);
  // Sender changes invalidate existing capabilities and their challenges.
  await db.query("update public.vendor_outreach_workspace_profiles set version=version+1 where manager_user_id=$1",[MANAGER]);
  // Lease-bound email delivery cannot finalize through an old worker token.
  await db.query("insert into public.manager_automation_settings(manager_user_id,vendor_dispatch) values($1,'{\"quoteSourcingEnabled\":true}') on conflict(manager_user_id) do update set vendor_dispatch=excluded.vendor_dispatch",[MANAGER]);
  await db.query("update public.vendor_sourcing_candidates set source='web',contact=contact||'{\"email\":\"vendor@example.test\",\"emailEvidence\":{\"version\":1}}'::jsonb where id=$1",[f.candidate]);
  await db.query("update public.vendor_sourcing_jobs set state='sourcing',lease_token=$2,lease_until=now()+interval '1 hour' where id=$1",[f.job,f.lease]);
  const claimed=await scalar(db,"select to_jsonb(public.claim_vendor_quote_email_outbox($1,$2,$3,'vendor@example.test','sender-qa',1,1,repeat('a',64),'quote-qa')) as result",[f.candidate,f.lease,cap.id]);
  assert.equal(claimed.result.status,'submitting');
  assert.equal((await scalar(db,"select public.authorize_vendor_quote_email_outbox($1,$2) as authorized",[claimed.result.id,claimed.result.lease_token])).authorized,true);
  assert.equal((await scalar(db,"select public.finish_vendor_quote_email_outbox($1,$2,'accepted','provider-id',null) as finished",[claimed.result.id,randomUUID()])).finished,false);
  assert.equal((await scalar(db,"select public.finish_vendor_quote_email_outbox($1,$2,'unknown',null,'timeout') as finished",[claimed.result.id,claimed.result.lease_token])).finished,true);
  const retry=await scalar(db,"select to_jsonb(public.claim_vendor_quote_email_outbox($1,$2,$3,'vendor@example.test','sender-qa',1,1,repeat('a',64),'quote-qa')) as result",[f.candidate,f.lease,cap.id]);assert.notEqual(retry.result.lease_token,claimed.result.lease_token);
  assert.equal((await scalar(db,"select public.finish_vendor_quote_email_outbox($1,$2,'accepted','late-provider-id',null) as finished",[claimed.result.id,claimed.result.lease_token])).finished,false);
  // Inject failures at each boundary inside the real RPC. Neither the receipt
  // nor the outbox change may survive; identical retries must apply suppression.
  await db.query("update public.vendor_quote_email_outbox set status='accepted',provider_message_id='provider-callback' where id=$1",[claimed.result.id]);
  const callback=(event,kind='bounced')=>scalar(db,"select public.apply_vendor_quote_email_delivery_event($1,'provider-callback',$2,'2026-10-18T12:00:00Z') as handled",[event,kind]);
  await db.query('set role anon');
  await assert.rejects(callback('forbidden'),/permission denied/);
  await db.query('reset role');
  await db.query('set role service_role');
  assert.equal((await scalar(db,"select public.apply_vendor_quote_email_delivery_event('service-role-check','unknown-provider','bounced',now()) as handled")).handled,false);
  await db.query('reset role');
  for(const boundary of ['outbox','suppression']) {
    const event=`callback-failure-${boundary}`;
    await db.query("update public.vendor_quote_email_outbox set status='accepted' where id=$1",[claimed.result.id]);
    await db.query(`create function public.fail_quote_callback_test() returns trigger language plpgsql as $$begin raise exception 'injected callback failure'; end$$`);
    const table=boundary==='outbox'?'vendor_quote_email_outbox':'vendor_quote_email_permissions';
    const operation=boundary==='outbox'?'update':'insert';
    await db.query(`create trigger quote_callback_test_failure before ${operation} on public.${table} for each row execute function public.fail_quote_callback_test()`);
    await assert.rejects(callback(event,boundary==='outbox'?'bounced':'complained'),/injected callback failure/);
    assert.equal((await scalar(db,"select count(*)::int as count from public.vendor_quote_email_delivery_events where event_id=$1",[event])).count,0);
    assert.equal((await scalar(db,"select status from public.vendor_quote_email_outbox where id=$1",[claimed.result.id])).status,'accepted');
    assert.equal((await scalar(db,"select count(*)::int as count from public.vendor_quote_email_permissions where event_id=$1",[`provider:${event}`])).count,0);
    await db.query(`drop trigger quote_callback_test_failure on public.${table}; drop function public.fail_quote_callback_test()`);
    assert.equal((await callback(event,boundary==='outbox'?'bounced':'complained')).handled,true);
    assert.equal((await callback(event,boundary==='outbox'?'bounced':'complained')).handled,true);
    assert.equal((await scalar(db,"select count(*)::int as count from public.vendor_quote_email_delivery_events where event_id=$1",[event])).count,1);
    assert.equal((await scalar(db,"select count(*)::int as count from public.vendor_quote_email_permissions where event_id=$1 and sender_key='*' and active",[`provider:${event}`])).count,1);
    assert.equal((await scalar(db,"select status from public.vendor_quote_email_outbox where id=$1",[claimed.result.id])).status,'suppressed');
  }
  assert.equal((await callback('late-delivered','delivered')).handled,true);
  assert.equal((await scalar(db,"select status from public.vendor_quote_email_outbox where id=$1",[claimed.result.id])).status,'suppressed');
  await assert.rejects(callback('late-delivered','bounced'),/replay changed/);
  assert.equal((await scalar(db,"select public.apply_vendor_quote_email_delivery_event('unknown','unknown-provider','bounced',now()) as handled")).handled,false);
  // Previously committed receipt-only callbacks must be recoverable too.
  await db.query("insert into public.vendor_quote_email_delivery_events(event_id,outbox_id,provider_message_id,event_kind,occurred_at) values('legacy-partial',$1,'provider-callback','bounced','2026-10-18T12:00:00Z')",[claimed.result.id]);
  assert.equal((await callback('legacy-partial')).handled,true);
  assert.equal((await scalar(db,"select count(*)::int as count from public.vendor_quote_email_permissions where event_id='provider:legacy-partial' and active")).count,1);
  const acceptedBid=await scalar(db,"insert into public.work_order_bids(work_order_id,manager_user_id,vendor_directory_id,amount_cents,status) values($1,$2,$3,12345,'accepted') returning id",[f.service,MANAGER,f.directory]);
  await db.query("update public.vendor_coordination_proposals set accepted_bid_id=$2 where id=$1",[f.repair,acceptedBid.id]);
  await assert.rejects(db.query("select public.vendor_quote_submit_response(repeat('b',64),$1,$2::jsonb)",[corrected.result.proposal.version,{...form,laborCents:1}]),/stale or closed/);
  assert.equal((await scalar(db,"select amount_cents from public.work_order_bids where id=$1",[acceptedBid.id])).amount_cents,12345);
  await db.query("update public.vendor_coordination_proposals set manager_takeover=true where id=$1",[f.repair]);
  await assert.rejects(db.query("select public.vendor_quote_capability_action(repeat('b',64),$1::jsonb)",[{kind:'record_question',expected_version:version,question:'Can you describe it?'}]),/unavailable/);
  console.log(JSON.stringify({migration:'applied',quoteWithoutSms:'passed',identicalReplay:'passed',changedReplay:'rejected',bookingAuthority:'rejected',unauthorizedStaff:'rejected',anonymousReadAndRpc:'rejected',takeover:'rejected',acceptedBidImmutable:'passed',formReplay:'passed',repeatedQuestions:'passed',quoteCollectedConversation:'passed',replacementClearsCanonical:'passed',inboxDedupe:'passed',canonicalAliasIngress:'passed',aliasOwnerRecipientWorkspace:'rejected',phoneChallenge:'passed',canonicalScopedConsent:'passed',priorStop:'rejected',outboxLeaseFence:'passed',nullDiagnosticFeeEdits:'passed',callbackFailureRollbackReplay:'passed',callbackMonotonicity:'passed',legacyPartialCallbackRecovery:'passed'}));
 } finally { if(db)await db.end();stopCluster(owned); }
}
await main();
