import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { RESIDENT_IDENTITY, guardedResidentMigrationSql, expectedResidentFunction, residentFunctionGuardSql, residentRecoverySql } from "../../scripts/release-resident-inbox-read.mjs";
import { ledgerGuardSql } from "../../scripts/release-conversation-schema-reconciliation.mjs";

const enabled = process.env.RELEASE_RECONCILIATION_DISPOSABLE_PG === "1";
const connectionString = process.env.RELEASE_RECONCILIATION_PG_URL ?? "";
let parsed: URL | undefined;
try { parsed = new URL(connectionString); } catch { parsed = undefined; }
const isLocal = !!parsed && ["postgres:", "postgresql:"].includes(parsed.protocol)
  && ["localhost", "127.0.0.1"].includes(parsed.hostname) && !parsed.search && !parsed.hash;
if (enabled && !isLocal) throw new Error("Resident inbox disposable test requires an explicit loopback PostgreSQL URL without overrides");
const describeDisposable = enabled ? describe : describe.skip;

const originalSql = readFileSync("supabase/migrations/20260913170000_mark_portal_inbox_source_read.sql", "utf8");
const correctedSql = readFileSync("supabase/migrations/20260919161700_mark_portal_inbox_source_read_resident_scope.sql", "utf8");
const functionSignature = "public.mark_portal_inbox_source_read(text,text,uuid,text,text,timestamptz,jsonb)";
const managerScope = "axis_portal_inbox_manager_v1";
const residentScope = "axis_portal_inbox_resident_v1";
const owner = "00000000-0000-0000-0000-000000000001";
const otherOwner = "00000000-0000-0000-0000-000000000002";
const timestamp = "2026-09-19T12:00:00.000Z";
const snapshot = { folder: "inbox", unread: true, message: "keep me" };

describeDisposable("resident inbox source-read disposable PostgreSQL regression", () => {
  const dbName = `test_resident_read_${process.pid}`;
  let admin: pg.Client;
  let db: pg.Client;
  let createdDatabase = false;

  const row = (id: string, scope: string, rowOwner: string | null = owner, data = snapshot) => [
    id, scope, rowOwner, "resident@example.test", "portal_message", timestamp, data,
  ];
  const call = async (args: {
    id: string; scope: string; ownerUserId: string | null; participant?: string | null;
    threadType?: string | null; updatedAt?: string | null; rowData?: object;
  }) => (await db.query<{ changed: boolean }>(
    `select public.mark_portal_inbox_source_read($1,$2,$3,$4,$5,$6,$7) changed`,
    [args.id, args.scope, args.ownerUserId,
      Object.hasOwn(args, "participant") ? args.participant : "resident@example.test",
      Object.hasOwn(args, "threadType") ? args.threadType : "portal_message",
      Object.hasOwn(args, "updatedAt") ? args.updatedAt : timestamp,
      Object.hasOwn(args, "rowData") ? args.rowData : snapshot],
  )).rows[0].changed;
  const state = async (id: string) => (await db.query<{ row_data: object; updated_at: string }>(
    "select row_data, updated_at from public.portal_inbox_thread_records where id=$1", [id],
  )).rows[0];
  const functionState = async () => (await db.query<{
    definition: string; owner: string; config: unknown[]; acl: unknown[]; securityDefiner: boolean;
  }>("select pg_get_functiondef(f.oid) definition, pg_get_userbyid(f.proowner) owner, to_jsonb(f.proconfig) config, to_jsonb(f.proacl) acl, f.prosecdef \"securityDefiner\" from pg_proc f where f.oid=$1::regprocedure", [functionSignature])).rows[0];
  const reset = async () => {
    await db.query(originalSql);
    await db.query("truncate supabase_migrations.schema_migrations");
    await db.query("insert into supabase_migrations.schema_migrations values ($1,$2,$3)", ["20260913170000", "mark_portal_inbox_source_read", [originalSql]]);
    await db.query("delete from public.portal_inbox_thread_records");
    const first = row("resident-source", residentScope);
    const second = row("manager-source", managerScope);
    await db.query(
      "insert into public.portal_inbox_thread_records(id,scope,owner_user_id,participant_email,thread_type,updated_at,row_data) values ($1,$2,$3,$4,$5,$6,$7),($8,$9,$10,$4,$5,$6,$7)",
      [...first, ...second.slice(0, 3)],
    );
  };

  beforeAll(async () => {
    admin = new pg.Client({ connectionString, connectionTimeoutMillis: 5000 });
    await admin.connect();
    await admin.query(`create database "${dbName}"`);
    createdDatabase = true;
    const fixtureUrl = new URL(connectionString);
    fixtureUrl.pathname = `/${dbName}`;
    db = new pg.Client({ connectionString: fixtureUrl.toString(), connectionTimeoutMillis: 5000 });
    await db.connect();
    await db.query(`
      do $$ begin create role anon; exception when duplicate_object then null; end $$;
      do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
      do $$ begin create role service_role; exception when duplicate_object then null; end $$;
      create table public.portal_inbox_thread_records (
        id text primary key, scope text not null, owner_user_id uuid,
        participant_email text, thread_type text, row_data jsonb not null,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now()
      );
      create schema supabase_migrations;
      create table supabase_migrations.schema_migrations(version text primary key, name text not null, statements text[]);`);
    await db.query(originalSql);
  });

  beforeEach(reset);

  const evidence = async () => ({
    ledger: (await db.query("select * from supabase_migrations.schema_migrations order by version")).rows,
    inbox_function: await functionState(),
  });
  const applyGuarded = async (sql: string, failAfterDdl = false) => {
    await db.query("begin");
    try {
      await db.query(sql);
      if (failAfterDdl) await db.query("select no_such_resident_read_object");
      // Model the pinned CLI's history insert in the same transaction; this is
      // not an assertion about the CLI parser's exact statement segmentation.
      await db.query("insert into supabase_migrations.schema_migrations values ($1,$2,$3)", [RESIDENT_IDENTITY.slice(0, 14), RESIDENT_IDENTITY.slice(15), [sql]]);
      await db.query("commit");
    } catch (error) { await db.query("rollback"); throw error; }
  };

  it("proves the original installed function rejects an owned resident source", async () => {
    await db.query(residentFunctionGuardSql(await functionState()));
    expect(await call({ id: "resident-source", scope: residentScope, ownerUserId: owner })).toBe(false);
    expect((await state("resident-source")).row_data).toEqual(snapshot);
  });

  it("rolls back a forced replacement failure, then applies the actual migration", async () => {
    const before = await evidence(), sql = guardedResidentMigrationSql(before);
    await expect(applyGuarded(sql, true)).rejects.toThrow();
    expect(await evidence()).toEqual(before);
    await applyGuarded(sql);
    expect(await functionState()).toEqual(expectedResidentFunction(before.inbox_function));
    expect((await evidence()).ledger).toEqual([...before.ledger, { version: RESIDENT_IDENTITY.slice(0, 14), name: RESIDENT_IDENTITY.slice(15), statements: [sql] }]);
  });

  it("rejects stale ledger and function metadata before changing the function", async () => {
    const before = await evidence(), sql = guardedResidentMigrationSql(before);
    await db.query("update supabase_migrations.schema_migrations set statements=array['different bytes']");
    await expect(applyGuarded(sql)).rejects.toThrow(/full ledger differs/);
    expect(await functionState()).toEqual(before.inbox_function);
    await reset();
    await db.query(`alter function ${functionSignature} set search_path='public'`);
    const changed = await functionState();
    await expect(applyGuarded(sql)).rejects.toThrow(/function contract differs/);
    expect(await functionState()).toEqual(changed);
    expect((await evidence()).ledger).toEqual(before.ledger);
  });

  it("updates owned resident and manager sources once while preserving JSON and advancing time", async () => {
    const original = await functionState();
    expect(await call({ id: "resident-source", scope: residentScope, ownerUserId: owner })).toBe(false);
    await applyGuarded(guardedResidentMigrationSql(await evidence()));
    await db.query(residentFunctionGuardSql(await functionState()));
    await db.query(
      "insert into portal_inbox_thread_records(id,scope,owner_user_id,participant_email,thread_type,updated_at,row_data) values ($1,$2,$3,$4,$5,$6,$7)",
      row("unrelated", "axis_portal_inbox_vendor_v1", otherOwner),
    );
    const unrelatedBefore = await state("unrelated");
    expect(await call({ id: "resident-source", scope: residentScope, ownerUserId: owner })).toBe(true);
    expect(await call({ id: "manager-source", scope: managerScope, ownerUserId: owner })).toBe(true);
    expect((await state("resident-source")).row_data).toEqual({ ...snapshot, unread: false });
    expect((await state("manager-source")).row_data).toEqual({ ...snapshot, unread: false });
    expect(await state("unrelated")).toEqual(unrelatedBefore);
    // Compare in PostgreSQL so the guaranteed one-microsecond increment is not
    // truncated by JavaScript Date when the captured timestamp is in the future.
    const advanced = (await db.query("select id, updated_at > $1::timestamptz advanced from portal_inbox_thread_records where id in ('resident-source','manager-source') order by id", [timestamp])).rows;
    expect(advanced).toEqual([{ id: "manager-source", advanced: true }, { id: "resident-source", advanced: true }]);
    expect(await call({ id: "resident-source", scope: residentScope, ownerUserId: owner })).toBe(false);
    await db.query("grant select, update on public.portal_inbox_thread_records to service_role");
    await db.query("update portal_inbox_thread_records set row_data=$1,updated_at=$2 where id='manager-source'", [snapshot, timestamp]);
    await db.query("begin");
    try {
      await db.query("set local role service_role");
      expect(await call({ id: "manager-source", scope: managerScope, ownerUserId: owner })).toBe(true);
      await db.query("commit");
    } catch (error) { await db.query("rollback"); throw error; }
    expect((await state("manager-source")).row_data).toEqual({ ...snapshot, unread: false });
    const ledger = (await evidence()).ledger;
    await db.query("begin");
    try {
      await db.query(ledgerGuardSql(ledger));
      await db.query(residentRecoverySql(original));
      await db.query("insert into supabase_migrations.schema_migrations values ('20260919161701','resident_read_recovery',array['fixture recovery'])");
      await db.query("commit");
    } catch (error) { await db.query("rollback"); throw error; }
    expect(await functionState()).toEqual(original);
    expect((await evidence()).ledger.slice(0, ledger.length)).toEqual(ledger);
  });

  it.each([
    ["empty id", { id: "" }],
    ["scope mismatch", { scope: managerScope }],
    ["owner mismatch", { ownerUserId: otherOwner }],
    ["null supplied owner", { ownerUserId: null }],
    ["participant mismatch", { participant: "other@example.test" }],
    ["thread mismatch", { threadType: "team" }],
    ["stale timestamp", { updatedAt: "2026-09-19T12:00:01.000Z" }],
    ["null timestamp", { updatedAt: null }],
    ["null participant mismatch", { participant: null }],
    ["null thread mismatch", { threadType: null }],
    ["changed snapshot", { rowData: { ...snapshot, message: "changed" } }],
  ])("rejects %s without changing the source", async (_name, override) => {
    await db.query(correctedSql);
    const before = await state("resident-source");
    expect(await call({ id: "resident-source", scope: residentScope, ownerUserId: owner, ...override })).toBe(false);
    expect(await state("resident-source")).toEqual(before);
  });

  it.each(["axis_portal_inbox_vendor_v1", "admin", "axis_portal_inbox_admin_v1", "unknown"])("rejects forbidden scope %s even when row and argument agree", async (scope) => {
    await db.query("update portal_inbox_thread_records set scope=$1 where id='resident-source'", [scope]);
    await db.query(correctedSql);
    const before = await state("resident-source");
    expect(await call({ id: "resident-source", scope, ownerUserId: owner })).toBe(false);
    expect(await state("resident-source")).toEqual(before);
  });

  it("rejects a matching snapshot of an actual trash row", async () => {
    const trash = { ...snapshot, folder: "trash" };
    await db.query(correctedSql);
    await db.query("update portal_inbox_thread_records set row_data=$1 where id='resident-source'", [trash]);
    const before = await state("resident-source");
    expect(await call({ id: "resident-source", scope: residentScope, ownerUserId: owner, rowData: trash })).toBe(false);
    expect(await state("resident-source")).toEqual(before);
  });

  it("rejects ownerless rows and keeps execution private", async () => {
    await db.query("update portal_inbox_thread_records set owner_user_id=null where id='resident-source'");
    await db.query(correctedSql);
    expect(await call({ id: "resident-source", scope: residentScope, ownerUserId: owner })).toBe(false);
    const privileges = (await db.query(`select has_function_privilege('anon','${functionSignature}','execute') anon_execute, has_function_privilege('authenticated','${functionSignature}','execute') authenticated_execute, has_function_privilege('service_role','${functionSignature}','execute') service_execute, not exists(select 1 from aclexplode(coalesce(proacl,acldefault('f',proowner))) where grantee=0) public_execute from pg_proc where oid='${functionSignature}'::regprocedure`)).rows[0];
    expect(privileges).toEqual({ anon_execute: false, authenticated_execute: false, service_execute: true, public_execute: true });
  });

  afterAll(async () => {
    await db?.end();
    try { if (createdDatabase) await admin.query(`drop database "${dbName}"`); }
    finally { await admin?.end(); }
  });
});
