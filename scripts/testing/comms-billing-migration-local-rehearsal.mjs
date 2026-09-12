#!/usr/bin/env node
/** A private, throwaway PostgreSQL rehearsal. It never accepts a database URL. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import pg from "pg";
import { buildAtomicBundle, reviewedMigrationManifest } from "../prepare-20260911-comms-billing-migrations.mjs";

const ROOT = process.cwd();
const OWNER = process.env.USER ?? "postgres";
const FIXTURE = join(ROOT, "scripts/testing/fixtures/production-migration-rehearsal-prerequisites.sql");
const RECOVERY = ["20260907130000_webhook_subscriptions.sql","20260907214100_preserve_resident_financial_history.sql","20260907221500_preserve_shared_vendor_financial_history.sql","20260907223000_account_attachment_references.sql","20260907224000_account_recovery_shared_retention.sql","20260907224500_account_recovery_snapshot.sql","20260907225000_account_recovery_identity_patches.sql","20260907225500_account_recovery_capture.sql","20260907230000_account_recovery_object_generations.sql","20260907231000_account_recovery_financial_access_keys.sql","20260907232000_account_recovery_restore.sql","20260907233000_account_recovery_finish_archival.sql"];
const sources = reviewedMigrationManifest();
const run = (file, args) => execFileSync(file, args, { cwd: ROOT, encoding: "utf8", stdio: "pipe" });
function canonicalSpendSmsSegmentBudget() {
  const source = readFileSync(join(ROOT, "supabase/migrations/20260825120000_sms_control_plane.sql"), "utf8");
  const match = source.match(/create or replace function public\.spend_sms_segment_budget\(p_segments integer\)[\s\S]*?\n\$\$;/);
  if (!match || match[0].includes("select true")) throw new Error("Canonical spend_sms_segment_budget source is unavailable.");
  return match[0];
}
async function port() { const s=net.createServer(); await new Promise((yes,no)=>s.listen(0,"127.0.0.1",yes).once("error",no)); const p=s.address().port; await new Promise((yes)=>s.close(yes)); return p; }
async function start() { const dir=mkdtempSync("/tmp/proplane-comms-credit-"); const data=join(dir,"pg"); const p=await port(); try { run("initdb",["-D",data,"--auth=trust","--no-locale"]); run("pg_ctl",["-D",data,"-l",join(dir,"postgres.log"),"-o",`-h 127.0.0.1 -p ${p}`,"-w","start"]); return {dir,data,connection:{host:"127.0.0.1",port:p,user:OWNER,database:"postgres"}}; } catch(e) { rmSync(dir,{recursive:true,force:true}); throw e; } }
async function stop(c) { try { run("pg_ctl",["-D",c.data,"-m","fast","-w","stop"]); } finally { rmSync(c.dir,{recursive:true,force:true}); } }
async function withDb(c, action) { const db=new pg.Client(c.connection); await db.connect(); try { return await action(db); } finally { await db.end(); } }
async function setup(c) { await withDb(c, async db => { await db.query("create extension if not exists pgcrypto"); await db.query(readFileSync(FIXTURE,"utf8"));
  // These are the live-era dependencies, installed before recovery so its trigger loop sees them.
  await db.query(`alter table public.profiles add column created_at timestamptz not null default now();
    create table public.manager_comms_billing_accounts(manager_user_id uuid primary key references public.profiles(id),monthly_budget_cents integer not null default 0,notified_budget_80_at timestamptz,notified_budget_100_at timestamptz,billing_paused_at timestamptz,billing_pause_reason text,updated_at timestamptz not null default now());
    create table public.manager_comms_usage_events(id uuid primary key default gen_random_uuid(),manager_user_id uuid not null references public.profiles(id),meter text not null default 'sms',quantity numeric not null default 1,unit_price_cents integer not null default 0,total_cents integer not null default 0,idempotency_key text unique,metadata jsonb not null default '{}',created_at timestamptz not null default now());
    create table public.manager_automation_settings(manager_user_id uuid primary key references public.profiles(id),row_data jsonb not null default '{}',manual_payments jsonb not null default '{}'::jsonb,updated_at timestamptz not null default now());
    create table public.sms_outbox(id uuid primary key default gen_random_uuid(),segment_count integer not null default 1,status text not null default 'queued',lease_owner text,lease_expires_at timestamptz);
    create table public.sms_runtime_config(singleton boolean primary key default true check(singleton),campaign_daily_segment_limit integer not null);
    insert into public.sms_runtime_config(singleton,campaign_daily_segment_limit) values(true,3);
    create table public.sms_segment_usage(usage_date date primary key,segment_count integer not null default 0,updated_at timestamptz not null default now());
  `);
  await db.query(canonicalSpendSmsSegmentBudget());
  await db.query("do $$ begin if not exists(select 1 from pg_roles where rolname='postgres') then create role postgres superuser; end if; end $$"); await db.query(`grant postgres, service_role to \"${OWNER.replaceAll('"','""')}\"`); for (const file of RECOVERY) await db.query(readFileSync(join(ROOT,"supabase/migrations",file),"utf8")); }); }
async function apply(c, list, auxiliary=false) { await withDb(c, async db => { await db.query("begin"); try { for (const m of list) await db.query(m.sql); for (const m of list) await db.query("insert into supabase_migrations.schema_migrations(version,name,statements) values($1,$2,$3) on conflict(version) do nothing",[m.version,m.name,[m.sql]]); if(auxiliary) await db.query("insert into supabase_migrations.schema_migrations(version,name,statements) values($1,$2,$3)",["20260911161000","comms_billing_rollout",[buildAtomicBundle(sources)]]); await db.query("commit"); } catch(e) { await db.query("rollback"); throw e; } }); }
async function rejects(action, fragment) { await assert.rejects(action, e => e instanceof Error && e.message.includes(fragment)); }
async function rejectsExactly(action, message) { await assert.rejects(action, e => e instanceof Error && e.message === message); }
async function rollbackBaseline(db) {
  return {
    settings:(await db.query("select manager_user_id,row_data,manual_payments from public.manager_automation_settings order by manager_user_id")).rows,
    usage:(await db.query("select manager_user_id,meter,quantity,unit_price_cents,total_cents,idempotency_key,metadata from public.manager_comms_usage_events order by id")).rows,
    ledger:(await db.query("select version,name,statements from supabase_migrations.schema_migrations order by version,name")).rows,
  };
}
async function assertRollback(c, baseline) {
  await withDb(c, async db => {
    assert.deepEqual(await rollbackBaseline(db),baseline);
    const artifacts=await db.query(`select
      to_regclass('public.comms_credit_policy') is null and to_regclass('public.manager_comms_credit_purchases') is null and to_regclass('public.manager_comms_credit_adjustments') is null objects_absent,
      not exists(select 1 from information_schema.columns where (table_schema,table_name,column_name) in (
        ('public','manager_comms_billing_accounts','credit_period_start'),('public','manager_comms_billing_accounts','included_allowance_cents'),('public','manager_comms_billing_accounts','included_remaining_cents'),('public','manager_comms_billing_accounts','purchased_credit_cents'),('public','manager_comms_billing_accounts','credit_cutover_at'),('public','manager_comms_billing_accounts','stripe_customer_id'),
        ('public','manager_comms_usage_events','credit_state'),('public','manager_comms_usage_events','included_debit_cents'),('public','manager_comms_usage_events','purchased_debit_cents'),('public','manager_comms_usage_events','platform_absorbed_cents'),('public','manager_comms_usage_events','credit_period_start'),('public','sms_outbox','campaign_budget_spent_on')
      )) columns_absent,
      not exists(select 1 from unnest(array[
        'public.comms_wallet_snapshot(uuid,integer,integer,boolean)','public.comms_wallet_snapshots(jsonb)','public.reserve_comms_credit(uuid,integer,integer,text,text,numeric,integer,jsonb,boolean)','public.finish_comms_credit(uuid,text,boolean)','public.fulfill_comms_credit_purchase(uuid,uuid,text,text,integer,text,text)','public.reverse_comms_credit_purchase(text,integer,text,text)','public.settle_comms_credit_quantity(uuid,text,numeric)','public.save_manager_payment_preferences(uuid,jsonb)','public.set_staff_payment_fee_override(uuid,text)','public.claim_comms_budget_alert(uuid)','public.spend_sms_outbox_segment_budget(uuid,text)'
      ]::text[]) p where to_regprocedure(p) is not null) functions_absent,
      to_regclass('public.comms_credit_purchases_owner_created') is null and to_regclass('public.manager_billing_customer_unique') is null indexes_absent,
      not exists(select 1 from supabase_migrations.schema_migrations where version=any($1::text[]) or name=any($2::text[])) ledger_absent`,[sources.map(m=>m.version).concat('20260911161000'),sources.map(m=>m.name).concat('comms_billing_rollout')]);
    assert.deepEqual(artifacts.rows[0],{objects_absent:true,columns_absent:true,functions_absent:true,indexes_absent:true,ledger_absent:true});
  });
}
function injectFailureAfter(bundle, sourceIndex) {
  const source=sources[sourceIndex]; const exact=`-- exact source: ${source.file} sha256:${source.sha256}\n${source.sql}`; const offset=bundle.indexOf(exact);
  assert.notEqual(offset,-1,`actual bundle is missing source ${sourceIndex+1}`);
  return `${bundle.slice(0,offset+exact.length)}\ndo $$ begin raise exception 'rehearsal injected failure after source ${sourceIndex+1}'; end $$;\n${bundle.slice(offset+exact.length)}`;
}
async function seedOwner(db, id, email) {
  await db.query("insert into auth.users(id,email) values($1,$2)", [id,email]);
  await db.query("insert into public.profiles(id,email,role,created_at) values($1,$2,'manager',now()-interval '1 day')", [id,email]);
  await db.query("insert into public.profile_roles(user_id,role) values($1,'manager')", [id]);
}

const first=await start();
try {
  await setup(first);
  // Pinned five installed after actual recovery migrations reproduce the missing guard.
  await apply(first,sources.slice(0,5));
  await withDb(first, async db => { const r=await db.query("select count(*)::int n from pg_trigger where not tgisinternal and tgrelid='public.manager_comms_credit_purchases'::regclass and tgname='account_recovery_write_guard'"); assert.equal(r.rows[0].n,0); });
  await apply(first,[sources[5]]); await apply(first,[sources[5]]);
  await withDb(first, async db => { const r=await db.query("select count(*)::int n from pg_trigger where not tgisinternal and tgrelid in ('public.manager_comms_credit_purchases'::regclass,'public.manager_comms_credit_adjustments'::regclass) and tgname in ('account_recovery_write_guard','account_recovery_capture_delete')"); assert.equal(r.rows[0].n,4); });
  await withDb(first, async db => {
    // Archive-held credit rows are frozen, captured on legitimate archival deletes, and restored in FK order.
    const owner="11111111-1111-1111-1111-111111111111"; await seedOwner(db,owner,"owner@test.local");
    const purchase="21111111-1111-1111-1111-111111111111"; const adjustment="31111111-1111-1111-1111-111111111111";
    await db.query("insert into public.manager_comms_credit_purchases(id,manager_user_id,credit_cents,status) values($1,$2,500,'paid')",[purchase,owner]);
    await db.query("insert into public.manager_comms_credit_adjustments(id,purchase_id,manager_user_id,provider_event_id,amount_cents,reason) values($1,$2,$3,'evt_rehearsal',500,'purchase')",[adjustment,purchase,owner]);
    const plan={rules:[{table:"manager_comms_credit_purchases",ids:["manager_user_id"],recover:true,phase:1},{table:"manager_comms_credit_adjustments",ids:["manager_user_id"],recover:true,phase:2}],recoverableTables:["manager_comms_credit_purchases","manager_comms_credit_adjustments"]};
    const request=(await db.query("select public.account_recovery_begin($1,'manager',$2,'{}') id",[owner,plan])).rows[0].id;
    await rejects(()=>db.query("update public.manager_comms_credit_purchases set status='pending' where id=$1",[purchase]),"recovery decision");
    await rejects(()=>db.query("insert into public.manager_comms_credit_purchases(id,manager_user_id,credit_cents,status) values(gen_random_uuid(),$1,500,'paid')",[owner]),"recovery decision");
    await db.query("delete from public.manager_comms_credit_adjustments where id=$1",[adjustment]);
    await db.query("delete from public.manager_comms_credit_purchases where id=$1",[purchase]);
    const captured=await db.query("select r.table_name,r.archived from public.account_recovery_records r join public.account_recovery_holds h on h.record_id=r.id where h.request_id=$1 and r.table_name like 'manager_comms_credit_%' order by r.table_name",[request]);
    assert.deepEqual(captured.rows,[{table_name:"manager_comms_credit_adjustments",archived:true},{table_name:"manager_comms_credit_purchases",archived:true}]);
    await db.query("select public.account_recovery_finish_archival($1)",[request]);
    const hash="b".repeat(64); await db.query("select public.account_recovery_issue_challenge($1,$2,$3)",[request,owner,hash]); await db.query("select public.account_recovery_recover($1,$2,$3)",[request,owner,hash]);
    assert.equal((await db.query("select count(*)::int n from public.manager_comms_credit_purchases where id=$1",[purchase])).rows[0].n,1);
    assert.equal((await db.query("select count(*)::int n from public.manager_comms_credit_adjustments where id=$1",[adjustment])).rows[0].n,1);

    // Existing-manager migration-month grandfathering, read-only snapshots, and idempotency.
    const walletOwner="12111111-1111-1111-1111-111111111111"; await seedOwner(db,walletOwner,"wallet@test.local");
    const beforeAccounts=(await db.query("select count(*)::int n from public.manager_comms_billing_accounts")).rows[0].n;
    const readOnly=await db.query("select public.comms_wallet_snapshot($1,100,200,false) snapshot",[walletOwner]); assert.equal((await db.query("select count(*)::int n from public.manager_comms_billing_accounts")).rows[0].n,beforeAccounts); assert.equal(readOnly.rows[0].snapshot.allowance_cents,200);
    const applied=await db.query("select public.comms_wallet_snapshot($1,100,200,true) snapshot",[walletOwner]); assert.equal(applied.rows[0].snapshot.allowance_cents,200);
    const firstReserve=await db.query("select public.reserve_comms_credit($1,100,200,'rehearsal-key','sms',1,3,'{}',false) reservation",[walletOwner]); const replay=await db.query("select public.reserve_comms_credit($1,100,200,'rehearsal-key','sms',1,3,'{}',false) reservation",[walletOwner]); assert.equal(firstReserve.rows[0].reservation.duplicate,false); assert.equal(replay.rows[0].reservation.duplicate,true);
    const grants=await db.query("select has_table_privilege('anon','public.manager_comms_credit_purchases','select') anon_select, has_table_privilege('service_role','public.manager_comms_credit_purchases','insert') service_insert, has_function_privilege('anon','public.comms_wallet_snapshot(uuid,integer,integer,boolean)','execute') anon_rpc, has_function_privilege('service_role','public.comms_wallet_snapshot(uuid,integer,integer,boolean)','execute') service_rpc"); assert.deepEqual(grants.rows[0],{anon_select:false,service_insert:true,anon_rpc:false,service_rpc:true});
    const index=await db.query("select count(*)::int n from pg_indexes where schemaname='public' and indexname='manager_billing_customer_unique' and indexdef ilike '%stripe_customer_id%is not null%'"); assert.equal(index.rows[0].n,1);
  });
  // The actual bundle rejects qualifying backfill rows before making any candidate change.
  const stable=buildAtomicBundle(sources); assert.equal(stable,buildAtomicBundle(sources)); assert.match(stable,/set local lock_timeout='3s'/); assert.match(stable,/pg_try_advisory_xact_lock/); assert.match(stable,/payment preference backfill must be zero/);
  const qualifying=await start(); try { await setup(qualifying); const owner="81111111-1111-1111-1111-111111111111"; let baseline; await withDb(qualifying,async db=>{ await seedOwner(db,owner,"qualifying@test.local"); await db.query("insert into supabase_migrations.schema_migrations(version,name,statements) values('20260901000000','historical_fixture',array['unchanged'])"); await db.query("insert into public.manager_automation_settings(manager_user_id,row_data,manual_payments) values($1,'{\"manualPayments\":{\"serviceFeePayer\":\"manager\"}}','{}')",[owner]); baseline=await rollbackBaseline(db); assert.equal(baseline.settings.length,1); assert.equal(baseline.ledger.length,1); }); await rejectsExactly(()=>withDb(qualifying,db=>db.query(stable)),"payment preference backfill must be zero"); await assertRollback(qualifying,baseline); } finally { await stop(qualifying); }
  // Test-only SQL is spliced into the actual generated bundle after sources 1, 5, and 6.
  for (const point of [0,4,5]) { const c=await start(); try { await setup(c); const owner=`${point+1}1111111-1111-1111-1111-111111111111`; let baseline; await withDb(c,async db=>{ await seedOwner(db,owner,`rollback-${point}@test.local`); await db.query("insert into supabase_migrations.schema_migrations(version,name,statements) values('20260901000000','historical_fixture',array['unchanged'])"); await db.query("insert into public.manager_automation_settings(manager_user_id,row_data,manual_payments) values($1,'{\"legacy\":true}','{\"kept\":true}')",[owner]); await db.query("insert into public.manager_comms_usage_events(manager_user_id,meter,quantity,unit_price_cents,total_cents,idempotency_key,metadata) values($1,'sms_outbound_segment',1,7,7,$2,'{\"kept\":true}')",[owner,`historical-${point}`]); baseline=await rollbackBaseline(db); assert.equal(baseline.settings.length,1); assert.equal(baseline.usage.length,1); assert.equal(baseline.ledger.length,1); }); const injected=injectFailureAfter(stable,point); await rejectsExactly(()=>withDb(c,db=>db.query(injected)),`rehearsal injected failure after source ${point+1}`); await assertRollback(c,baseline); } finally { await stop(c); } }
  // Backfill semantics distinguish qualifying empty canonical values from nonempty/nonobject/null legacy data.
  const backfill=await start(); try { await setup(backfill); await withDb(backfill,async db=>{ for(let i=0;i<4;i++) await seedOwner(db,`${i+4}1111111-1111-1111-1111-111111111111`,`backfill-${i}@test.local`); await db.query("insert into public.manager_automation_settings(manager_user_id,row_data,manual_payments) values($1,'{\"manualPayments\":{\"serviceFeePayer\":\"manager\"}}','{}'),($2,'{\"manualPayments\":{\"serviceFeePayer\":\"resident\"}}','{\"kept\":true}'),($3,'{\"manualPayments\":\"invalid\"}','{}'),($4,'{\"manualPayments\":null}','{}')",["41111111-1111-1111-1111-111111111111","51111111-1111-1111-1111-111111111111","61111111-1111-1111-1111-111111111111","71111111-1111-1111-1111-111111111111"]); await db.query(sources[0].sql); const rows=(await db.query("select manager_user_id,manual_payments from public.manager_automation_settings order by manager_user_id")).rows; assert.deepEqual(rows.map(r=>r.manual_payments),[{serviceFeePayer:"manager"},{kept:true},{},{}]); }); } finally { await stop(backfill); }

  const clean=await start(); try { await setup(clean); await withDb(clean,async db=>{ const legacyOwner="82111111-1111-1111-1111-111111111111"; const oldShapeOwner="83111111-1111-1111-1111-111111111111"; await seedOwner(db,legacyOwner,"legacy@test.local"); await seedOwner(db,oldShapeOwner,"old-shape@test.local"); await db.query("insert into supabase_migrations.schema_migrations(version,name,statements) values('20260901000000','historical_fixture',array['unchanged'])"); await db.query("insert into public.manager_automation_settings(manager_user_id,row_data,manual_payments) values($1,'{\"legacy\":true}','{\"kept\":true}')",[legacyOwner]); const inner=stable.replace(/^begin;\n/i,"").replace(/commit;\n?$/i,""); await db.query("begin"); await db.query(inner); await db.query("insert into supabase_migrations.schema_migrations(version,name,statements) values($1,$2,$3)",["20260911161000","comms_billing_rollout",[stable]]); await db.query("commit"); const usage=(await db.query("insert into public.manager_comms_usage_events(manager_user_id,meter,quantity,unit_price_cents,total_cents,idempotency_key,metadata) values($1,'sms_outbound_segment',1,7,7,'legacy-rehearsal','{}') returning credit_state,included_debit_cents,purchased_debit_cents,platform_absorbed_cents",[legacyOwner])).rows[0]; assert.deepEqual(usage,{credit_state:"legacy",included_debit_cents:0,purchased_debit_cents:0,platform_absorbed_cents:0}); await db.query("insert into public.manager_automation_settings(manager_user_id,row_data) values($1,'{\"oldShape\":true}')",[oldShapeOwner]); const settings=(await db.query("update public.manager_automation_settings set row_data=jsonb_set(row_data,'{afterInstall}','true'::jsonb) where manager_user_id=$1 returning row_data,manual_payments",[oldShapeOwner])).rows[0]; assert.deepEqual(settings,{row_data:{oldShape:true,afterInstall:true},manual_payments:{}}); const r=await db.query("select version,name,statements from supabase_migrations.schema_migrations order by version"); assert.deepEqual(r.rows[0],{version:"20260901000000",name:"historical_fixture",statements:["unchanged"]}); assert.equal(r.rows.length,8); for(let i=0;i<6;i++) assert.deepEqual(r.rows[i+1].statements,[sources[i].sql]); assert.deepEqual(r.rows[7],{version:"20260911161000",name:"comms_billing_rollout",statements:[stable]}); }); await rejects(()=>withDb(clean,db=>db.query(stable)),"ledger is not cleanly absent"); } finally { await stop(clean); }

  // Dirty objects, partial/conflicting ledgers, and qualifying backfill rows all fail before sources.
  for (const setupConflict of ["create table public.comms_credit_policy(singleton boolean)","insert into supabase_migrations.schema_migrations(version,name) values('20260910140000','manager_communication_credits')","insert into supabase_migrations.schema_migrations(version,name) values('20260101000000','comms_credit_alerts')"]) { const c=await start(); try { await setup(c); await withDb(c,db=>db.query(setupConflict)); await rejects(()=>withDb(c,db=>db.query(stable)), setupConflict.startsWith("create")?"targets are partially present":"ledger is not cleanly absent"); } finally { await stop(c); } }

  // The preflight table lock prevents a concurrent settings writer from changing the zero-row decision.
  const locked=await start(); try { await setup(locked); const a=new pg.Client(locked.connection),b=new pg.Client(locked.connection); await a.connect(); await b.connect(); try { await a.query("begin; lock table public.manager_automation_settings in share row exclusive mode"); await b.query("set statement_timeout='250ms'"); await assert.rejects(b.query("insert into public.manager_automation_settings(manager_user_id) values('81111111-1111-1111-1111-111111111111')"),e=>e.code==='57014'); await a.query("rollback"); } finally { await a.end(); await b.end(); } } finally { await stop(locked); }

  // Concurrent wallet reservations cannot overspend and campaign retries charge once per outbox row/day.
  const concurrent=await start(); try { await setup(concurrent); await withDb(concurrent,db=>db.query(stable)); await withDb(concurrent,db=>seedOwner(db,"91111111-1111-1111-1111-111111111111","concurrent@test.local")); await withDb(concurrent,db=>db.query("select public.comms_wallet_snapshot($1,200,200,true)",["91111111-1111-1111-1111-111111111111"])); const attempts=await Promise.allSettled(Array.from({length:80},(_,i)=>withDb(concurrent,db=>db.query("select public.reserve_comms_credit($1,200,200,$2,'sms',1,3,'{}',false) result",["91111111-1111-1111-1111-111111111111",`key-${i}`])))); assert.equal(attempts.filter(r=>r.status==='fulfilled').length,80); const reservations=attempts.map(r=>r.value.rows[0].result); assert.equal(reservations.filter(r=>r.allowed).length,66); const denied=reservations.filter(r=>!r.allowed); assert.equal(denied.length,14); assert.ok(denied.every(r=>r.reason==='allowance_exhausted')); const wallet=(await withDb(concurrent,db=>db.query("select included_remaining_cents+greatest(0,purchased_credit_cents) balance,(select count(*)::int from public.manager_comms_usage_events where manager_user_id=$1 and credit_state='reserved') reservations from public.manager_comms_billing_accounts where manager_user_id=$1",["91111111-1111-1111-1111-111111111111"]))).rows[0]; assert.deepEqual(wallet,{balance:2,reservations:66}); await withDb(concurrent,async db=>{ await db.query("insert into public.sms_outbox(id,segment_count,status,lease_owner,lease_expires_at) values('aaaaaaaa-1111-1111-1111-111111111111',2,'submitting','worker',now()+interval '1 minute'),('bbbbbbbb-1111-1111-1111-111111111111',2,'submitting','worker',now()+interval '1 minute')"); }); const spends=await Promise.all(["aaaaaaaa-1111-1111-1111-111111111111","bbbbbbbb-1111-1111-1111-111111111111"].map(id=>withDb(concurrent,db=>db.query("select public.spend_sms_outbox_segment_budget($1,'worker') ok",[id])))); assert.equal(spends.filter(x=>x.rows[0].ok).length,1); const winner=["aaaaaaaa-1111-1111-1111-111111111111","bbbbbbbb-1111-1111-1111-111111111111"][spends.findIndex(x=>x.rows[0].ok)]; assert.equal((await withDb(concurrent,db=>db.query("select public.spend_sms_outbox_segment_budget($1,'worker') ok",[winner]))).rows[0].ok,true); assert.equal((await withDb(concurrent,db=>db.query("select segment_count::int n from public.sms_segment_usage where usage_date=(now() at time zone 'UTC')::date"))).rows[0].n,2); } finally { await stop(concurrent); }
  console.log("PASS: disposable localhost rehearsal covered the recovery gap/correction, held-write and delete-capture recovery, exact ledgers and auxiliary identity, rollback/conflict/backfill locks, wallet/campaign concurrency, and RLS/catalog behavior.");
} finally { await stop(first); }
