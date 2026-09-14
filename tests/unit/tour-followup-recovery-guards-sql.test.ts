import { afterAll, beforeAll, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const ROOT = process.cwd();
const GUARDS = readFileSync(`${ROOT}/supabase/migrations/20260913173000_tour_followup_recovery_guards.sql`, "utf8");
const TOUR = readFileSync(`${ROOT}/supabase/migrations/20260912220000_tour_interest_reminders.sql`, "utf8");
const PROBE = readFileSync(`${ROOT}/scripts/testing/tour-followup-recovery-guards-probe.sql`, "utf8")
  .replace(/^\\set ON_ERROR_STOP on\s*$/m, "");
const RECOVERY_MIGRATIONS = [
  "20260907214100_preserve_resident_financial_history.sql",
  "20260907224000_account_recovery_shared_retention.sql",
  "20260907224500_account_recovery_snapshot.sql",
  "20260907225000_account_recovery_identity_patches.sql",
  "20260907225500_account_recovery_capture.sql",
  "20260907230000_account_recovery_object_generations.sql",
  "20260907233000_account_recovery_finish_archival.sql",
];

let db: PGlite;

async function bootstrapBase(database: PGlite) {
  await database.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema auth;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    create table profiles(id uuid primary key,role text,email text,full_name text,phone text,preferred_language text);
    create table profile_roles(user_id uuid,role text,primary key(user_id,role));
    create schema storage;
    create table storage.buckets(id text primary key,name text,public boolean);
    create table storage.objects(bucket_id text,name text);
    create table account_link_invites(id uuid);
    create table manager_property_records(id text);
    create table manager_sms_conversation_houses(manager_user_id uuid,conversation_key text,property_id text);
    create table manager_automation_settings(manager_user_id uuid primary key,row_data jsonb);
    create table portal_reminder_records(
      id uuid primary key,manager_user_id uuid,kind text,subject_id text,lead_minutes integer,
      recipient_email text not null,recipient_role text,send_at timestamptz,status text,payload jsonb,
      updated_at timestamptz,lease_owner text,lease_expires_at timestamptz,sent_at timestamptz,last_error text
    );
    create table sms_outbox(
      id uuid primary key,manager_user_id uuid,actor_user_id uuid,purpose text,dedupe_key text,
      recipient_phone text,conversation_key text,property_id text,body text,status text,
      dispatch_started_at timestamptz,provider_message_sid text,lease_owner text,lease_expires_at timestamptz,
      provider_from_phone text,blocked_reason text,updated_at timestamptz
    );
    create table manager_sms_messages(id text,manager_user_id uuid,resident_phone text,direction text,created_at timestamptz);
    create function conversation_house_access_revision(uuid) returns text language sql as $$ select 'revision'::text $$;
    create table document_rows(id text primary key,manager_user_id uuid,superseded_id text references document_rows(id) on delete set null);
    create table audit_log(id uuid primary key,actor_user_id uuid not null);
    create table manager_application_records(id text primary key,manager_user_id uuid,resident_email text);
    create table child_records(id text primary key,application_id text references manager_application_records(id) on delete cascade);
    create table screening_orders(id text primary key,application_id text);
    create table cosigner_submission_records(id text primary key,signer_app_id text);
  `);
  for (const table of ["ledger_entries", "security_deposit_ledger", "manager_payment_plans", "portal_household_charge_records", "portal_lease_pipeline_records"]) {
    await database.exec(`create table ${table}(id uuid primary key,manager_user_id uuid,resident_user_id uuid,resident_email text,amount_cents integer,row_data jsonb);`);
  }
}

async function installHistoricalRecovery(database: PGlite) {
  for (const file of RECOVERY_MIGRATIONS.slice(0, 5)) {
    await database.exec(readFileSync(`${ROOT}/supabase/migrations/${file}`, "utf8"));
  }
}

async function installCompleteRecovery(database: PGlite) {
  for (const file of RECOVERY_MIGRATIONS.slice(5)) {
    await database.exec(readFileSync(`${ROOT}/supabase/migrations/${file}`, "utf8"));
  }
}

async function makeHistoricalDatabase() {
  const database = new PGlite();
  await bootstrapBase(database);
  await installHistoricalRecovery(database);
  return database;
}

async function makeCandidateDatabase() {
  const database = await makeHistoricalDatabase();
  await database.exec(TOUR);
  await installCompleteRecovery(database);
  return database;
}

async function triggerCatalog(database: PGlite) {
  return (await database.query<{
    tgname: string;
    tgfoid: string;
    tgtype: number;
    tgattr: string;
    tgenabled: string;
    tgnargs: number;
    has_when: boolean;
    tgconstraint: string;
    tgisinternal: boolean;
  }>(`
    select t.tgname,
      np.nspname || '.' || p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' as tgfoid,
      t.tgtype,
      t.tgattr::text as tgattr,
      t.tgenabled,
      t.tgnargs,
      t.tgqual is not null as has_when,
      t.tgconstraint::text,
      t.tgisinternal
    from pg_trigger t
    join pg_proc p on p.oid=t.tgfoid
    join pg_namespace np on np.oid=p.pronamespace
    where t.tgrelid='public.manager_tour_followup_controls'::regclass
      and t.tgname in ('account_recovery_write_guard','account_recovery_capture_delete')
    order by t.tgname
  `)).rows;
}

async function expectExactTriggers(database: PGlite) {
  expect(await triggerCatalog(database)).toEqual([
    {
      tgname: "account_recovery_capture_delete",
      tgfoid: "public.account_recovery_capture_delete()",
      tgtype: 9,
      tgattr: "",
      tgenabled: "O",
      tgnargs: 0,
      has_when: false,
      tgconstraint: "0",
      tgisinternal: false,
    },
    {
      tgname: "account_recovery_write_guard",
      tgfoid: "public.account_recovery_write_guard()",
      tgtype: 31,
      tgattr: "",
      tgenabled: "O",
      tgnargs: 0,
      has_when: false,
      tgconstraint: "0",
      tgisinternal: false,
    },
  ]);
}

beforeAll(async () => {
  db = await makeCandidateDatabase();
  expect(await triggerCatalog(db)).toEqual([]);
  await db.exec(GUARDS);
}, 30_000);

afterAll(async () => {
  await db?.close();
});

it("has fail-closed, transactional, exact and idempotent trigger installation", async () => {
  await expectExactTriggers(db);
  await db.exec(GUARDS);
  await expectExactTriggers(db);

  expect((await db.query(`
    select c.relrowsecurity,
      has_table_privilege('anon','public.manager_tour_followup_controls','select') as anon_select,
      has_table_privilege('authenticated','public.manager_tour_followup_controls','select') as authenticated_select,
      has_table_privilege('service_role','public.manager_tour_followup_controls','select') as service_select
    from pg_class c
    where c.oid='public.manager_tour_followup_controls'::regclass
  `)).rows).toEqual([{
    relrowsecurity: true,
    anon_select: false,
    authenticated_select: false,
    service_select: true,
  }]);

  const { rows } = await db.query<{ guard: string; capture: string }>(`
    select
      'public.' || p_guard.proname || '(' || pg_catalog.oidvectortypes(p_guard.proargtypes) || ')' as guard,
      'public.' || p_capture.proname || '(' || pg_catalog.oidvectortypes(p_capture.proargtypes) || ')' as capture
    from pg_proc p_guard, pg_proc p_capture
    where p_guard.oid='public.account_recovery_write_guard()'::regprocedure
      and p_capture.oid='public.account_recovery_capture_delete()'::regprocedure
  `);
  expect(rows).toEqual([{ guard: "public.account_recovery_write_guard()", capture: "public.account_recovery_capture_delete()" }]);
});

it("refuses a conflicting same-name trigger and rolls back an earlier create in the same migration", async () => {
  const database = await makeHistoricalDatabase();
  await database.exec(TOUR);
  await database.exec(`
    create function conflicting_recovery_trigger() returns trigger language plpgsql as $$ begin return new; end $$;
    create trigger account_recovery_capture_delete before insert on public.manager_tour_followup_controls
      for each row execute function conflicting_recovery_trigger();
  `);

  await expect(database.exec(GUARDS)).rejects.toThrow(/conflicts with the required recovery trigger/);
  await database.exec("rollback");
  expect(await triggerCatalog(database)).toEqual([{
    tgname: "account_recovery_capture_delete",
    tgfoid: "public.conflicting_recovery_trigger()",
    tgtype: 7,
    tgattr: "",
    tgenabled: "O",
    tgnargs: 0,
    has_when: false,
    tgconstraint: "0",
    tgisinternal: false,
  }]);
  await database.close();
});

it("rejects a column-limited write guard and rolls back the companion trigger", async () => {
  const database = await makeHistoricalDatabase();
  await database.exec(TOUR);
  await installCompleteRecovery(database);
  await database.exec(`
    create trigger account_recovery_write_guard
      before insert or update of archived or delete
      on public.manager_tour_followup_controls
      for each row execute function public.account_recovery_write_guard();
  `);

  await expect(database.exec(GUARDS)).rejects.toThrow(/conflicts with the required recovery trigger/);
  await database.exec("rollback");
  expect(await triggerCatalog(database)).toEqual([{
    tgname: "account_recovery_write_guard",
    tgfoid: "public.account_recovery_write_guard()",
    tgtype: 31,
    tgattr: "3",
    tgenabled: "O",
    tgnargs: 0,
    has_when: false,
    tgconstraint: "0",
    tgisinternal: false,
  }]);
  await database.close();
});

it("fails before creating any trigger when the controls table is absent", async () => {
  const database = await makeHistoricalDatabase();
  await expect(database.exec(GUARDS)).rejects.toThrow(/prerequisites are missing/);
  await database.exec("rollback");
  const { rows } = await database.query<{ count: string }>(`
    select count(*)::text from pg_trigger t
    join pg_class c on c.oid=t.tgrelid
    where c.relname='manager_tour_followup_controls'
  `);
  expect(rows).toEqual([{ count: "0" }]);
  await database.close();
});

it("fails before creating any trigger when the recovery trigger functions are absent", async () => {
  const database = new PGlite();
  await bootstrapBase(database);
  await database.exec(`create table public.manager_tour_followup_controls(
    manager_user_id uuid not null references auth.users(id) on delete cascade,
    conversation_key text not null,
    archived boolean not null default false,
    updated_at timestamptz not null default now(),
    primary key(manager_user_id,conversation_key)
  )`);
  await expect(database.exec(GUARDS)).rejects.toThrow(/prerequisites are missing/);
  await database.exec("rollback");
  const { rows } = await database.query<{ count: string }>(`select count(*)::text from pg_trigger where tgrelid='public.manager_tour_followup_controls'::regclass and not tgisinternal`);
  expect(rows).toEqual([{ count: "0" }]);
  await database.close();
});

it("freezes, captures, and completes archival for a real manager control row", async () => {
  const manager = "00000000-0000-0000-0000-00000000a472";
  const conversation = "qa-recovery-guards:0001";
  await db.query("insert into auth.users(id,email) values($1,$2)", [manager, "qa-recovery-guards-a472@example.test"]);
  await db.query("insert into profiles(id,role,email) values($1,'manager',$2)", [manager, "qa-recovery-guards-a472@example.test"]);
  await db.query("insert into profile_roles(user_id,role) values($1,'manager')", [manager]);
  await db.query("insert into manager_tour_followup_controls(manager_user_id,conversation_key) values($1,$2)", [manager, conversation]);

  const plan = {
    rules: [{ table: "manager_tour_followup_controls", ids: ["manager_user_id"], recover: true, phase: 2 }],
    recoverableTables: ["manager_tour_followup_controls"],
  };
  const { rows: [request] } = await db.query<{ id: string }>(
    "select account_recovery_begin($1,'manager',$2,'{}') id",
    [manager, plan],
  );
  await db.query("select set_config('proplane.account_recovery_internal','off',true)");

  await expect(db.query("update manager_tour_followup_controls set archived=true where manager_user_id=$1 and conversation_key=$2", [manager, conversation]))
    .rejects.toThrow(/Account recovery decision required/);

  const { rows: [held] } = await db.query<{ archived: boolean; request_state: string }>(`
    select r.archived, a.state request_state
    from account_recovery_records r
    join account_recovery_holds h on h.record_id=r.id
    join account_recovery_requests a on a.id=h.request_id
    where h.request_id=$1 and r.table_name='manager_tour_followup_controls'
  `, [request.id]);
  expect(held).toEqual({ archived: false, request_state: "archiving" });

  await db.query("delete from manager_tour_followup_controls where manager_user_id=$1 and conversation_key=$2", [manager, conversation]);
  const { rows: [captured] } = await db.query<{ archived: boolean }>(`
    select r.archived from account_recovery_records r
    join account_recovery_holds h on h.record_id=r.id
    where h.request_id=$1 and r.table_name='manager_tour_followup_controls'
  `, [request.id]);
  expect(captured).toEqual({ archived: true });

  await db.query("select account_recovery_finish_archival($1)", [request.id]);
  expect((await db.query("select state from account_recovery_requests where id=$1", [request.id])).rows).toEqual([{ state: "retained" }]);
  expect((await db.query("select archived from account_recovery_records r join account_recovery_holds h on h.record_id=r.id where h.request_id=$1", [request.id])).rows)
    .toEqual([{ archived: true }]);
});

it("executes the reviewed rollback-only probe without leaking its synthetic fixture", async () => {
  const database = await makeCandidateDatabase();
  await database.exec(GUARDS);
  await database.exec(PROBE);

  const manager = "00000000-0000-0000-0000-00000000a472";
  expect((await database.query("select id from auth.users where id=$1", [manager])).rows).toEqual([]);
  expect((await database.query("select id from account_recovery_requests where user_id=$1", [manager])).rows).toEqual([]);
  expect((await database.query(`
    select r.id from account_recovery_records r
    where r.table_name='manager_tour_followup_controls'
      and r.row_key->>'manager_user_id'=$1
      and r.row_key->>'conversation_key'='qa-recovery-guards:0001'
  `, [manager])).rows).toEqual([]);
  await database.close();
});
