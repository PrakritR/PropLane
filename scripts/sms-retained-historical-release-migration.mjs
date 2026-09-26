#!/usr/bin/env node
/** Exact-target additive retained-source migration. Preflight is read-only. */
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { backup, connect, credential } from "./sms-durability-release-migrations.mjs";
import { TARGETS, MIGRATION as SEVENTH, reviewedSource as reviewedSeventh, catalog as seventhCatalog,
  functionBody } from "./sms-completed-receipt-release-migration.mjs";
import { sha256 } from "./sms-durability-release-manifest.mjs";

export const MIGRATION = Object.freeze({
  version: "20260926190000", name: "sms_retained_historical_source",
  hash: "a829b4cf30cebc57e50ca486318e7751cf6823ff3c451e9d3038d6c267eba0f6",
});
const BACKUP_DIR = join(homedir(), ".codex", "release-backups", "sms-20260926");
const FUNCTIONS = [
  ["resolve_sms_retained_historical_source", "resolve_sms_retained_historical_source(text,text)", "v"],
  ["import_sms_retained_historical_source", "import_sms_retained_historical_source(text,text)", "v"],
];

export function parseOptions(argv) {
  const out = { phase: "preflight", applyAuthorized: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--target") out.target = argv[++i];
    else if (argv[i] === "--phase") out.phase = argv[++i];
    else if (argv[i] === "--backup-file") out.backupFile = argv[++i];
    else if (argv[i] === "--apply-authorized") out.applyAuthorized = true;
    else throw new Error("Unknown retained-source migration option");
  }
  if (!Object.hasOwn(TARGETS, out.target) || !["preflight", "apply", "postflight"].includes(out.phase)) {
    throw new Error("Exact --target dev|staging|production and --phase preflight|apply|postflight required");
  }
  if (out.phase !== "apply" && (out.backupFile || out.applyAuthorized)) throw new Error("Apply options in read-only phase");
  if (out.phase === "apply") {
    if (!out.applyAuthorized || !out.backupFile) throw new Error("Apply requires authorization and a fresh backup file");
    const file = resolve(out.backupFile);
    if (dirname(file) !== BACKUP_DIR || realpathSync(dirname(file)) !== BACKUP_DIR ||
        !lstatSync(dirname(file)).isDirectory() || (lstatSync(dirname(file)).mode & 0o777) !== 0o700 ||
        !basename(file).startsWith(`sms-retained-${out.target}-`) || !basename(file).endsWith(".dump")) {
      throw new Error("Backup must be a target-named .dump in the private release directory");
    }
    out.backupFile = file;
  }
  return out;
}

export function reviewedSource() {
  const seventh = reviewedSeventh();
  const sql = readFileSync(new URL(`../supabase/migrations/${MIGRATION.version}_${MIGRATION.name}.sql`, import.meta.url), "utf8");
  if (sha256(sql) !== MIGRATION.hash || Buffer.byteLength(sql) > 60_000) throw new Error("Retained-source SQL differs from reviewed source");
  if (FUNCTIONS.some(([name]) => !functionBody(sql, name))) throw new Error("Retained function missing");
  return { seventh, sql };
}

async function ledger(client, source, applied) {
  const rows = (await client.query(`select version,name,statements from supabase_migrations.schema_migrations
    where version=any($1::text[]) or name=any($2::text[])`,
  [[SEVENTH.version, MIGRATION.version], [SEVENTH.name, MIGRATION.name]])).rows;
  const seventh = rows.filter((row) => row.version === SEVENTH.version || row.name === SEVENTH.name);
  if (seventh.length !== 1 || seventh[0].version !== SEVENTH.version || seventh[0].name !== SEVENTH.name ||
      !Array.isArray(seventh[0].statements) || sha256(seventh[0].statements.join("\n")) !== SEVENTH.hash) {
    throw new Error("Seventh SMS migration ledger differs");
  }
  const eighth = rows.filter((row) => row.version === MIGRATION.version || row.name === MIGRATION.name);
  if ((!applied && eighth.length) || (applied && (eighth.length !== 1 || eighth[0].version !== MIGRATION.version ||
      eighth[0].name !== MIGRATION.name || !Array.isArray(eighth[0].statements) ||
      sha256(eighth[0].statements.join("\n")) !== MIGRATION.hash))) {
    throw new Error("Retained-source ledger differs");
  }
}

export async function catalog(client, source, applied) {
  await seventhCatalog(client, source.seventh, true);
  await ledger(client, source, applied);
  const prerequisites = (await client.query(`select
    to_regclass('public.manager_sms_messages') is not null mirror,
    to_regclass('public.inbound_sms_log') is not null source,
    to_regclass('public.sms_inbound_receipts') is not null receipt,
    to_regclass('public.sms_projection_deleted_events') is not null tombstone`)).rows[0];
  if (!prerequisites || Object.values(prerequisites).some((value) => value !== true)) {
    throw new Error("Retained-source prerequisite missing");
  }
  for (const [name, signature, volatility] of FUNCTIONS) {
    const overloads = (await client.query(`select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=$1`, [name])).rows;
    if (overloads.length !== (applied ? 1 : 0)) throw new Error(`Retained function overload mismatch: ${name}`);
    if (!applied) continue;
    const rows = (await client.query(`select p.prosrc,p.prosecdef,p.provolatile,p.proconfig,
      pg_get_userbyid(p.proowner) owner,
      has_function_privilege('anon',p.oid,'EXECUTE') anon_access,
      has_function_privilege('authenticated',p.oid,'EXECUTE') auth_access,
      has_function_privilege('service_role',p.oid,'EXECUTE') service_access
      from pg_proc p where p.oid=to_regprocedure($1)`, [`public.${signature}`])).rows;
    const row = rows[0];
    if (rows.length !== 1 || row.prosrc !== functionBody(source.sql, name) || !row.prosecdef ||
        row.provolatile !== volatility || !row.proconfig?.includes("search_path=public, pg_temp") ||
        row.owner !== "postgres" || row.anon_access || row.auth_access || !row.service_access) {
      throw new Error(`Retained function definition/ACL mismatch: ${name}`);
    }
  }
}

async function readOnlyCatalog(client, source, applied) {
  await client.query("begin read only");
  try {
    await client.query("set local role postgres");
    await catalog(client, source, applied);
  } finally { await client.query("rollback").catch(() => undefined); }
}

export async function runMigration(options, dependencies = {}) {
  const source = (dependencies.reviewedSource ?? reviewedSource)();
  const config = (dependencies.credential ?? credential)(TARGETS[options.target]);
  const open = dependencies.connect ?? connect;
  let client = await open(config);
  try {
    if (options.phase === "postflight") {
      await readOnlyCatalog(client, source, true);
      console.log(JSON.stringify({ target: options.target, phase: "postflight", ledger: "eight_exact", catalog: "verified" }));
      return;
    }
    await readOnlyCatalog(client, source, false);
    if (options.phase === "preflight") {
      console.log(JSON.stringify({ target: options.target, phase: "preflight", migration: MIGRATION, ready: true }));
      return;
    }
    (dependencies.backup ?? backup)(config, options.backupFile);
    await client.query("begin");
    let commitAttempted = false;
    try {
      await client.query("set local role postgres");
      await client.query("set local lock_timeout='3s'");
      await client.query("set local statement_timeout='60s'");
      const lock = (await client.query("select pg_try_advisory_xact_lock(20260926190000::bigint) acquired")).rows[0];
      if (!lock?.acquired) throw new Error("Retained-source migration lock unavailable");
      await catalog(client, source, false);
      await client.query(source.sql);
      await client.query("insert into supabase_migrations.schema_migrations(version,name,statements) values($1,$2,$3)",
        [MIGRATION.version, MIGRATION.name, [source.sql]]);
      await catalog(client, source, true);
      commitAttempted = true;
      await client.query("commit");
    } catch (error) {
      if (!commitAttempted) await client.query("rollback").catch(() => undefined);
      throw error;
    }
    await client.end();
    client = await open(config);
    await readOnlyCatalog(client, source, true);
    console.log(JSON.stringify({ target: options.target, phase: "apply", outcome: "committed_and_verified",
      backupFile: options.backupFile, ledger: "eight_exact", catalog: "verified" }));
  } finally { await client.end().catch(() => undefined); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runMigration(parseOptions(process.argv.slice(2))).catch(() => {
    console.error("Retained-source migration failed. Inspect exact ledger and catalog before retrying.");
    process.exitCode = 1;
  });
}
