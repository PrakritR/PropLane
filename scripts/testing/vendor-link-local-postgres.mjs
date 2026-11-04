/** Disposable, real PostgreSQL proof for directory account attachment races.
 * Run with VENDOR_LINK_LOCAL_POSTGRES=1. No external DATABASE_URL is accepted.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
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
if (process.env.VENDOR_LINK_LOCAL_POSTGRES !== "1" || process.env.DATABASE_URL) {
  throw new Error("Set VENDOR_LINK_LOCAL_POSTGRES=1 and unset DATABASE_URL; this runner creates its own loopback PostgreSQL cluster.");
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
  const dir = mkdtempSync(join(tmpdir(), "vendor-link-pg-"));
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
create table public.profiles(id uuid primary key references auth.users(id),phone text,phone_verified_at timestamptz,email text);
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
  await db.query("insert into public.profiles(id,email,phone,phone_verified_at) values($1,'manager@example.test','+13175550001',now()),($2,'vendor@example.test','+13175550002',now()),($3,'other@example.test',null,null)", [MANAGER, VENDOR, OTHER]);
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
async function seedBooking(db, tag) {
  const directory = `dir-${tag}`;
  const service = `svc-${tag}`;
  await db.query("insert into public.manager_vendor_records(id,manager_user_id,row_data) values($1,$2,$3)", [directory, MANAGER, { name: "Booked vendor", email: "vendor@example.test", phone: "+13175550002", active: true }]);
  await db.query("insert into public.portal_work_order_records(id,manager_user_id,resident_email,property_id,row_data) values($1,$2,$3,'property-1',$4)", [service, MANAGER, `${tag}@resident.test`, { bucket: "open", title: "Booked repair", vendorId: directory }]);
  const bid = await scalar(db, "insert into public.work_order_bids(work_order_id,manager_user_id,vendor_directory_id,amount_cents,materials_cents,status) values($1,$2,$3,11000,3000,'accepted') returning id", [service, MANAGER, directory]);
  const start = new Date(Date.now() + (tag === "calendar-rollback" ? 30 : 7) * 86400_000);
  const proposal = await scalar(db, `insert into public.vendor_coordination_proposals(work_order_id,manager_user_id,vendor_directory_id,visit_type,status,version,quote_revision,scope,labor_cents,materials_cents,consultation_fee_cents,duration_minutes,selected_start_at,accepted_bid_id)
    values($1,$2,$3,'repair','approved',2,1,'Booked repair',11000,3000,0,60,$4,$5) returning id`, [service, MANAGER, directory, start, bid.id]);
  const reservation = await scalar(db, `insert into public.vendor_coordination_reservations(proposal_id,work_order_id,manager_user_id,vendor_directory_id,vendor_phone_e164,starts_at,ends_at,status)
    values($1,$2,$3,$4,'+13175550002',$5,$5::timestamptz+interval '1 hour','active') returning id`, [proposal.id, service, MANAGER, directory, start]);
  return { directory, service, proposal: proposal.id, reservation: reservation.id, bid: bid.id };
}
async function waitBlocked(observer, waiterPid, holderPid, label, expectedNamespace) {
  const until = Date.now() + 6000;
  while (Date.now() < until) {
    const row = await scalar(observer, `select a.wait_event_type,a.wait_event,l.locktype,l.classid::integer as classid,pg_blocking_pids(a.pid) as blockers
      from pg_stat_activity a join pg_locks l on l.pid=a.pid and not l.granted where a.pid=$1 limit 1`, [waiterPid]);
    if (row?.blockers?.includes(holderPid) && row.wait_event_type === "Lock" && (!expectedNamespace || row.classid === expectedNamespace)) return row;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  throw new Error(`${label}: did not observe exact blocking edge ${waiterPid} -> ${holderPid}`);
}
async function identity(db, f) { return db.query("select public.link_vendor_directory_account($1,$2,$3) as result", [f.directory, MANAGER, VENDOR]); }
async function enroll(db, f) { return db.query("select public.enroll_vendor_sourcing_candidate($1,$2) as result", [f.candidate, f.lease]); }
async function directEnroll(db, f) { return db.query("select public.vendor_coordination_action($1::jsonb) as result", [{ kind: "enroll", work_order_id: f.service, vendor_directory_id: f.directory, manager_user_id: MANAGER, actor_user_id: MANAGER, visit_type: "repair" }]); }
async function cancel(db, f) { return db.query("select public.vendor_coordination_action($1::jsonb) as result", [{ kind: "cancel", proposal_id: f.proposal, expected_version: 2, actor_user_id: MANAGER }]); }
async function begin(db) { await db.query("begin"); await db.query("set local statement_timeout='12s'"); await db.query("set local lock_timeout='8s'"); }
async function outcome(promise) { try { await promise; return { code: "00000" }; } catch (error) { return { code: error.code ?? "UNKNOWN", message: error.message }; } }

async function baselineDeadlock(owned, admin) {
  const f = await seedF1(admin, "baseline");
  const a = await connect(owned, "postgres");
  const b = await connect(owned, "postgres");
  try {
    await begin(b);
    await b.query("select public.lock_vendor_service($1)", [f.service]);
    await b.query("select id from public.vendor_sourcing_jobs where id=$1 for update", [f.job]);
    await begin(a);
    const apid = (await scalar(a, "select pg_backend_pid() as pid")).pid;
    const bpid = (await scalar(b, "select pg_backend_pid() as pid")).pid;
    const linked = outcome(a.query("update public.manager_vendor_records set vendor_user_id=$1 where id=$2", [VENDOR, f.directory]));
    const first = await waitBlocked(admin, apid, bpid, "baseline link waits on job", null);
    assert.notEqual(first.locktype, "advisory", "baseline must reach a row/transaction wait inside the trigger");
    const enrolled = outcome(enroll(b, f));
    const both = await Promise.all([linked, enrolled]);
    assert.ok(both.some((x) => x.code === "40P01"), `baseline failed to reproduce PostgreSQL deadlock: ${JSON.stringify(both)}`);
    await a.query("rollback"); await b.query("rollback");
    console.log(JSON.stringify({ scenario: "exact-F1-baseline", sqlstates: both.map((x) => x.code), firstWait: first.wait_event, result: "reproduced" }));
  } finally { await a.query("rollback").catch(() => {}); await b.query("rollback").catch(() => {}); await a.end(); await b.end(); }
}

async function fixedRace(owned, admin, label, f, first, second, boundary, verify) {
  const a = await connect(owned, "postgres");
  const b = await connect(owned, "postgres");
  try {
    await begin(a); await begin(b);
    for (const item of boundary) await a.query(`select public.${item.kind === "directory" ? "lock_vendor_directory" : "lock_vendor_service"}($1)`, [item.id]);
    const apid = (await scalar(a, "select pg_backend_pid() as pid")).pid;
    const bpid = (await scalar(b, "select pg_backend_pid() as pid")).pid;
    const waiting = outcome(second(b, f));
    const edge = await waitBlocked(admin, bpid, apid, label, boundary.at(-1).kind === "directory" ? 161501 : 161500);
    assert.equal(edge.locktype, "advisory");
    const held = await outcome(first(a, f));
    assert.equal(held.code, "00000", `${label}: holder ${JSON.stringify(held)}`);
    await a.query("commit");
    const contender = await waiting;
    assert.equal(contender.code, "00000", `${label}: contender ${JSON.stringify(contender)}`);
    await b.query("commit");
    await verify(admin, f);
    console.log(JSON.stringify({ scenario: label, sqlstates: [held.code, contender.code], waitNamespace: edge.classid, result: "passed" }));
  } finally { await a.query("rollback").catch(() => {}); await b.query("rollback").catch(() => {}); await a.end(); await b.end(); }
}
async function verifyF1(db, f) {
  const d = await scalar(db, "select vendor_user_id from public.manager_vendor_records where id=$1", [f.directory]);
  const rows = await db.query("select visit_type,status,vendor_user_id,version,quote_revision from public.vendor_coordination_proposals where work_order_id=$1", [f.service]);
  const job = await scalar(db, "select state,stage,lease_token from public.vendor_sourcing_jobs where id=$1", [f.job]);
  const offer = await scalar(db, "select count(*)::int as n,min(vendor_user_id::text) as vendor from public.work_order_vendor_offers where work_order_id=$1", [f.service]);
  const candidate = await scalar(db, "select local_directory_id,proposal_id,status from public.vendor_sourcing_candidates where id=$1", [f.candidate]);
  assert.equal(d.vendor_user_id, VENDOR);
  assert.equal(rows.rowCount, 2);
  assert.deepEqual(rows.rows.map((r) => [r.visit_type, r.status]).sort(), [["consultation", "collecting"], ["repair", "cancelled"]]);
  assert.ok(rows.rows.every((r) => r.vendor_user_id === VENDOR));
  assert.ok(rows.rows.every((r) => r.version === 1 && r.quote_revision === 0));
  const cents = await scalar(db, "select labor_cents,materials_cents,consultation_fee_cents from public.vendor_coordination_proposals where id=$1", [f.repair]);
  assert.deepEqual(cents, { labor_cents: 10000, materials_cents: 2000, consultation_fee_cents: 0 });
  assert.equal(job.state, "waiting"); assert.equal(job.stage, 1); assert.equal(job.lease_token, f.lease);
  assert.equal(offer.n, 1); assert.equal(offer.vendor, VENDOR);
  assert.equal(candidate.local_directory_id, f.directory); assert.equal(candidate.proposal_id, f.repair);
  assert.equal(candidate.status, "discovered");
}
async function verifyDirect(db, f) {
  const d = await scalar(db, "select vendor_user_id from public.manager_vendor_records where id=$1", [f.directory]);
  const p = await db.query("select visit_type,status,vendor_user_id,version,quote_revision from public.vendor_coordination_proposals where work_order_id=$1", [f.service]);
  const c = await scalar(db, "select local_directory_id,proposal_id,status from public.vendor_sourcing_candidates where id=$1", [f.candidate]);
  const j = await scalar(db, "select state,lease_token from public.vendor_sourcing_jobs where id=$1", [f.job]);
  const o = await scalar(db, "select count(*)::int as n,min(vendor_user_id::text) as vendor from public.work_order_vendor_offers where work_order_id=$1", [f.service]);
  assert.equal(d.vendor_user_id, VENDOR);
  assert.equal(p.rowCount, 2);
  assert.deepEqual(p.rows.map((r) => [r.visit_type, r.status]).sort(), [["consultation", "collecting"], ["repair", "cancelled"]]);
  assert.ok(p.rows.every((r) => r.vendor_user_id === VENDOR && r.version === 1 && r.quote_revision === 0));
  assert.deepEqual(c, { local_directory_id: null, proposal_id: null, status: "discovered" });
  assert.deepEqual(j, { state: "waiting", lease_token: f.lease });
  assert.deepEqual(o, { n: 1, vendor: VENDOR });
}
async function verifyBooking(db, f) {
  const p = await scalar(db, "select status,vendor_user_id,accepted_bid_id from public.vendor_coordination_proposals where id=$1", [f.proposal]);
  const r = await scalar(db, "select status,vendor_user_id from public.vendor_coordination_reservations where id=$1", [f.reservation]);
  const bid = await scalar(db, "select status,amount_cents,materials_cents,vendor_user_id from public.work_order_bids where id=$1", [f.bid]);
  assert.equal(p.status, "cancelled"); assert.equal(p.vendor_user_id, VENDOR); assert.equal(p.accepted_bid_id, f.bid);
  assert.equal(r.status, "cancelled"); assert.equal(r.vendor_user_id, VENDOR);
  assert.deepEqual([bid.status, bid.amount_cents, bid.materials_cents, bid.vendor_user_id], ["accepted", 11000, 3000, VENDOR]);
  assert.equal((await scalar(db, "select count(*)::int as n from public.vendor_coordination_reservations where work_order_id=$1", [f.service])).n, 1);
}

async function seedFresh(db, tag) {
  const directory = `dir-${tag}`;
  const service = `svc-${tag}`;
  const lease = randomUUID();
  await db.query("insert into public.manager_vendor_records(id,manager_user_id,row_data) values($1,$2,$3)",
    [directory, MANAGER, { name: "New vendor", email: "vendor@example.test", phone: "+13175550002", active: true }]);
  await db.query("insert into public.portal_work_order_records(id,manager_user_id,resident_email,property_id,row_data) values($1,$2,$3,'property-1',$4)",
    [service, MANAGER, `${tag}@resident.test`, { bucket: "open", title: "New sourcing" }]);
  const job = await scalar(db, "select id from public.vendor_sourcing_jobs where work_order_id=$1", [service]);
  await db.query("update public.vendor_sourcing_jobs set state='waiting',stage=1,lease_token=$2,lease_until=now()+interval '1 hour' where id=$1", [job.id, lease]);
  const candidate = await scalar(db, `insert into public.vendor_sourcing_candidates(job_id,manager_user_id,stage,source,dedupe_key,contact,source_directory_id,status,expires_at)
    values($1,$2,1,'roster',$3,$4,$5,'discovered',now()+interval '2 days') returning id`,
    [job.id, MANAGER, tag, { name: "New vendor", email: "vendor@example.test", phone: "+13175550002" }, directory]);
  assert.equal((await scalar(db, "select count(*)::int as n from public.work_order_vendor_offers where vendor_directory_id=$1", [directory])).n, 0);
  assert.equal((await scalar(db, "select count(*)::int as n from public.vendor_coordination_proposals where vendor_directory_id=$1", [directory])).n, 0);
  return { directory, service, job: job.id, candidate: candidate.id, lease };
}
async function verifyFresh(db, f) {
  const directory = await scalar(db, "select vendor_user_id from public.manager_vendor_records where id=$1", [f.directory]);
  const offer = await scalar(db, "select count(*)::int as n,min(vendor_user_id::text) as vendor from public.work_order_vendor_offers where work_order_id=$1 and vendor_directory_id=$2", [f.service, f.directory]);
  const proposal = await scalar(db, "select count(*)::int as n,min(vendor_user_id::text) as vendor from public.vendor_coordination_proposals where work_order_id=$1 and vendor_directory_id=$2", [f.service, f.directory]);
  assert.equal(directory.vendor_user_id, VENDOR);
  assert.deepEqual([offer.n, offer.vendor, proposal.n, proposal.vendor], [1, VENDOR, 1, VENDOR]);
}
async function addSecondService(db, f) {
  const first = await scalar(db, "select hashtext($1) as key", [f.service]);
  let second;
  for (let n = 0; n < 50; n++) {
    const candidate = `svc-${n}-${f.directory}`;
    const key = (await scalar(db, "select hashtext($1) as key", [candidate])).key;
    if ((candidate < f.service) !== (key < first.key)) { second = candidate; break; }
  }
  assert.ok(second, "fixture must use text order opposite signed advisory-key order");
  await db.query("insert into public.portal_work_order_records(id,manager_user_id,resident_email,property_id,row_data) values($1,$2,$3,'property-1',$4)",
    [second, MANAGER, `${second}@resident.test`, { bucket: "open", title: "Second service" }]);
  await db.query("insert into public.work_order_vendor_offers(work_order_id,manager_user_id,vendor_directory_id,status,expires_at) values($1,$2,$3,'sent',now()+interval '2 days')", [second, MANAGER, f.directory]);
  await db.query("insert into public.vendor_coordination_proposals(work_order_id,manager_user_id,vendor_directory_id,visit_type,status) values($1,$2,$3,'consultation','collecting')", [second, MANAGER, f.directory]);
  return second;
}
async function verifyMulti(db, f) {
  await verifyF1(db, f);
  const secondary = await scalar(db, "select p.vendor_user_id as proposal_user,o.vendor_user_id as offer_user from public.vendor_coordination_proposals p join public.work_order_vendor_offers o on o.work_order_id=p.work_order_id and o.vendor_directory_id=p.vendor_directory_id where p.work_order_id=$1", [f.secondService]);
  assert.deepEqual([secondary.proposal_user, secondary.offer_user], [VENDOR, VENDOR]);
}
async function permissionAndIdentity(db) {
  for (const role of ["anon", "authenticated"]) {
    for (const signature of ["link_vendor_directory_account(text,uuid,uuid)", "lock_vendor_directory(text)", "lock_vendor_directory_services(text,uuid,boolean)"]) {
      assert.equal((await scalar(db, "select has_function_privilege($1,$2,'EXECUTE') as allowed", [role, `public.${signature}`])).allowed, false, `${role} can call ${signature}`);
    }
  }
  for (const signature of ["link_vendor_directory_account(text,uuid,uuid)", "lock_vendor_directory(text)", "lock_vendor_directory_services(text,uuid,boolean)"]) {
    assert.equal((await scalar(db, "select has_function_privilege('service_role',$1,'EXECUTE') as allowed", [`public.${signature}`])).allowed, true, `service_role cannot call ${signature}`);
  }
  const f = await seedBooking(db, "serial-identity");
  const errorCode = async (fn) => { try { await fn(); return "00000"; } catch (error) { return error.code; } };
  assert.notEqual(await errorCode(() => db.query("select public.link_vendor_directory_account($1,$2,$3)", [f.directory, OTHER, VENDOR])), "00000");
  assert.notEqual(await errorCode(() => db.query("select public.link_vendor_directory_account($1,$2,$3)", ["missing-directory", MANAGER, VENDOR])), "00000");
  assert.notEqual(await errorCode(() => db.query("select public.link_vendor_directory_account($1,$2,$3)", [f.directory, MANAGER, randomUUID()])), "00000");
  await identity(db, f); await identity(db, f);
  assert.notEqual(await errorCode(() => db.query("select public.link_vendor_directory_account($1,$2,$3)", [f.directory, MANAGER, OTHER])), "00000");
  const attached = await scalar(db, "select r.vendor_user_id as reservation_user,b.vendor_user_id as bid_user from public.vendor_coordination_reservations r join public.work_order_bids b on b.work_order_id=r.work_order_id where r.id=$1", [f.reservation]);
  assert.deepEqual([attached.reservation_user, attached.bid_user], [VENDOR, VENDOR]);
  await db.query("insert into public.vendor_coordination_phone_bindings(manager_user_id,vendor_directory_id,vendor_user_id,phone_e164) values($1,$2,$3,'+13175550002')", [MANAGER, f.directory, VENDOR]);
  await db.query("update public.manager_vendor_records set row_data=jsonb_set(row_data,'{phone}','\"+13175550009\"') where id=$1", [f.directory]);
  assert.ok((await scalar(db, "select revoked_at from public.vendor_coordination_phone_bindings where vendor_directory_id=$1", [f.directory])).revoked_at);
  await db.query("update public.manager_vendor_records set vendor_user_id=null where id=$1", [f.directory]);
  await db.query("update public.manager_vendor_records set vendor_user_id=$1 where id=$2", [OTHER, f.directory]);
  const historical = await scalar(db, "select r.vendor_user_id as reservation_user,b.vendor_user_id as bid_user,b.amount_cents,b.materials_cents from public.vendor_coordination_reservations r join public.work_order_bids b on b.work_order_id=r.work_order_id where r.id=$1", [f.reservation]);
  assert.deepEqual([historical.reservation_user, historical.bid_user, historical.amount_cents, historical.materials_cents], [VENDOR, VENDOR, 11000, 3000]);
  assert.notEqual(await errorCode(() => db.query("update public.work_order_bids set amount_cents=1 where id=$1", [f.bid])), "00000");
  console.log(JSON.stringify({ scenario: "permissions-and-identity", result: "passed" }));
}
async function calendarRollback(db) {
  const f = await seedBooking(db, "calendar-rollback");
  const local = await scalar(db, "select (starts_at at time zone 'America/Los_Angeles')::date::text as day from public.vendor_coordination_reservations where id=$1", [f.reservation]);
  await db.query("insert into public.vendor_availability_rules(vendor_user_id,kind,specific_date,start_minute,end_minute) values($1,'block',$2,0,1440)", [VENDOR, local.day]);
  let code;
  try { await identity(db, f); code = "00000"; } catch (error) { code = error.code; }
  assert.notEqual(code, "00000", "calendar block must abort link transaction");
  const state = await scalar(db, "select d.vendor_user_id as directory_user,r.vendor_user_id as reservation_user,b.vendor_user_id as bid_user from public.manager_vendor_records d join public.vendor_coordination_reservations r on r.vendor_directory_id=d.id join public.work_order_bids b on b.work_order_id=r.work_order_id where d.id=$1", [f.directory]);
  assert.deepEqual([state.directory_user, state.reservation_user, state.bid_user], [null, null, null]);
  console.log(JSON.stringify({ scenario: "calendar-atomic-rollback", sqlstate: code, result: "passed" }));
}
async function wakeNoop(db) {
  const f = await seedF1(db, "wake-noop");
  const before = await scalar(db, "select state,stage,lease_token,lease_until from public.vendor_sourcing_jobs where id=$1", [f.job]);
  const events = (await scalar(db, "select count(*)::int as n from public.action_events where entity_id=$1", [f.service])).n;
  await identity(db, f);
  const after = await scalar(db, "select state,stage,lease_token,lease_until from public.vendor_sourcing_jobs where id=$1", [f.job]);
  assert.deepEqual(after, before);
  assert.equal((await scalar(db, "select count(*)::int as n from public.action_events where entity_id=$1", [f.service])).n, events);
  const quote = await scalar(db, "select version,quote_revision,status from public.vendor_coordination_proposals where id=$1", [f.repair]);
  assert.deepEqual([quote.version, quote.quote_revision, quote.status], [1, 0, "cancelled"]);
  console.log(JSON.stringify({ scenario: "identity-only-wake", result: "passed" }));
}
async function wakeVariants(db) {
  const live = await seedF1(db, "live-quote-wake");
  // Establish a complete live quote, then give the worker a new current lease.
  await db.query("update public.vendor_coordination_proposals set status='ready' where id=$1", [live.repair]);
  await db.query("update public.vendor_sourcing_jobs set state='waiting',stage=2,lease_token=$2,lease_until=now()+interval '1 hour' where id=$1", [live.job, live.lease]);
  const beforeLive = await scalar(db, "select state,stage,lease_token,lease_until from public.vendor_sourcing_jobs where id=$1", [live.job]);
  const liveEvents = (await scalar(db, "select count(*)::int as n from public.action_events where entity_id=$1", [live.service])).n;
  await identity(db, live);
  assert.deepEqual(await scalar(db, "select state,stage,lease_token,lease_until from public.vendor_sourcing_jobs where id=$1", [live.job]), beforeLive);
  assert.equal((await scalar(db, "select count(*)::int as n from public.action_events where entity_id=$1", [live.service])).n, liveEvents);
  assert.deepEqual(await scalar(db, "select status,version,quote_revision from public.vendor_coordination_proposals where id=$1", [live.repair]), { status: "ready", version: 1, quote_revision: 0 });

  const approved = await seedBooking(db, "approved-wake");
  const approvedJob = await scalar(db, "select id from public.vendor_sourcing_jobs where work_order_id=$1", [approved.service]);
  const lease = randomUUID();
  await db.query("update public.vendor_sourcing_jobs set state='waiting',stage=2,lease_token=$2,lease_until=now()+interval '1 hour' where id=$1", [approvedJob.id, lease]);
  const beforeApproved = await scalar(db, "select state,stage,lease_token,lease_until from public.vendor_sourcing_jobs where id=$1", [approvedJob.id]);
  const approvedEvents = (await scalar(db, "select count(*)::int as n from public.action_events where entity_id=$1", [approved.service])).n;
  await identity(db, approved);
  assert.deepEqual(await scalar(db, "select state,stage,lease_token,lease_until from public.vendor_sourcing_jobs where id=$1", [approvedJob.id]), beforeApproved);
  assert.equal((await scalar(db, "select count(*)::int as n from public.action_events where entity_id=$1", [approved.service])).n, approvedEvents);
  assert.deepEqual(await scalar(db, "select status,version,quote_revision from public.vendor_coordination_proposals where id=$1", [approved.proposal]), { status: "approved", version: 2, quote_revision: 1 });

  const genuine = await seedF1(db, "genuine-quote-wake");
  await db.query("update public.vendor_coordination_proposals set status='ready',quote_revision=quote_revision+1 where id=$1", [genuine.repair]);
  const after = await scalar(db, "select state,lease_token from public.vendor_sourcing_jobs where id=$1", [genuine.job]);
  assert.deepEqual(after, { state: "queued", lease_token: null });
  console.log(JSON.stringify({ scenario: "live-approved-identity-noop-and-real-quote-wake", result: "passed" }));
}
async function unsupportedDirectUpdate(db, owned) {
  const directoryFence = await seedFresh(db, "direct-directory-fence");
  const serviceFence = await seedF1(db, "direct-service-fence");
  for (const [name, f, boundary] of [
    ["directory", directoryFence, "select public.lock_vendor_directory($1)"],
    ["service", serviceFence, "select public.lock_vendor_service($1)"],
  ]) {
    const holder = await connect(owned, "postgres");
    const writer = await connect(owned, "postgres");
    try {
      await begin(holder);
      await holder.query(boundary, [name === "directory" ? f.directory : f.service]);
      let code;
      try { await writer.query("update public.manager_vendor_records set vendor_user_id=$1 where id=$2", [VENDOR, f.directory]); code = "00000"; }
      catch (error) { code = error.code; }
      assert.equal(code, "40001", `${name} boundary must fail direct AFTER-trigger update for retry`);
      assert.equal((await scalar(db, "select vendor_user_id from public.manager_vendor_records where id=$1", [f.directory])).vendor_user_id, null);
      await holder.query("rollback");
      console.log(JSON.stringify({ scenario: `direct-update-${name}-fence`, sqlstate: code, result: "passed" }));
    } finally { await holder.query("rollback").catch(() => {}); await holder.end(); await writer.end(); }
  }
}
async function overlappingDirectories(db, owned) {
  const a = await seedF1(db, "overlap");
  a.secondService = await addSecondService(db, a);
  const b = { directory: "dir-overlap-second" };
  await db.query("insert into public.manager_vendor_records(id,manager_user_id,row_data) values($1,$2,$3)",
    [b.directory, MANAGER, { name: "Second vendor", email: "vendor@example.test", active: true }]);
  for (const service of [a.service, a.secondService]) {
    await db.query("insert into public.work_order_vendor_offers(work_order_id,manager_user_id,vendor_directory_id,status,expires_at) values($1,$2,$3,'sent',now()+interval '2 days')", [service, MANAGER, b.directory]);
    await db.query("insert into public.vendor_coordination_proposals(work_order_id,manager_user_id,vendor_directory_id,visit_type,status) values($1,$2,$3,'consultation','collecting')", [service, MANAGER, b.directory]);
  }
  const ordered = (await db.query("select id from public.portal_work_order_records where id=any($1::text[]) order by hashtext(id),id", [[a.service, a.secondService]])).rows.map((r) => r.id);
  await fixedRace(owned, db, "overlapping-directories-shared-services", {},
    (client) => identity(client, a), (client) => identity(client, b),
    [{ kind: "directory", id: a.directory }, ...ordered.map((id) => ({ kind: "service", id }))],
    async (client) => {
      const rows = await client.query("select vendor_directory_id,work_order_id,vendor_user_id from public.vendor_coordination_proposals where vendor_directory_id=any($1::text[])", [[a.directory, b.directory]]);
      assert.equal(rows.rows.length, 5);
      assert.ok(rows.rows.every((r) => r.vendor_user_id === VENDOR));
    });
}

async function main() {
  let owned;
  try {
    owned = await cluster();
    const db = await connect(owned, "postgres");
    try {
      await install(db, false);
      await baselineDeadlock(owned, db);
      await db.query(readFileSync(join(ROOT, "supabase/migrations", FIX), "utf8"));
      for (const direction of ["link-first", "enroll-first"]) {
        const f = await seedF1(db, direction);
        await fixedRace(owned, db, `F1-${direction}`, f,
          direction === "link-first" ? identity : enroll,
          direction === "link-first" ? enroll : identity,
          [{ kind: "directory", id: f.directory }], verifyF1);
      }
      for (const direction of ["link-first", "enroll-first"]) {
        const f = await seedF1(db, `direct-${direction}`);
        await fixedRace(owned, db, `direct-enrollment-${direction}`, f,
          direction === "link-first" ? identity : directEnroll,
          direction === "link-first" ? directEnroll : identity,
          [{ kind: "directory", id: f.directory }], verifyDirect);
      }
      for (const direction of ["link-first", "cancel-first"]) {
        const f = await seedBooking(db, `booking-${direction}`);
        await fixedRace(owned, db, `reservation-${direction}`, f,
          direction === "link-first" ? identity : cancel,
          direction === "link-first" ? cancel : identity,
          direction === "link-first" ? [{ kind: "directory", id: f.directory }, { kind: "service", id: f.service }] : [{ kind: "service", id: f.service }], verifyBooking);
      }
      const multi = await seedF1(db, "multi-service");
      multi.secondService = await addSecondService(db, multi);
      await fixedRace(owned, db, "multi-service-reverse-key-order", multi, identity, enroll,
        [{ kind: "directory", id: multi.directory }], verifyMulti);
      for (const direction of ["link-first", "enroll-first"]) {
        const fresh = await seedFresh(db, `fresh-${direction}`);
        await fixedRace(owned, db, `first-dependency-${direction}`, fresh,
          direction === "link-first" ? identity : enroll,
          direction === "link-first" ? enroll : identity,
          [{ kind: "directory", id: fresh.directory }], verifyFresh);
      }
      await overlappingDirectories(db, owned);
      // A held directory/service pair does not delay account attachment for an unrelated pair.
      const unrelatedA = await seedFresh(db, "unrelated-a");
      const unrelatedB = await seedFresh(db, "unrelated-b");
      const blocker = await connect(owned, "postgres");
      const independent = await connect(owned, "postgres");
      try {
        await begin(blocker);
        await blocker.query("select public.lock_vendor_directory($1)", [unrelatedA.directory]);
        await blocker.query("select public.lock_vendor_service($1)", [unrelatedA.service]);
        const result = await Promise.race([
          outcome(identity(independent, unrelatedB)),
          new Promise((_, reject) => setTimeout(() => reject(new Error("unrelated link stalled behind another directory/service")), 1500)),
        ]);
        assert.equal(result.code, "00000");
        await blocker.query("rollback");
        console.log(JSON.stringify({ scenario: "unrelated-no-global-serialization", result: "passed" }));
      } finally { await blocker.query("rollback").catch(() => {}); await blocker.end(); await independent.end(); }
      await permissionAndIdentity(db);
      await calendarRollback(db);
      await wakeNoop(db);
      await wakeVariants(db);
      await unsupportedDirectUpdate(db, owned);
      console.log(JSON.stringify({ result: "passed", postgres: "real", migrations: [...MIGRATIONS, FIX], baseline: "40P01", fixedRaces: 10, serialChecks: 6 }));
    } finally { await db.end(); }
  } finally { stopCluster(owned); }
}
export { cluster, connect, install, stopCluster };
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
