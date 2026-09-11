#!/usr/bin/env node
/**
 * Preparation-only manifest for the reviewed September 11 production schema
 * recovery. This file never connects to a database or accepts SQL or paths.
 * It creates only a private, deterministic Supabase CLI dry-run workspace from
 * bounded migration-ledger metadata. It rejects production apply explicitly.
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FILE_RE = /^(\d{14})_([a-z0-9_]+)\.sql$/;
const MAX_LEDGER_ROWS = 1_000;
const BUNDLE_VERSION = "20260911010000";
const BUNDLE_NAME = "production_recovery_schema";
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
  "Supabase CLI 2.117.0 legacy-migration-apply.ts appends its ledger insert to the final migration batch; sql-pg sends one Parse/Bind/Describe/Execute sequence and one Sync, so this bundle has one implicit transaction.";

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
      `-- Remote ledger sentinel for version ${row.version}; it must only ever be skipped.\n` +
      `do $historical_ledger_sentinel$ begin raise exception ` +
      `'Historical ledger sentinel must never execute'; end $historical_ledger_sentinel$;\n`, { mode: 0o600 });
  }
  const bundleFile = `${BUNDLE_VERSION}_${BUNDLE_NAME}.sql`;
  writeFileSync(join(migrationDir, bundleFile), buildAtomicBundle(migrations), { mode: 0o600 });
  return { workspace, bundleFile, command: ["npx", "-y", "supabase@2.117.0", "db", "push",
    "--project-ref", "qahnczmilgptcedaqype", "--skip-vault", "--workdir", workspace, "--dry-run"] };
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
  if (args.includes("--apply")) throw new Error("--apply is forbidden: this script is preparation-only.");
  if (args.length === 0) return { ledgerStdin: false };
  if (args.length === 1 && args[0] === "--ledger-stdin") return { ledgerStdin: true };
  throw new Error("Unsupported arguments. Use no arguments or --ledger-stdin only.");
}

function main() {
  const { ledgerStdin } = parsePreparationArgs(process.argv.slice(2));
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
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Production migration preparation failed.");
    process.exitCode = 1;
  }
}
