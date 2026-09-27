#!/usr/bin/env node
/** Separate, exact-target operation for the two September 13 parity gaps. */
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { backup, connect, credential } from "./sms-durability-release-migrations.mjs";
import { SMS_RELEASE_TARGETS, sha256 } from "./sms-durability-release-manifest.mjs";

const MIGRATIONS = Object.freeze([
  { version: "20260913000000", name: "payment_reminder_occurrences", hash: "49e4829408198c0256939517cb4d0c49d5df4b51cc8c93ca0e2549e853f015cf" },
  { version: "20260913010000", name: "scheduled_inbox_channel_claims", hash: "fb13c8d0076fd71e3e21e011855e4d66924ba49d43854165a6252e1bb90ed42b" },
]);
const TABLES = [
  "payment_reminder_occurrences", "payment_reminder_channel_deliveries",
  "payment_reminder_channel_coverage", "scheduled_inbox_channel_deliveries",
];
const INDEXES = [
  "payment_reminder_occurrences_manager_idx", "payment_reminder_occurrences_charge_ids_idx",
  "scheduled_inbox_channel_deliveries_manager_idx",
];
const RPCS = [
  "claim_payment_reminder_channel(text,uuid,text,text[],text[],text,text,text)",
  "resolve_payment_reminder_channel(text,text,uuid,text,text,text)",
  "claim_scheduled_inbox_channel(text,uuid,text)",
  "resolve_scheduled_inbox_channel(text,text,uuid,text,text)",
  "finalize_scheduled_inbox_delivery(text,uuid)",
];
const GUARD = "guard_sending_inbox_message()";
const TRIGGER = "guard_sending_inbox_message";

function options(argv) {
  const result = { phase: "preflight", applyAuthorized: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--target") result.target = argv[++i];
    else if (argv[i] === "--phase") result.phase = argv[++i];
    else if (argv[i] === "--backup-file") result.backupFile = argv[++i];
    else if (argv[i] === "--apply-authorized") result.applyAuthorized = true;
    else throw new Error("Unknown parity-gap option");
  }
  if (!Object.hasOwn(SMS_RELEASE_TARGETS, result.target) || !["preflight", "apply", "postflight"].includes(result.phase)) {
    throw new Error("Exact --target staging|production and --phase preflight|apply|postflight required");
  }
  if (result.phase !== "apply" && (result.backupFile || result.applyAuthorized)) throw new Error("Apply options are invalid for read-only phases");
  if (result.phase === "apply") {
    if (!result.applyAuthorized || !result.backupFile) throw new Error("Apply requires --apply-authorized and a new --backup-file");
    const file = resolve(result.backupFile);
    if (dirname(file) !== "/private/tmp" || !basename(file).startsWith(`sms-parity-gap-${result.target}-`) || !file.endsWith(".dump")) {
      throw new Error("Backup must be a new target-named .dump directly under /private/tmp");
    }
    result.backupFile = file;
  }
  return result;
}

function reviewedMigrations() {
  return MIGRATIONS.map((entry) => {
    const sql = readFileSync(new URL(`../supabase/migrations/${entry.version}_${entry.name}.sql`, import.meta.url), "utf8");
    if (sha256(sql) !== entry.hash) throw new Error(`Parity-gap source hash changed: ${entry.version}`);
    return { ...entry, sql };
  });
}

async function ledger(client, migrations, applied) {
  const rows = (await client.query(
    "select version,name,statements from supabase_migrations.schema_migrations where version=any($1::text[]) or name=any($2::text[]) order by version",
    [migrations.map((m) => m.version), migrations.map((m) => m.name)],
  )).rows;
  if (!applied && rows.length) throw new Error("Parity-gap ledger already contains a reviewed version or name");
  if (applied && (rows.length !== migrations.length || migrations.some((m) => {
    const row = rows.find((r) => r.version === m.version);
    return !row || row.name !== m.name || !Array.isArray(row.statements) || sha256(row.statements.join("\n")) !== m.hash;
  }))) throw new Error("Parity-gap ledger differs from reviewed SQL");
}

async function prerequisites(client) {
  const row = (await client.query("select to_regclass('auth.users') is not null users, to_regclass('public.portal_scheduled_inbox_message_records') is not null scheduled, to_regprocedure('pg_catalog.gen_random_uuid()') is not null uuid")).rows[0];
  if (!row.users || !row.scheduled || !row.uuid) throw new Error("Parity-gap prerequisite missing");
  const columns = (await client.query(`select attname, format_type(atttypid,atttypmod) type from pg_attribute
    where attrelid='public.portal_scheduled_inbox_message_records'::regclass and attnum>0 and not attisdropped`)).rows;
  const byName = new Map(columns.map((column) => [column.attname, column.type]));
  for (const [name, type] of [["id", "text"], ["manager_user_id", "uuid"], ["status", "text"], ["updated_at", "timestamp with time zone"], ["row_data", "jsonb"]]) {
    if (byName.get(name) !== type) throw new Error(`Scheduled inbox prerequisite differs: ${name}`);
  }
}

async function absentCatalog(client) {
  for (const name of [...TABLES, ...INDEXES]) {
    if ((await client.query("select to_regclass($1) object", [`public.${name}`])).rows[0].object) throw new Error(`Parity-gap object already exists: ${name}`);
  }
  const names = [...RPCS, GUARD].map((name) => name.split("(")[0]);
  const functions = (await client.query(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname=any($1::text[])`, [names])).rows;
  if (functions.length) throw new Error(`Parity-gap function name already exists: ${functions[0].proname}`);
  const trigger = (await client.query("select 1 from pg_trigger where tgrelid='public.portal_scheduled_inbox_message_records'::regclass and tgname=$1", [TRIGGER])).rows;
  if (trigger.length) throw new Error("Parity-gap trigger already exists");
}

async function appliedCatalog(client) {
  const names = [...RPCS, GUARD].map((name) => name.split("(")[0]);
  const functionNames = (await client.query(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname=any($1::text[])`, [names])).rows;
  if (functionNames.length !== names.length || names.some((name) => functionNames.filter((row) => row.proname === name).length !== 1)) {
    throw new Error("Parity-gap function overload or missing function");
  }
  for (const name of TABLES) {
    const row = (await client.query(`select c.relkind, c.relrowsecurity,
      has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') anon_access,
      has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') auth_access,
      has_table_privilege('service_role',c.oid,'SELECT') service_select,
      has_table_privilege('service_role',c.oid,'INSERT') service_insert,
      has_table_privilege('service_role',c.oid,'UPDATE') service_update,
      has_table_privilege('service_role',c.oid,'DELETE') service_delete
      from pg_class c where c.oid=to_regclass($1)`, [`public.${name}`])).rows[0];
    if (!row || row.relkind !== "r" || !row.relrowsecurity || row.anon_access || row.auth_access ||
      !row.service_select || !row.service_insert || !row.service_update || !row.service_delete) {
      throw new Error(`Parity-gap table RLS/ACL mismatch: ${name}`);
    }
  }
  for (const name of INDEXES) {
    const row = (await client.query("select i.indisvalid, i.indisready from pg_index i where i.indexrelid=to_regclass($1)", [`public.${name}`])).rows[0];
    if (!row?.indisvalid || !row.indisready) throw new Error(`Parity-gap index invalid: ${name}`);
  }
  for (const name of RPCS) {
    const row = (await client.query(`select p.prosecdef, p.proconfig,
      has_function_privilege('anon',p.oid,'EXECUTE') anon_access,
      has_function_privilege('authenticated',p.oid,'EXECUTE') auth_access,
      has_function_privilege('service_role',p.oid,'EXECUTE') service_access
      from pg_proc p where p.oid=to_regprocedure($1)`, [`public.${name}`])).rows[0];
    if (!row?.prosecdef || !row.proconfig?.includes("search_path=public, pg_temp") ||
      row.anon_access || row.auth_access || !row.service_access) throw new Error(`Parity-gap RPC ACL mismatch: ${name}`);
  }
  const trigger = (await client.query(`select t.tgenabled, t.tgtype,
      t.tgfoid=to_regprocedure($1) bound
      from pg_trigger t where t.tgrelid='public.portal_scheduled_inbox_message_records'::regclass
      and t.tgname=$2 and not t.tgisinternal`, [`public.${GUARD}`, TRIGGER])).rows;
  if (trigger.length !== 1 || trigger[0].tgenabled !== "O" || trigger[0].tgtype !== 27 || !trigger[0].bound) {
    throw new Error("Parity-gap guard trigger mismatch");
  }
}

async function catalog(client, migrations, applied) {
  await ledger(client, migrations, applied);
  await prerequisites(client);
  if (applied) await appliedCatalog(client);
  else await absentCatalog(client);
}

async function readOnlyCatalog(client, migrations, applied) {
  await client.query("begin read only");
  try {
    await client.query("set local role postgres");
    await catalog(client, migrations, applied);
  } finally {
    await client.query("rollback").catch(() => undefined);
  }
}

async function main() {
  const selected = options(process.argv.slice(2));
  const migrations = reviewedMigrations();
  const config = credential(SMS_RELEASE_TARGETS[selected.target]);
  let client = await connect(config);
  try {
    if (selected.phase === "postflight") {
      await readOnlyCatalog(client, migrations, true);
      console.log(JSON.stringify({ target: selected.target, projectRef: SMS_RELEASE_TARGETS[selected.target], phase: "postflight", ledger: "two_exact", catalog: "verified" }));
      return;
    }
    await readOnlyCatalog(client, migrations, false);
    if (selected.phase === "preflight") {
      console.log(JSON.stringify({ target: selected.target, projectRef: SMS_RELEASE_TARGETS[selected.target], phase: "preflight", ready: true,
        migrations: migrations.map(({ version, hash }) => ({ version, hash })) }));
      return;
    }
    backup(config, selected.backupFile);
    await client.query("begin");
    let commitAttempted = false;
    try {
      await client.query("set local role postgres");
      await client.query("set local lock_timeout='3s'");
      await client.query("set local statement_timeout='60s'");
      const locked = (await client.query("select pg_try_advisory_xact_lock(20260913000000::bigint) acquired")).rows[0];
      if (!locked?.acquired) throw new Error("Parity-gap migration lock unavailable");
      await catalog(client, migrations, false);
      for (const migration of migrations) {
        await client.query(migration.sql);
        await client.query("insert into supabase_migrations.schema_migrations(version,name,statements) values($1,$2,$3)",
          [migration.version, migration.name, [migration.sql]]);
      }
      await catalog(client, migrations, true);
      commitAttempted = true;
      await client.query("commit");
    } catch (error) {
      if (!commitAttempted) await client.query("rollback").catch(() => undefined);
      throw error;
    }
    await client.end();
    client = await connect(config);
    await readOnlyCatalog(client, migrations, true);
    console.log(JSON.stringify({ target: selected.target, projectRef: SMS_RELEASE_TARGETS[selected.target], phase: "apply",
      outcome: "committed_and_verified", backupFile: selected.backupFile, ledger: "two_exact", catalog: "verified" }));
  } finally {
    await client.end().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error("Parity-gap operation failed. Commit outcome may be uncertain; inspect exact target read-only before retrying.");
    process.exitCode = 1;
  });
}
