#!/usr/bin/env node
/** Exact-target, reviewed SMS migration operation. Dry preflight is the default. */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SMS_RELEASE_TARGETS, assertSmsLedger, reviewedSmsMigrations, sha256 } from "./sms-durability-release-manifest.mjs";

const require = createRequire(import.meta.url);
const { Client } = require("pg");
const CA_HASH = "700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7";
const VERSIONS = ["20260925130000", "20260925140000", "20260925150000", "20260925160000", "20260925170000", "20260925180000"];
const TABLES = ["sms_projection_conversations", "sms_projection_turns", "sms_projection_aliases", "sms_projection_pending", "sms_projection_view_state", "sms_projection_cutover", "sms_projection_deleted_events", "sms_projection_ambiguous_aliases"];
const FUNCTIONS = ["project_sms_conversation_event(jsonb)", "import_sms_projection_historical_event(text,text)", "delete_sms_projection_conversation(uuid,uuid,uuid)", "bind_sms_projection_legacy_thread_alias(uuid,uuid,text,text,text,text,uuid,timestamptz,text)"];

function args(argv) {
  const options = { phase: "preflight" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--target") options.target = argv[++i];
    else if (argv[i] === "--phase") options.phase = argv[++i];
    else if (argv[i] === "--backup-file") options.backupFile = argv[++i];
    else throw new Error("Unknown SMS migration option");
  }
  if (!Object.hasOwn(SMS_RELEASE_TARGETS, options.target) || !["preflight", "apply", "postflight"].includes(options.phase)) {
    throw new Error("Exact --target staging|production and --phase preflight|apply|postflight required");
  }
  if (options.phase === "apply" && (!options.backupFile || !resolve(options.backupFile).startsWith("/private/tmp/"))) {
    throw new Error("Apply requires a new --backup-file beneath /private/tmp");
  }
  if (options.phase !== "apply" && options.backupFile) throw new Error("Backup file is only for apply");
  return options;
}

export function credential(target) {
  const workdir = mkdtempSync(join(tmpdir(), "sms-release-cli-"));
  try {
    chmodSync(workdir, 0o700);
    mkdirSync(join(workdir, "supabase"), { mode: 0o700 });
    writeFileSync(join(workdir, "supabase", "config.toml"), 'project_id = "sms-release-login"\n', { mode: 0o600 });
    const env = Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "SUPABASE_ACCESS_TOKEN"]
      .filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
    const result = spawnSync("npx", ["-y", "supabase@2.117.0", "db", "dump", "--project-ref", target,
      "--data-only", "--schema", "public", "--dry-run", "--yes"],
      { cwd: workdir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 90_000 });
    if (result.status !== 0 || result.error) throw new Error("Credential bootstrap failed");
    const values = {};
    for (const key of ["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE"]) {
      const matches = [...String(result.stdout).matchAll(new RegExp(`(?:^|\\n)export ${key}="([^"\\r\\n]+)"(?=\\r?$|\\n)`, "g"))];
      if (matches.length !== 1) throw new Error("Credential shape invalid");
      values[key] = matches[0][1];
    }
    const direct = values.PGHOST === `db.${target}.supabase.co` && values.PGUSER === "cli_login_postgres";
    const pooler = /^(?:[a-z0-9-]+\.){1,2}pooler\.supabase\.com$/.test(values.PGHOST) && values.PGUSER === `cli_login_postgres.${target}`;
    if ((!direct && !pooler) || values.PGPORT !== "5432" || values.PGDATABASE !== "postgres") throw new Error("Credential target mismatch");
    const ca = readFileSync(new URL("./lib/supabase-root-2021.crt", import.meta.url), "utf8");
    if (sha256(ca) !== CA_HASH) throw new Error("Database TLS root changed");
    return { host: values.PGHOST, port: 5432, user: values.PGUSER, password: values.PGPASSWORD,
      database: "postgres", ssl: { ca, rejectUnauthorized: true, servername: values.PGHOST },
      connectionTimeoutMillis: 15_000, statement_timeout: 60_000 };
  } finally { rmSync(workdir, { recursive: true, force: true }); }
}

export async function connect(config) {
  const client = new Client(config);
  await client.connect();
  const identity = await client.query("select current_database() db, current_user role, pg_has_role(current_user,'postgres','MEMBER') member");
  if (identity.rows.length !== 1 || identity.rows[0].db !== "postgres" || !identity.rows[0].member) {
    await client.end();
    throw new Error("Database identity/role mismatch");
  }
  return client;
}

async function ledger(client) {
  const result = await client.query("select version,name,statements from supabase_migrations.schema_migrations where version=any($1::text[]) order by version", [VERSIONS]);
  return result.rows;
}

async function readOnlyCatalog(client, migrations, applied) {
  await client.query("begin read only");
  try {
    await client.query("set local role postgres");
    const result = await catalog(client, migrations, applied);
    await client.query("rollback");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  }
}

async function catalog(client, migrations, applied) {
  assertSmsLedger(await ledger(client), migrations, { expectApplied: applied });
  const prerequisites = await client.query("select to_regclass('public.manager_sms_messages') is not null manager_log, to_regclass('public.sms_inbound_receipts') is not null receipts, to_regclass('public.portal_inbox_thread_records') is not null inbox");
  if (Object.values(prerequisites.rows[0]).some((value) => value !== true)) throw new Error("SMS migration prerequisite missing");
  if (applied) {
    for (const table of TABLES) {
      const result = await client.query("select c.relrowsecurity rls, has_table_privilege('anon',$1,'SELECT') or has_table_privilege('anon',$1,'INSERT') or has_table_privilege('anon',$1,'UPDATE') or has_table_privilege('anon',$1,'DELETE') anon_access, has_table_privilege('authenticated',$1,'SELECT') or has_table_privilege('authenticated',$1,'INSERT') or has_table_privilege('authenticated',$1,'UPDATE') or has_table_privilege('authenticated',$1,'DELETE') auth_access, has_table_privilege('service_role',$1,'SELECT') and has_table_privilege('service_role',$1,'INSERT') and has_table_privilege('service_role',$1,'UPDATE') and has_table_privilege('service_role',$1,'DELETE') service_access from pg_class c where c.oid=to_regclass($1)", [`public.${table}`]);
      if (result.rows.length !== 1 || !result.rows[0].rls || result.rows[0].anon_access || result.rows[0].auth_access || !result.rows[0].service_access) throw new Error(`SMS table ACL/RLS mismatch: ${table}`);
    }
    for (const name of FUNCTIONS) {
      const result = await client.query("select has_function_privilege('anon',$1,'EXECUTE') anon_access, has_function_privilege('authenticated',$1,'EXECUTE') auth_access, has_function_privilege('service_role',$1,'EXECUTE') service_access", [`public.${name}`]);
      if (result.rows.length !== 1 || result.rows[0].anon_access || result.rows[0].auth_access || !result.rows[0].service_access) throw new Error(`SMS function ACL mismatch: ${name}`);
    }
    const cutover = await client.query("select ready from public.sms_projection_cutover where singleton=true");
    if (cutover.rows.length !== 1) throw new Error("SMS cutover singleton missing");
    return { cutoverReady: cutover.rows[0].ready };
  }
  const absence = await client.query("select to_regclass('public.sms_projection_conversations') is null conversations_absent, to_regclass('public.sms_projection_cutover') is null cutover_absent");
  if (!absence.rows[0].conversations_absent || !absence.rows[0].cutover_absent) throw new Error("SMS schema exists without reviewed ledger");
  return {};
}

export function backup(config, file) {
  const handle = openSync(file, "wx", 0o600);
  try {
    const result = spawnSync("pg_dump", ["--format=custom", "--role=postgres", "--host", config.host,
      "--port", "5432", "--username", config.user, "--dbname", "postgres", "--file", file], {
      env: { PATH: process.env.PATH, PGPASSWORD: config.password, PGSSLMODE: "verify-full",
        PGSSLROOTCERT: new URL("./lib/supabase-root-2021.crt", import.meta.url).pathname },
      stdio: ["ignore", "ignore", "pipe"], timeout: 20 * 60_000 });
    if (result.status !== 0 || result.error) throw new Error("Database backup failed");
    const check = spawnSync("pg_restore", ["--list", file], { stdio: "ignore", timeout: 60_000 });
    if (check.status !== 0) throw new Error("Database backup archive invalid");
  } finally { closeSync(handle); }
}

async function main() {
  const options = args(process.argv.slice(2));
  const migrations = reviewedSmsMigrations();
  const target = SMS_RELEASE_TARGETS[options.target];
  const config = credential(target);
  let client = await connect(config);
  try {
    if (options.phase === "postflight") {
      const state = await readOnlyCatalog(client, migrations, true);
      console.log(JSON.stringify({ target: options.target, phase: "postflight", ledger: "six_exact", acl: "verified", ...state }));
      return;
    }
    await readOnlyCatalog(client, migrations, false);
    if (options.phase === "preflight") {
      console.log(JSON.stringify({ target: options.target, phase: "preflight", migrations: migrations.map(({ version, hash }) => ({ version, hash })), ready: true }));
      return;
    }
    backup(config, options.backupFile);
    await client.query("begin");
    let commitAttempted = false;
    try {
      await client.query("set local role postgres");
      await client.query("set local lock_timeout='3s'");
      await client.query("set local statement_timeout='60s'");
      const locked = await client.query("select pg_try_advisory_xact_lock(20260925130000::bigint) acquired");
      if (!locked.rows[0].acquired) throw new Error("SMS migration lock unavailable");
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
    const state = await readOnlyCatalog(client, migrations, true);
    console.log(JSON.stringify({ target: options.target, phase: "apply", outcome: "committed_and_verified",
      backupFile: options.backupFile, ledger: "six_exact", acl: "verified", ...state }));
  } finally { await client.end().catch(() => undefined); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error("SMS migration operation failed; inspect backup and ledger before retry."); process.exitCode = 1; });
}
