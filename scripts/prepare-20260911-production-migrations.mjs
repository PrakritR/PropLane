#!/usr/bin/env node
/**
 * Bounded manifest and one-shot apply entry point for the reviewed September
 * 11 production schema recovery. It never accepts SQL, paths, target overrides,
 * or caller-supplied apply ledger data.
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FILE_RE = /^(\d{14})_([a-z0-9_]+)\.sql$/;
const MAX_LEDGER_ROWS = 1_000;
const BUNDLE_VERSION = "20260911010000";
const BUNDLE_NAME = "production_recovery_schema";
const PRODUCTION_PROJECT = "qahnczmilgptcedaqype";
const APPROVED_WAIVER = "2026-09-11-production-recovery-schema";
const APPROVED_BUNDLE_SHA256 = "9402a949607a7856fcc97f8462f4acb0f23b395ebe12c375b24fd9b372b794ab";
const SUPABASE_ROOT_CA_SHA256 = "700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7";
const PINNED_SUPABASE = "supabase@2.117.0";
const MANIFEST = [
  ["20260907130000", "webhook_subscriptions", "61d2d745e479d2d54eac4222be9ff14f4e633c35114da7fcda46af201e90ddec"],
  ["20260907214100", "preserve_resident_financial_history", "af7ae6034951d0d11f3de5012f5c30d6d6ecc8b2009ddf8979a66717d6602833"],
  ["20260907221500", "preserve_shared_vendor_financial_history", "02db0308873dd50bd166316cfdea7b8d6c6493e9589e403d0247acc89d54dd10"],
  ["20260907223000", "account_attachment_references", "57df02789b83ac2331bf8d86f00f1994b41910169dd22b15e8626317a8b90b14"],
  ["20260907224000", "account_recovery_shared_retention", "8f5dec609a2a010cca30b468aa58b29d14442649b129f3a9c99bbb2467cb8440"],
  ["20260907224500", "account_recovery_snapshot", "4038e16e71e33294bb74a178c2385ee46bbf04ff375e4a1c084a305d9ee8c11b"],
  ["20260907225000", "account_recovery_identity_patches", "75a62df92340df4985f8f8b762e05db4ea68c4c3b51ff400464afa7ee81aaf68"],
  ["20260907225500", "account_recovery_capture", "671db1ea2ae46a7ad0b45c85185e30e80998ed2c0a611910d848a3af668a3e58"],
  ["20260907230000", "account_recovery_object_generations", "2d81ec38298e26f54f61736646ea58e803246c7cd38599bcbc91611de4f0ddcd"],
  ["20260907231000", "account_recovery_financial_access_keys", "d34d9450af3861be3a3216da423c38d62cd39ab1a83b03ba713832bca37af2fa"],
  ["20260907232000", "account_recovery_restore", "4964674ee7c106a092f3015507617f9a6dc21406d79c033d9db0de6dfc304826"],
  ["20260907233000", "account_recovery_finish_archival", "3431e5f0fe8051af1889e5bf4ed493fcd7334374f09372f6c15091066927efd3"],
];

export const CLI_MECHANISM_EVIDENCE =
  "Supabase CLI 2.117.0 is used only to acquire a temporary CLI login through its read-only db dump --dry-run command. PostgreSQL applies and verifies this bundle over one independently verified pg connection.";

function migrationDirectory() {
  return fileURLToPath(new URL("../supabase/migrations/", import.meta.url));
}

export function validateManifestEntries(entries) {
  if (!Array.isArray(entries) || entries.length !== MANIFEST.length) {
    throw new Error("Preparation manifest must contain exactly 12 entries.");
  }
  for (let index = 0; index < MANIFEST.length; index += 1) {
    if (!Array.isArray(entries[index]) || entries[index].length !== 3 ||
        entries[index].some((value, part) => value !== MANIFEST[index][part])) {
      throw new Error(`Unexpected preparation manifest entry at position ${index + 1}.`);
    }
  }
  return true;
}

export function reviewedMigrationManifest({
  readSource = (fileName) => readFileSync(new URL(`../supabase/migrations/${fileName}`, import.meta.url)),
  candidateFiles = readdirSync(migrationDirectory()),
} = {}) {
  validateManifestEntries(MANIFEST);
  const expectedFiles = MANIFEST.map(([version, name]) => `${version}_${name}.sql`);
  const boundedCandidates = candidateFiles.filter((file) => {
    const match = FILE_RE.exec(file);
    return match && match[1] >= MANIFEST[0][0] && match[1] <= MANIFEST.at(-1)[0];
  }).sort();
  if (boundedCandidates.join("\0") !== expectedFiles.join("\0")) {
    throw new Error("Reviewed migration candidate set has a missing or unexpected entry.");
  }
  return MANIFEST.map(([version, name, sha256]) => {
    const file = `${version}_${name}.sql`;
    const source = readSource(file);
    const actual = createHash("sha256").update(source).digest("hex");
    if (actual !== sha256) throw new Error(`Reviewed migration digest changed: ${file}.`);
    return { version, name, file, sha256, sql: source.toString("utf8") };
  });
}

export function parseLedgerSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== 1 || !Array.isArray(value.applied) ||
      value.applied.length > MAX_LEDGER_ROWS) {
    throw new Error("Ledger snapshot must be an object containing only an applied array of at most 1000 rows.");
  }
  return value.applied.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row) ||
        Object.keys(row).sort().join(",") !== "name,version" ||
        typeof row.version !== "string" || !/^\d{14}$/.test(row.version) ||
        typeof row.name !== "string" || row.name.length > 160 ||
        (row.name !== "" && !/^[a-z0-9_]+$/.test(row.name))) {
      throw new Error(`Invalid migration ledger row at position ${index + 1}.`);
    }
    return { version: row.version, name: row.name };
  });
}

export function inspectAppliedState(applied, {
  manifest = reviewedMigrationManifest(),
  localFiles = readdirSync(migrationDirectory()),
} = {}) {
  const local = localFiles.map((file) => FILE_RE.exec(file)).filter(Boolean)
    .map((match) => ({ version: match[1], name: match[2] }));
  const localNames = new Set(local.map((row) => row.name));
  const duplicateVersions = applied.filter((row, index) =>
    applied.findIndex((candidate) => candidate.version === row.version) !== index);
  const unrepresentableRows = applied.filter((row) => !row.name);
  const conflicts = manifest.flatMap((migration) => applied.filter((row) =>
    (row.version === migration.version || row.name === migration.name) &&
    !(row.version === migration.version && row.name === migration.name)));
  const unknownHistoricalBundles = applied.filter((row) => !row.name || !localNames.has(row.name));
  const installed = manifest.filter((migration) => applied.some((row) =>
    row.version === migration.version && row.name === migration.name));

  if (duplicateVersions.length || unrepresentableRows.length || conflicts.length) {
    return { status: "conflict", installed: installed.length, conflicts: uniqueRows([
      ...duplicateVersions, ...unrepresentableRows, ...conflicts,
    ]), unknownHistoricalBundles };
  }
  if (installed.length === manifest.length) {
    return { status: "already_complete", installed: installed.length,
      conflicts: [], unknownHistoricalBundles };
  }
  if (installed.length > 0) {
    return { status: "partial", installed: installed.length,
      conflicts: [], unknownHistoricalBundles };
  }
  if (applied.some((row) => row.version >= BUNDLE_VERSION)) {
    return { status: "conflict", installed: 0,
      conflicts: applied.filter((row) => row.version >= BUNDLE_VERSION), unknownHistoricalBundles };
  }
  return { status: "ready", installed: 0,
    conflicts: [], unknownHistoricalBundles };
}

function uniqueRows(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.version}\0${row.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function historicalLedgerSentinel(row) {
  return `-- Remote ledger sentinel for version ${row.version}; it must only ever be skipped.\n` +
    `do $historical_ledger_sentinel$ begin raise exception ` +
    `'Historical ledger sentinel must never execute'; end $historical_ledger_sentinel$;\n`;
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function uniqueMatches(sql, expression) {
  return [...new Set([...sql.matchAll(expression)].map((match) => match[1]))].sort();
}

export function buildAtomicBundle(migrations = reviewedMigrationManifest()) {
  const source = migrations.map((migration) => migration.sql).join("\n");
  const versions = migrations.map((migration) => sqlLiteral(migration.version)).join(",");
  const names = migrations.map((migration) => sqlLiteral(migration.name)).join(",");
  const targetTables = uniqueMatches(source, /create table(?: if not exists)? public\.([a-z0-9_]+)/gi)
    .map((name) => sqlLiteral(`public.${name}`)).join(",");
  const targetFunctions = uniqueMatches(source, /create (?:or replace )?function public\.([a-z0-9_]+)/gi)
    .map(sqlLiteral).join(",");
  const targetTriggers = uniqueMatches(source, /create trigger ([a-z0-9_]+)/gi).map(sqlLiteral).join(",");
  const prerequisiteTables = [
    "auth.users", "storage.buckets", "storage.objects", "public.profiles", "public.profile_roles",
    "public.audit_log", "public.ledger_entries", "public.security_deposit_ledger",
    "public.manager_payment_plans", "public.portal_household_charge_records",
    "public.portal_lease_pipeline_records", "public.vendor_invoices", "public.vendor_payouts",
    "supabase_migrations.schema_migrations",
  ].map(sqlLiteral).join(",");
  const preflight = `set local lock_timeout = '3s';
set local statement_timeout = '60s';
do $production_recovery_preflight$
begin
  if extract(epoch from current_setting('lock_timeout')::interval) <> 3
    or extract(epoch from current_setting('statement_timeout')::interval) <> 60
  then raise exception 'production recovery timeouts are not transaction-scoped'; end if;
  if not pg_try_advisory_xact_lock(723081447302::bigint)
  then raise exception 'production recovery rollout is already locked'; end if;
  if exists (
    select 1 from supabase_migrations.schema_migrations
    where version = any(array[${versions}]::text[]) or name = any(array[${names}]::text[])
  ) then raise exception 'production recovery migration ledger is no longer absent'; end if;
  if exists (select 1 from unnest(array[${prerequisiteTables}]::text[]) item where to_regclass(item) is null)
    or to_regnamespace('auth') is null or to_regnamespace('storage') is null
    or not pg_has_role(current_user,'service_role','MEMBER')
  then raise exception 'production recovery prerequisites are missing'; end if;
  if exists (select 1 from storage.buckets where id = 'account-recovery')
  then raise exception 'production recovery bucket is no longer absent'; end if;
  if exists (select 1 from unnest(array[${targetTables}]::text[]) item where to_regclass(item) is not null)
    or exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname = any(array[${targetFunctions}]::text[]))
    or exists (select 1 from pg_trigger where not tgisinternal and tgname = any(array[${targetTriggers}]::text[]))
  then raise exception 'production recovery target objects are not cleanly absent'; end if;
end
$production_recovery_preflight$;`;
  const exactSources = migrations.map((migration) =>
    `\n-- exact source: ${migration.file} sha256:${migration.sha256}\n${migration.sql}`).join("\n");
  const postflight = `do $production_recovery_postflight$
declare recovery_bucket_public boolean;
begin
  select public into recovery_bucket_public from storage.buckets
  where id = 'account-recovery' for update;
  if not found or recovery_bucket_public is distinct from false
  then raise exception 'production recovery bucket is not private after install'; end if;
end
$production_recovery_postflight$;`;
  const ledger = migrations.map((migration) =>
    `insert into supabase_migrations.schema_migrations(version,name,statements) values (` +
    `${sqlLiteral(migration.version)},${sqlLiteral(migration.name)},array[${sqlLiteral(migration.sql)}]);`).join("\n");
  return `${preflight}\n${exactSources}\n${postflight}\n${ledger}\n`;
}

export function generatePrivateWorkspace(applied, {
  makeTemp = () => mkdtempSync(join(tmpdir(), "proplane-production-migrations-")),
} = {}) {
  const migrations = reviewedMigrationManifest();
  const state = inspectAppliedState(applied, { manifest: migrations });
  if (state.status !== "ready") throw new Error(`CLI workspace refused for migration state: ${state.status}.`);
  const workspace = makeTemp();
  chmodSync(workspace, 0o700);
  const supabase = join(workspace, "supabase");
  const migrationDir = join(supabase, "migrations");
  mkdirSync(migrationDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(supabase, "config.toml"), 'project_id = "production-migration-preparation"\n', { mode: 0o600 });
  for (const row of applied) {
    const sentinelName = row.name || "anonymous_ledger_entry";
    writeFileSync(join(migrationDir, `${row.version}_${sentinelName}.sql`),
      historicalLedgerSentinel(row), { mode: 0o600 });
  }
  const bundleFile = `${BUNDLE_VERSION}_${BUNDLE_NAME}.sql`;
  writeFileSync(join(migrationDir, bundleFile), buildAtomicBundle(migrations), { mode: 0o600 });
  return { workspace, bundleFile, command: ["npx", ...CREDENTIAL_COMMAND] };
}

export function preparationReport(applied, options = {}) {
  const migrations = reviewedMigrationManifest();
  const state = applied ? inspectAppliedState(applied, { manifest: migrations }) : undefined;
  const generated = state?.status === "ready" ? generatePrivateWorkspace(applied, options) : undefined;
  return {
    preparationOnly: true,
    workspaceGenerated: Boolean(generated),
    migrationCount: migrations.length,
    migrations: migrations.map(({ version, name, file, sha256 }) => ({ version, name, file, sha256 })),
    ...(state ? { state } : {}),
    ...(generated ?? {}),
    mechanismEvidence: CLI_MECHANISM_EVIDENCE,
  };
}

export function parsePreparationArgs(args) {
  if (args.includes("--apply")) throw new Error("--apply is forbidden in preparation-only argument parsing.");
  if (args.length === 0) return { ledgerStdin: false };
  if (args.length === 1 && args[0] === "--ledger-stdin") return { ledgerStdin: true };
  throw new Error("Unsupported arguments. Use no arguments or --ledger-stdin only.");
}

/** This parser runs before any executable, credential, or database operation. */
export function parseProductionApplyArgs(args) {
  const expected = new Map([
    ["--apply", true], ["--waiver", APPROVED_WAIVER], ["--bundle-sha256", APPROVED_BUNDLE_SHA256],
  ]);
  if (args.length === 1 && args[0] === "--apply") {
    throw new Error("--apply requires the complete approved acknowledgement; this invocation remains preparation-only.");
  }
  if (args.length !== 5 || args.includes("--ledger-stdin")) throw new Error("Unsupported production apply arguments.");
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!expected.has(flag) || seen.has(flag)) throw new Error("Unsupported production apply arguments.");
    seen.add(flag);
    const required = expected.get(flag);
    if (required !== true) {
      if (args[index + 1] !== required) throw new Error("Production apply acknowledgement does not match the approved scope.");
      index += 1;
    }
  }
  if (seen.size !== expected.size) throw new Error("Production apply requires the complete approved acknowledgement.");
  return { apply: true };
}

export function parseProductionOperationArgs(args) {
  if (args.includes("--apply")) return { ...parseProductionApplyArgs(args), operation: "apply" };
  const preflight = "--preflight";
  if (!args.includes(preflight)) throw new Error("Unsupported production operation arguments.");
  return { ...parseProductionApplyArgs(args.map((arg) => arg === preflight ? "--apply" : arg)), operation: "preflight" };
}

class ProductionMigrationFailure extends Error {
  constructor(stage) {
    super(`Production migration ${stage} failed. No credentials, SQL, or database output is displayed.`);
    this.code = `PRODUCTION_MIGRATION_${stage.toUpperCase().replaceAll(/[^A-Z0-9]+/g, "_")}`;
  }
}

function redactedFailure(stage) { return new ProductionMigrationFailure(stage); }
function isSafeFailure(error) { return error instanceof ProductionMigrationFailure; }
function rethrowSanitized(error, stage = "orchestration") { throw isSafeFailure(error) ? error : redactedFailure(stage); }

const CLI_ENVIRONMENT_KEYS = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "SUPABASE_ACCESS_TOKEN"];
const CREDENTIAL_COMMAND = ["-y", PINNED_SUPABASE, "db", "dump", "--project-ref", PRODUCTION_PROJECT,
  "--data-only", "--schema", "public", "--dry-run", "--yes"];
const REQUIRED_PREREQUISITES = [
  "auth.users", "storage.buckets", "storage.objects", "public.profiles", "public.profile_roles", "public.audit_log",
  "public.ledger_entries", "public.security_deposit_ledger", "public.manager_payment_plans", "public.portal_household_charge_records",
  "public.portal_lease_pipeline_records", "public.vendor_invoices", "public.vendor_payouts", "supabase_migrations.schema_migrations",
];

export function buildCredentialAcquisition({ environment = process.env, makeTemp = () => mkdtempSync(join(tmpdir(), "proplane-cli-login-")) } = {}) {
  const cwd = makeTemp();
  try {
    chmodSync(cwd, 0o700);
    mkdirSync(join(cwd, "supabase"), { mode: 0o700 });
    writeFileSync(join(cwd, "supabase", "config.toml"), 'project_id = "production-migration-login"\n', { mode: 0o600 });
    const env = {};
    for (const key of CLI_ENVIRONMENT_KEYS) if (typeof environment[key] === "string" && environment[key]) env[key] = environment[key];
    if (!env.PATH || !env.HOME || Object.keys(env).some((key) => !CLI_ENVIRONMENT_KEYS.includes(key))) {
      throw redactedFailure("credential environment validation");
    }
    return { file: "npx", args: [...CREDENTIAL_COMMAND], cwd, env };
  } catch (error) {
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* sanitized below */ }
    rethrowSanitized(error, "credential workspace validation");
  }
}

function verifyCredentialInvocation(invocation) {
  if (!invocation || invocation.file !== "npx" || invocation.args.join("\0") !== CREDENTIAL_COMMAND.join("\0") ||
      !invocation.cwd || (statSync(invocation.cwd).mode & 0o777) !== 0o700 ||
      readdirSync(invocation.cwd).join("\0") !== "supabase" ||
      (statSync(join(invocation.cwd, "supabase")).mode & 0o777) !== 0o700 ||
      readFileSync(join(invocation.cwd, "supabase", "config.toml"), "utf8") !== 'project_id = "production-migration-login"\n' ||
      (statSync(join(invocation.cwd, "supabase", "config.toml")).mode & 0o777) !== 0o600 ||
      !invocation.env?.PATH || !invocation.env?.HOME || Object.keys(invocation.env).some((key) => !CLI_ENVIRONMENT_KEYS.includes(key))) {
    throw redactedFailure("credential invocation validation");
  }
}

function runPinnedCli(args, { spawn = spawnSync, env = process.env } = {}) {
  if (!Array.isArray(args) || args.join("\0") !== CREDENTIAL_COMMAND.slice(2).join("\0")) {
    throw redactedFailure("credential invocation validation");
  }
  const invocation = buildCredentialAcquisition({ environment: env });
  try {
    verifyCredentialInvocation(invocation);
    const result = spawn(invocation.file, invocation.args, {
      cwd: invocation.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: invocation.env, timeout: 90_000,
    });
    return { status: result.status, signal: result.signal ?? null, timedOut: result.error?.code === "ETIMEDOUT", output: `${result.stdout ?? ""}` };
  } catch (error) {
    rethrowSanitized(error, "credential acquisition");
  } finally {
    try { rmSync(invocation.cwd, { recursive: true, force: true }); } catch { /* caller receives only a fixed failure */ }
  }
}

function parseExactCliLogin(output) {
  const values = {};
  for (const key of ["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE"]) {
    const matches = [...String(output).matchAll(new RegExp(`(?:^|\\n)export ${key}="([^"\\r\\n]+)"(?=\\r?$|\\n)`, "g"))];
    if (matches.length !== 1) throw redactedFailure("credential binding validation");
    values[key] = matches[0][1];
  }
  const direct = values.PGHOST === `db.${PRODUCTION_PROJECT}.supabase.co` && values.PGUSER === "cli_login_postgres";
  const pooler = /^(?:[a-z0-9-]+\.){1,2}pooler\.supabase\.com$/.test(values.PGHOST) &&
    values.PGUSER === `cli_login_postgres.${PRODUCTION_PROJECT}`;
  if ((!direct && !pooler) || values.PGPORT !== "5432" || values.PGDATABASE !== "postgres") {
    throw redactedFailure("credential binding validation");
  }
  let ca;
  try { ca = readFileSync(new URL("./lib/supabase-root-2021.crt", import.meta.url), "utf8"); } catch { throw redactedFailure("TLS root validation"); }
  if (createHash("sha256").update(ca).digest("hex") !== SUPABASE_ROOT_CA_SHA256) throw redactedFailure("TLS root validation");
  return { host: values.PGHOST, port: 5432, user: values.PGUSER, password: values.PGPASSWORD, database: "postgres",
    ssl: { ca, rejectUnauthorized: true, servername: values.PGHOST }, connectionTimeoutMillis: 15_000, statement_timeout: 15_000 };
}

function normalizedIdentity(value) { return String(value).replaceAll(/\s+/g, " ").replaceAll(/\s*,\s*/g, ",").trim(); }
function functionIdentity(name, args) { return `public.${name}(${normalizedIdentity(args)})`; }
function sourceArgumentTypes(argumentList) {
  if (!argumentList.trim()) return "";
  return argumentList.split(",").map((part) => {
    const words = part.trim().replace(/\s+default\s+.+$/i, "").split(/\s+/);
    return words.slice(1).join(" ");
  }).join(",");
}

export function expectedRecoveryCatalog(migrations = reviewedMigrationManifest()) {
  const source = migrations.map((migration) => migration.sql).join("\n");
  const functions = [...source.matchAll(/create\s+(?:or\s+replace\s+)?function\s+public\.([a-z0-9_]+)\(([^)]*)\)/gi)]
    .map((match) => functionIdentity(match[1], sourceArgumentTypes(match[2]))).sort();
  return {
    tables: uniqueMatches(source, /create table(?: if not exists)? public\.([a-z0-9_]+)/gi),
    functionIdentities: [...new Set(functions)],
    functionNames: [...new Set(functions.map((identity) => identity.slice("public.".length, identity.indexOf("("))))],
    triggerNames: ["account_guard_deleted_financial_identity", "account_recovery_write_guard", "account_recovery_capture_delete",
      "account_recovery_inherit_file_holds", "account_recovery_auth_identity_guard", "account_recovery_storage_guard"],
  };
}

async function bounded(stage, operation) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => { timer = setTimeout(() => reject(redactedFailure(`${stage} timeout`)), 30_000); }),
    ]);
  } catch (error) { rethrowSanitized(error, stage); }
  finally { clearTimeout(timer); }
}

function attachDriverErrorTracking(client) {
  let asynchronousError;
  if (!client) throw redactedFailure("driver listener setup");
  // Injectable unit fixtures may not be EventEmitters. The production pg.Client
  // always is, and receives this listener before connect below.
  if (typeof client.on !== "function") return () => {};
  client.on("error", () => { if (!asynchronousError) asynchronousError = redactedFailure("driver asynchronous error"); });
  return () => { if (asynchronousError) throw asynchronousError; };
}

async function query(client, statement, values, stage = "database query") {
  return bounded(stage, () => values === undefined ? client.query(statement) : client.query(statement, values));
}

async function safeEnd(client) {
  if (!client?.end) return;
  try { await bounded("database cleanup", () => client.end()); } catch { /* fresh readback must continue */ }
}

export async function readRecoveryCatalog(client, migrations = reviewedMigrationManifest(), { readOnly = false } = {}) {
  const expected = expectedRecoveryCatalog(migrations);
  let began = false;
  try {
    if (readOnly) {
      await query(client, "BEGIN READ ONLY", undefined, "read-only begin"); began = true;
      await query(client, "SET LOCAL ROLE postgres", undefined, "read-only role");
    }
    const ledger = (await query(client, "select version, name, statements from supabase_migrations.schema_migrations order by version, name")).rows;
    const prerequisite = (await query(client, "select count(*)::int as missing from unnest($1::text[]) item where to_regclass(item) is null", [REQUIRED_PREREQUISITES])).rows[0];
    const bucket = (await query(client, "select public from storage.buckets where id = 'account-recovery'")).rows;
    const tableRows = (await query(client, `select relname, relrowsecurity, (select count(*)::int from pg_policy where polrelid=pg_class.oid) as policy_count,
      has_table_privilege('service_role', oid, 'select') as service_select, has_table_privilege('service_role', oid, 'insert') as service_insert,
      has_table_privilege('service_role', oid, 'update') as service_update, has_table_privilege('service_role', oid, 'delete') as service_delete,
      has_table_privilege('service_role', oid, 'truncate') as service_truncate, has_table_privilege('service_role', oid, 'references') as service_references,
      has_table_privilege('service_role', oid, 'trigger') as service_trigger,
      has_table_privilege('anon', oid, 'select') as anon_select, has_table_privilege('anon', oid, 'insert') as anon_insert,
      has_table_privilege('anon', oid, 'update') as anon_update, has_table_privilege('anon', oid, 'delete') as anon_delete,
      has_table_privilege('anon', oid, 'truncate') as anon_truncate, has_table_privilege('anon', oid, 'references') as anon_references,
      has_table_privilege('anon', oid, 'trigger') as anon_trigger,
      has_table_privilege('authenticated', oid, 'select') as authenticated_select, has_table_privilege('authenticated', oid, 'insert') as authenticated_insert,
      has_table_privilege('authenticated', oid, 'update') as authenticated_update, has_table_privilege('authenticated', oid, 'delete') as authenticated_delete,
      has_table_privilege('authenticated', oid, 'truncate') as authenticated_truncate, has_table_privilege('authenticated', oid, 'references') as authenticated_references,
      has_table_privilege('authenticated', oid, 'trigger') as authenticated_trigger
      from pg_class where relnamespace='public'::regnamespace and relname=any($1::text[]) order by relname`, [expected.tables])).rows;
    const functionRows = (await query(client, `select p.proname, pg_catalog.oidvectortypes(p.proargtypes) as identity_arguments,
      has_function_privilege('service_role',p.oid,'execute') as service_execute, has_function_privilege('anon',p.oid,'execute') as anon_execute,
      has_function_privilege('authenticated',p.oid,'execute') as authenticated_execute from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=any($1::text[]) order by p.proname, identity_arguments`, [expected.functionNames])).rows;
    const guardedPublicTables = (await query(client, `select tablename from pg_tables where schemaname='public' and tablename not like 'account_recovery_%'
      and tablename not in ('account_deleted_record_identities','account_deleted_identity_keys','account_deleted_storage_keys') order by tablename`)).rows.map((row) => row.tablename);
    const triggerRows = (await query(client, `select n.nspname as schema, c.relname as relation, t.tgname, t.tgenabled,
      case when (t.tgtype & 2)<>0 then 'BEFORE' when (t.tgtype & 64)<>0 then 'INSTEAD OF' else 'AFTER' end as timing,
      array_remove(array[case when (t.tgtype & 4)<>0 then 'INSERT' end,case when (t.tgtype & 8)<>0 then 'DELETE' end,
        case when (t.tgtype & 16)<>0 then 'UPDATE' end,case when (t.tgtype & 32)<>0 then 'TRUNCATE' end],null) as events,
      coalesce(array(select a.attname::text from unnest(t.tgattr::smallint[]) x join pg_attribute a on a.attrelid=t.tgrelid and a.attnum=x order by a.attnum),'{}'::text[]) as update_columns,
      case when (t.tgtype & 1)<>0 then 'ROW' else 'STATEMENT' end as for_each,
      pg_get_expr(t.tgqual,t.tgrelid) as when_expression, pn.nspname||'.'||p.proname||'('||pg_catalog.oidvectortypes(p.proargtypes)||')' as function_identity
      from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace join pg_proc p on p.oid=t.tgfoid join pg_namespace pn on pn.oid=p.pronamespace
      where not t.tgisinternal and t.tgname=any($1::text[]) order by 1,2,3`, [expected.triggerNames])).rows;
    const financial = (await query(client, `select a.attrelid::regclass::text as relation,a.attname,a.attnotnull,c.confdeltype,
      c.confrelid::regclass::text as referenced_relation,array_agg(parent.attname::text order by keys.ordinality)::text[] as referenced_columns
      from pg_attribute a join pg_constraint c on c.conrelid=a.attrelid and a.attnum=any(c.conkey)
      join lateral unnest(c.confkey) with ordinality keys(attnum,ordinality) on true join pg_attribute parent on parent.attrelid=c.confrelid and parent.attnum=keys.attnum
      where a.attrelid in ('public.vendor_invoices'::regclass,'public.vendor_payouts'::regclass) and a.attname in ('manager_user_id','vendor_user_id') and c.contype='f'
      group by a.attrelid,a.attname,a.attnotnull,c.confdeltype,c.confrelid order by 1,2`)).rows;
    const auditActor = (await query(client, "select attnotnull from pg_attribute where attrelid='public.audit_log'::regclass and attname='actor_user_id' and not attisdropped")).rows;
    const activity = (await query(client, `select
      count(*) filter (where pid<>pg_backend_pid() and backend_type='client backend')::int as other_sessions,
      count(*) filter (where pid<>pg_backend_pid() and backend_type='client backend' and state<>'idle')::int as active_sessions,
      count(*) filter (where pid<>pg_backend_pid() and backend_type='client backend' and xact_start<clock_timestamp()-interval '5 minutes')::int as long_transactions,
      count(*) filter (where pid<>pg_backend_pid() and backend_type='client backend' and wait_event_type='Lock')::int as lock_waiters
      from pg_stat_activity where datname=current_database()`)).rows[0];
    return { ledger, prerequisitesMissing: prerequisite?.missing, bucket, expected, tableRows, functionRows, triggerRows, guardedPublicTables, financial, auditActor, activity };
  } finally {
    if (began) { try { await query(client, "ROLLBACK", undefined, "read-only rollback"); } catch { throw redactedFailure("read-only rollback"); } }
  }
}

function assertCleanPreflight(state, migrations) {
  const auxiliaryConflict = state.ledger.some((row) => row.version === BUNDLE_VERSION || row.name === BUNDLE_NAME);
  if (auxiliaryConflict || inspectAppliedState(state.ledger.map(({ version, name }) => ({ version, name })), { manifest: migrations }).status !== "ready" ||
      state.prerequisitesMissing !== 0 || state.bucket.length !== 0 || state.tableRows.length !== 0 ||
      state.functionRows.length !== 0 || state.triggerRows.length !== 0) throw redactedFailure("preflight validation");
}

function canonicalRows(rows) { return [...rows].sort((a, b) => `${a.version}\0${a.name}`.localeCompare(`${b.version}\0${b.name}`)); }
function sameJson(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

export function validateRecoveryCatalog(state, { migrations = reviewedMigrationManifest(), historicalLedger = [] } = {}) {
  const bundleSql = buildAtomicBundle(migrations);
  const expectedLedger = canonicalRows([
    ...historicalLedger,
    ...migrations.map(({ version, name, sql }) => ({ version, name, statements: [sql] })),
    { version: BUNDLE_VERSION, name: BUNDLE_NAME, statements: [bundleSql] },
  ]);
  const actualLedger = canonicalRows(state.ledger);
  const actualFunctions = state.functionRows.map((row) => functionIdentity(row.proname, row.identity_arguments)).sort();
  if (!sameJson(actualLedger, expectedLedger) || state.bucket.length !== 1 || state.bucket[0].public !== false ||
      state.tableRows.length !== state.expected.tables.length || !sameJson(actualFunctions, state.expected.functionIdentities) ||
      !hasExpectedTriggerTopology(state) || state.tableRows.some((row) => !hasExpectedTablePrivileges(row)) ||
      state.functionRows.some((row) => !row.service_execute || row.anon_execute || row.authenticated_execute) ||
      !sameJson(state.financial.map((row) => `${row.relation}.${row.attname}`).sort(), [
        "vendor_invoices.manager_user_id", "vendor_invoices.vendor_user_id",
        "vendor_payouts.manager_user_id", "vendor_payouts.vendor_user_id",
      ]) || state.financial.some((row) => row.attnotnull || row.confdeltype !== "n" ||
        row.referenced_relation !== "auth.users" || !sameJson(row.referenced_columns, ["id"])) ||
      state.auditActor.length !== 1 || state.auditActor[0].attnotnull) {
    throw redactedFailure("post-apply catalog verification");
  }
  return true;
}

function hasExpectedTablePrivileges(row) {
  if (!row.relrowsecurity || row.policy_count !== 0 || !row.service_select || !row.service_insert || !row.service_update ||
      !row.service_delete || !row.service_truncate || !row.service_references || !row.service_trigger) return false;
  const clientWritesDenied = !row.anon_insert && !row.anon_update && !row.anon_delete &&
    !row.authenticated_insert && !row.authenticated_update && !row.authenticated_delete;
  if (!clientWritesDenied) return false;
  const extended = ["select", "truncate", "references", "trigger"];
  if (row.relname.startsWith("webhook_")) {
    // The immutable reviewed webhook SQL revokes client DML and relies on RLS
    // with zero policies for reads. Managed default privileges leave these four
    // effective grants in place, exactly matching the reviewed staging schema.
    return extended.every((privilege) => row[`anon_${privilege}`] && row[`authenticated_${privilege}`]);
  }
  return extended.every((privilege) => !row[`anon_${privilege}`] && !row[`authenticated_${privilege}`]);
}

function catalogArray(value) {
  if (Array.isArray(value)) return value;
  if (value === "{}") return [];
  if (typeof value === "string" && value.startsWith("{") && value.endsWith("}")) {
    return value.slice(1, -1).split(",").filter(Boolean);
  }
  return [];
}

function hasExpectedTriggerTopology(state) {
  const key = (schema, relation, trigger, timing, forEach, events, updateColumns, whenExpression, functionName) =>
    [schema, relation, trigger, timing, forEach, [...events].sort().join(","), [...updateColumns].sort().join(","), whenExpression ?? "", functionName].join("\0");
  const actual = state.triggerRows.map((row) => key(row.schema, row.relation, row.tgname, row.timing,
    row.for_each, catalogArray(row.events), catalogArray(row.update_columns), row.when_expression,
    normalizedIdentity(row.function_identity)));
  const expected = [];
  for (const relation of state.guardedPublicTables) {
    expected.push(key("public", relation, "account_recovery_write_guard", "BEFORE", "ROW", ["INSERT", "UPDATE", "DELETE"], [], null, "public.account_recovery_write_guard()"));
    expected.push(key("public", relation, "account_recovery_capture_delete", "AFTER", "ROW", ["DELETE"], [], null, "public.account_recovery_capture_delete()"));
  }
  for (const relation of ["ledger_entries", "security_deposit_ledger", "manager_payment_plans",
    "portal_household_charge_records", "portal_lease_pipeline_records", "vendor_invoices", "vendor_payouts"]) {
    expected.push(key("public", relation, "account_guard_deleted_financial_identity", "BEFORE", "ROW", ["INSERT", "UPDATE"], [], null, "public.account_guard_deleted_financial_identity()"));
  }
  expected.push(key("public", "account_recovery_holds", "account_recovery_inherit_file_holds", "AFTER", "ROW", ["INSERT", "UPDATE"], [], null, "public.account_recovery_inherit_file_holds()"));
  expected.push(key("auth", "users", "account_recovery_auth_identity_guard", "BEFORE", "ROW", ["UPDATE", "DELETE"], ["email"], null, "public.account_recovery_auth_identity_guard()"));
  expected.push(key("storage", "objects", "account_recovery_storage_guard", "BEFORE", "ROW", ["INSERT", "UPDATE"], [], null, "public.account_recovery_storage_guard()"));
  return state.triggerRows.every((row) => row.tgenabled === "O") && actual.length === expected.length &&
    sameJson(actual.sort(), expected.sort());
}

async function createVerifiedClient(createClient, connection) {
  const client = createClient(connection);
  const assertNoAsyncError = attachDriverErrorTracking(client);
  try {
    await bounded("database connect", () => client.connect());
    assertNoAsyncError();
    return { client, assertNoAsyncError };
  } catch (error) {
    await safeEnd(client);
    rethrowSanitized(error, "database connect");
  }
}

async function freshReadback(createClient, connection, migrations, historicalLedger) {
  let connectionState;
  try {
    connectionState = await createVerifiedClient(createClient, connection);
    const state = await readRecoveryCatalog(connectionState.client, migrations, { readOnly: true });
    connectionState.assertNoAsyncError();
    try {
      validateRecoveryCatalog(state, { migrations, historicalLedger });
      return "installed";
    } catch {
      const migrationEffectsAbsent = sameJson(state.ledger, historicalLedger) && state.tableRows.length === 0 &&
        state.functionRows.length === 0 && state.triggerRows.length === 0;
      return migrationEffectsAbsent ? "clean" : "invalid";
    }
  } catch { return "unavailable_or_invalid"; }
  finally { await safeEnd(connectionState?.client); }
}

/** Injectable dependencies are intentionally accepted only by this orchestration function, never by the CLI parser. */
async function executeApprovedProductionApplyUnsafe(dependencies = {}) {
  const operation = dependencies.operation ?? "apply";
  const runCli = dependencies.runCli ?? runPinnedCli;
  const createClient = dependencies.createClient ?? ((connection) => {
    const require = createRequire(import.meta.url); return new (require("pg").Client)(connection);
  });
  const migrations = reviewedMigrationManifest();
  const bundle = buildAtomicBundle(migrations);
  if (createHash("sha256").update(bundle).digest("hex") !== APPROVED_BUNDLE_SHA256) throw redactedFailure("bundle digest validation");
  const login = await bounded("credential acquisition", () => runCli(["db", "dump", "--project-ref", PRODUCTION_PROJECT,
    "--data-only", "--schema", "public", "--dry-run", "--yes"]));
  if (!login || login.status !== 0 || login.signal || login.timedOut) throw redactedFailure("credential acquisition");
  const connection = parseExactCliLogin(login.output);
  let original;
  try {
    original = await createVerifiedClient(createClient, connection);
    const before = await readRecoveryCatalog(original.client, migrations, { readOnly: true });
    original.assertNoAsyncError();
    assertCleanPreflight(before, migrations);
    if (operation === "preflight") return {
      outcome: "preflight_passed",
      migrationCount: migrations.length,
      ledgerRows: before.ledger.length,
      prerequisitesMissing: before.prerequisitesMissing,
      targetObjectsAbsent: true,
      activity: before.activity,
    };
    const reread = await readRecoveryCatalog(original.client, migrations, { readOnly: true });
    original.assertNoAsyncError();
    assertCleanPreflight(reread, migrations);
    if (!sameJson(before.ledger, reread.ledger)) throw redactedFailure("ledger drift validation");
    let commitAttempted = false;
    let commitConfirmed = false;
    let rollbackConfirmed = false;
    let transactionFailure;
    try {
      await query(original.client, "BEGIN", undefined, "transaction begin");
      await query(original.client, "SET LOCAL ROLE postgres", undefined, "transaction role");
      await query(original.client, bundle, undefined, "bundle execution");
      await query(original.client, "insert into supabase_migrations.schema_migrations(version,name,statements) values ($1,$2,array[$3::text])",
        [BUNDLE_VERSION, BUNDLE_NAME, bundle], "auxiliary ledger insertion");
      const precommit = await readRecoveryCatalog(original.client, migrations);
      original.assertNoAsyncError();
      validateRecoveryCatalog(precommit, { migrations, historicalLedger: before.ledger });
      commitAttempted = true;
      await query(original.client, "COMMIT", undefined, "commit");
      original.assertNoAsyncError();
      commitConfirmed = true;
    } catch (error) {
      transactionFailure = error;
      if (!commitAttempted) {
        try { await query(original.client, "ROLLBACK", undefined, "rollback"); original.assertNoAsyncError(); rollbackConfirmed = true; } catch { /* classified after fresh readback */ }
      }
    }
    await safeEnd(original.client);
    original = undefined;
    const readback = await freshReadback(createClient, connection, migrations, before.ledger);
    if (commitConfirmed && readback === "installed") return { outcome: "success", migrationCount: migrations.length };
    if (!commitConfirmed && rollbackConfirmed && readback === "clean" && transactionFailure) {
      return { outcome: "rolled_back_or_refused", migrationCount: migrations.length };
    }
    return { outcome: "uncertain_or_partial", migrationCount: migrations.length };
  } finally { await safeEnd(original?.client); }
}

export async function executeApprovedProductionApply(dependencies = {}) {
  try { return await executeApprovedProductionApplyUnsafe(dependencies); }
  catch (error) { rethrowSanitized(error, "orchestration"); }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--apply") || args.includes("--preflight")) return executeApprovedProductionApply(parseProductionOperationArgs(args));
  const { ledgerStdin } = parsePreparationArgs(args);
  let snapshot;
  if (ledgerStdin) {
    try {
      snapshot = JSON.parse(readFileSync(0, "utf8"));
    } catch {
      throw new Error("Ledger snapshot is not valid JSON.");
    }
  }
  const applied = ledgerStdin ? parseLedgerSnapshot(snapshot) : undefined;
  const report = preparationReport(applied);
  console.log(JSON.stringify(report, null, 2));
  if (!ledgerStdin) return 0;
  return ["already_complete", "ready"].includes(report.state.status) ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = main();
    if (result instanceof Promise) result.then((value) => { if (value) { console.log(JSON.stringify(value)); if (value.outcome && !["success", "preflight_passed"].includes(value.outcome)) process.exitCode = 1; } })
      .catch((error) => { console.error(error instanceof Error ? error.message : "Production migration preparation failed."); process.exitCode = 1; });
    else process.exitCode = result;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Production migration preparation failed.");
    process.exitCode = 1;
  }
}
