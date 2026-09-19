import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import { expectedFunctionAfter, functionRecoverySql, functionGuardSql, historyNameRecoverySql, CATALOG_SQL, catalogGuardSql, ledgerGuardSql, renameHistorySql } from "../../scripts/release-conversation-schema-reconciliation.mjs";

const enabled = process.env.RELEASE_RECONCILIATION_DISPOSABLE_PG === "1";
const connectionString = process.env.RELEASE_RECONCILIATION_PG_URL ?? "";
let parsed: URL | undefined;
try { parsed = new URL(connectionString); } catch { parsed = undefined; }
const isLocal = !!parsed && ["postgres:", "postgresql:"].includes(parsed.protocol) && ["localhost", "127.0.0.1"].includes(parsed.hostname) && !parsed.search && !parsed.hash;
if (enabled && !isLocal) throw new Error("Disposable reconciliation requires an explicit loopback PostgreSQL URL without overrides");
const describeDisposable = enabled ? describe : describe.skip;

const baseline = [
  { version: "20260916000000", name: "automated_communication_reminder_kinds", statements: ["select old;"], extra: "one", checksum: null },
  { version: "20260916063005", name: "automated_communication_reminder_kinds", statements: ["create table x;\ncomment on table x is 'preserve  whitespace';\n"], extra: "two", checksum: null },
];

describeDisposable("disposable release reconciliation fixture", () => {
  const dbName = `test_reconciliation_${process.pid}`;
  let admin: pg.Client | undefined;
  let client: pg.Client;
  let createdDatabase = false;
  const rows = async () => (await client.query("select * from supabase_migrations.schema_migrations order by version")).rows;
  const transaction = async (sql: string, version = "20260919020000", name = "release_reminder_history_name_reconciliation") => {
    await client.query("begin");
    try {
      await client.query("set local lock_timeout='3s'; set local statement_timeout='10s'; lock table supabase_migrations.schema_migrations in exclusive mode");
      await client.query(sql);
      // Models the supported CLI's INSERT in the same implicit transaction.
      await client.query("insert into supabase_migrations.schema_migrations(version,name,statements) values ($1,$2,$3)", [version, name, [sql]]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  };

  beforeAll(async () => {
    admin = new pg.Client({ connectionString, connectionTimeoutMillis: 5000 });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    createdDatabase = true;
    const fixtureUrl = new URL(connectionString);
    fixtureUrl.pathname = `/${dbName}`;
    client = new pg.Client({ connectionString: fixtureUrl.toString(), connectionTimeoutMillis: 5000 });
    await client.connect();
    await client.query("create schema supabase_migrations");
    await client.query("create table supabase_migrations.schema_migrations (version text primary key, name text not null, statements text[], extra text, checksum text)");
    await client.query("create table public.portal_workspaces(id integer primary key, alternate integer unique)");
    await client.query("create table public.account_link_invites(id integer primary key, workspace_id integer references public.portal_workspaces(id), score integer check(score>=0))");
    await client.query("create table public.manager_invite_links(id integer primary key)");
    await client.query("create table public.external_calendar_connections(id integer primary key)");
  });

  beforeEach(async () => {
    await client.query("truncate supabase_migrations.schema_migrations");
    for (const row of baseline) await client.query("insert into supabase_migrations.schema_migrations values ($1,$2,$3,$4,$5)", [row.version, row.name, row.statements, row.extra, row.checksum]);
  });

  it("changes only the intended name, retains the exact statement array, and records truthful SQL", async () => {
    const sql = `${ledgerGuardSql(baseline)}\n${renameHistorySql(baseline)}`;
    await transaction(sql);
    const actual = await rows();
    expect(actual.slice(0, 2)).toEqual(baseline.map(row => row.version === "20260916063005" ? { ...row, name: "automated_communication_reminder_kinds_reapplied_20260916063005" } : row));
    expect(actual[2].statements).toEqual([sql]);
    expect(actual).toHaveLength(3);
  });

  it("executes six sequential guards from actual recorded SQL with bounded growth", async () => {
    await client.query("update supabase_migrations.schema_migrations set extra=$1, statements=$2 where version=$3", ["$ledger_guard$ $ledger_guard_1$", ["select '$ledger_guard$';\n", "select '雪😀 and apostrophe '' and slash \\';  "], baseline[0].version]);
    const original = await rows();
    const sizes: number[] = [];
    for (let step = 0; step < 6; step++) {
      const before = await rows();
      const sql = ledgerGuardSql(before);
      sizes.push(Buffer.byteLength(sql));
      await transaction(sql, `2026091903000${step}`, `sequential_${step}`);
      const after = await rows();
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.at(-1).statements).toEqual([sql]);
    }
    expect((await rows()).slice(0, 2)).toEqual(original);
    expect(sizes[5] - sizes[0]).toBeLessThan(4000);
  });

  it.each([
    ["whitespace", ["select 'é'; ", "second"]],
    ["unicode normalization", ["select 'é';", "second"]],
    ["backslash", ["select 'é';\\", "second"]],
    ["order", ["second", "select 'é';"]],
    ["null", null],
    ["empty", []],
  ])("rejects exact-byte or array-shape drift: %s", async (_kind, changed) => {
    await client.query("update supabase_migrations.schema_migrations set statements=$1 where version=$2", [["select 'é';", "second"], baseline[0].version]);
    const captured = await rows();
    await client.query("update supabase_migrations.schema_migrations set statements=$1 where version=$2", [changed, baseline[0].version]);
    const before = await rows();
    await expect(transaction(ledgerGuardSql(captured))).rejects.toThrow(/ledger/);
    expect(await rows()).toEqual(before);
  });

  it("distinguishes null and empty arrays and rejects multidimensional arrays", async () => {
    await client.query("update supabase_migrations.schema_migrations set statements=null where version=$1", [baseline[0].version]);
    await client.query("update supabase_migrations.schema_migrations set statements='{}'::text[] where version=$1", [baseline[1].version]);
    const captured = await rows();
    await client.query(ledgerGuardSql(captured));
    await client.query("update supabase_migrations.schema_migrations set statements='{}'::text[] where version=$1", [baseline[0].version]);
    await expect(transaction(ledgerGuardSql(captured))).rejects.toThrow(/ledger/);
    await client.query("update supabase_migrations.schema_migrations set statements=array[['one','two']] where version=$1", [baseline[0].version]);
    const flatExpected = (await rows()).map(row => row.version === baseline[0].version ? { ...row, statements: ["one", "two"] } : row);
    await expect(transaction(ledgerGuardSql(flatExpected))).rejects.toThrow(/dimensions/);
  });

  it("rehearses a new guarded name-only recovery without rewriting existing history", async () => {
    await transaction(`${ledgerGuardSql(baseline)}\n${renameHistorySql(baseline)}`);
    const corrected = await rows();
    const recovery = historyNameRecoverySql(corrected);
    await expect(transaction(`${recovery}\ndo $$ begin raise exception 'recovery rollback'; end $$;`, "20260919040000", "name_recovery")).rejects.toThrow(/recovery rollback/);
    expect(await rows()).toEqual(corrected);
    await transaction(recovery, "20260919040000", "name_recovery");
    const recovered = await rows();
    expect(recovered.slice(0, 2)).toEqual(baseline);
    expect(recovered[2]).toEqual(corrected[2]);
    expect(recovered[3].statements).toEqual([recovery]);
  });

  it("rehearses function recovery with unchanged owner, configuration and ACL", async () => {
    await client.query(`create or replace function public.persist_lease_with_action_event(p_record jsonb, p_expected_updated_at timestamptz, p_event jsonb default null) returns text language plpgsql security definer set search_path=public,pg_temp as $$ begin return '$function_guard$ original'; end $$;
      revoke all on function public.persist_lease_with_action_event(jsonb,timestamptz,jsonb) from public;`);
    const captureFunction = async () => (await client.query(`select pg_get_functiondef(f.oid) as definition, pg_get_userbyid(f.proowner) as owner, to_jsonb(f.proconfig) as config, to_jsonb(f.proacl) as acl from pg_proc f where f.oid='public.persist_lease_with_action_event(jsonb,timestamptz,jsonb)'::regprocedure`)).rows[0];
    try {
      const original = await captureFunction();
      const corrected = expectedFunctionAfter(original);
      // Compile only. No application RPC or business table access occurs.
      await client.query(corrected.definition);
      expect(await captureFunction()).toEqual(corrected);
      await client.query(functionGuardSql(corrected));
      const recovery = functionRecoverySql(corrected, original);
      const before = await rows();
      await expect(transaction(`${ledgerGuardSql(before)}\n${recovery}\ndo $$ begin raise exception 'function rollback'; end $$;`, "20260919050000", "function_recovery")).rejects.toThrow(/function rollback/);
      expect(await captureFunction()).toEqual(corrected);
      expect(await rows()).toEqual(before);
      await transaction(`${ledgerGuardSql(before)}\n${recovery}`, "20260919050000", "function_recovery");
      expect(await captureFunction()).toEqual(original);
      expect((await rows()).slice(0, before.length)).toEqual(before);
      expect(() => functionRecoverySql({ ...corrected, owner: "changed" }, original)).toThrow(/corrected function/);
    } finally {
      await client.query("drop function public.persist_lease_with_action_event(jsonb,timestamptz,jsonb)");
    }
  });

  it.each(["payload", "name", "missing duplicate", "dimensions"])("rejects %s drift without changing history", async (kind) => {
    if (kind === "payload") await client.query("update supabase_migrations.schema_migrations set statements=array['different'] where version='20260916063005'");
    if (kind === "name") await client.query("update supabase_migrations.schema_migrations set name='different' where version='20260916063005'");
    if (kind === "missing duplicate") await client.query("delete from supabase_migrations.schema_migrations where version='20260916000000'");
    if (kind === "dimensions") await client.query("update supabase_migrations.schema_migrations set statements=array_fill(statements[1],array[1],array[0]) where version='20260916063005'");
    const before = await rows();
    await expect(transaction(`${ledgerGuardSql(baseline)}\n${renameHistorySql(baseline)}`)).rejects.toThrow(/ledger/);
    expect(await rows()).toEqual(before);
  });

  it("rolls the rename back when a later guard fails, with no new history row", async () => {
    await expect(transaction(`${ledgerGuardSql(baseline)}\n${renameHistorySql(baseline)}\ndo $$ begin raise exception 'forced later guard'; end $$;`)).rejects.toThrow(/forced later guard/);
    expect(await rows()).toEqual(baseline);
  });

  it.each(["foreign key", "tightened check", "invalid index"])("rejects changed %s catalog before DDL", async (kind) => {
    const capture = (await client.query(`select ${CATALOG_SQL} as catalog`)).rows[0].catalog;
    await client.query(catalogGuardSql(capture));
    try {
      if (kind === "foreign key") await client.query("alter table public.account_link_invites drop constraint account_link_invites_workspace_id_fkey; alter table public.account_link_invites add constraint account_link_invites_workspace_id_fkey foreign key(workspace_id) references public.portal_workspaces(alternate)");
      if (kind === "tightened check") await client.query("alter table public.account_link_invites drop constraint account_link_invites_score_check; alter table public.account_link_invites add constraint account_link_invites_score_check check(score>0)");
      if (kind === "invalid index") {
        await client.query("insert into public.account_link_invites(id,score) values(1,1),(2,1)");
        await expect(client.query("create unique index concurrently fixture_invalid_index on public.account_link_invites(score)")).rejects.toThrow();
      }
      await expect(transaction(`${catalogGuardSql(capture)}\n${renameHistorySql(baseline)}`)).rejects.toThrow(/catalog differs/);
      expect(await rows()).toEqual(baseline);
    } finally {
      if (kind === "foreign key") await client.query("alter table public.account_link_invites drop constraint account_link_invites_workspace_id_fkey; alter table public.account_link_invites add constraint account_link_invites_workspace_id_fkey foreign key(workspace_id) references public.portal_workspaces(id)");
      if (kind === "tightened check") await client.query("alter table public.account_link_invites drop constraint account_link_invites_score_check; alter table public.account_link_invites add constraint account_link_invites_score_check check(score>=0)");
      if (kind === "invalid index") await client.query("drop index if exists public.fixture_invalid_index; truncate public.account_link_invites");
    }
  });

  afterAll(async () => {
    await client?.end();
    if (admin) {
      try { if (createdDatabase) await admin.query(`DROP DATABASE "${dbName}"`); }
      finally { await admin.end(); }
    }
  });
});
