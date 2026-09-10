#!/usr/bin/env node
/**
 * Fail loudly when a migration exists in this repo but has never been applied
 * to the database the code is about to run against.
 *
 * Why this exists:
 *   On 2026-09-10 the application-fee waiver code was broken for every manager
 *   and every applicant on staging AND production. Nothing was wrong with the
 *   feature: `20260909210000_scope_application_fee_waiver_codes_to_property.sql`
 *   had merged and shipped, but neither database had ever run it, so every code
 *   lookup asked for a `property_id` column that existed only in dev and errored
 *   with `42703`. Production's ledger turned out to be three migrations behind —
 *   it was also missing `persist_lease_with_action_event()` and
 *   `action_event_deliveries.sms_deferred_until`, both called by live code, so
 *   lease persistence and notification delivery were failing too.
 *
 *   Every gate was green throughout. Unit tests mock Supabase, so nothing in
 *   `unit` / `lint` / `build` ever compares a query against the schema it will
 *   actually meet, and `ship:preflight` checked branches, workflows and env but
 *   never the migration ledger. Shipping a migration FILE is not applying it.
 *
 * What it compares:
 *   the `<version>_<name>.sql` files under `supabase/migrations` against the
 *   `supabase_migrations.schema_migrations` rows in the target database. A
 *   version in the repo and not in the database is a FAILURE — that is the shape
 *   that takes a feature down. A version in the database and not in the repo is
 *   reported but not fatal (a squashed or renamed migration looks like that).
 *
 * Reads and prints versions and migration names only — never a connection
 * string, a credential, or any row of application data. Safe in CI logs.
 *
 *   node scripts/check-migration-parity.mjs --db-url "postgresql://..."
 *   SUPABASE_DB_URL=... node scripts/check-migration-parity.mjs
 *   npm run db:parity -- --db-url "$(...)"
 *
 * Exit codes, so a caller can treat "drifted" and "could not check" differently:
 *   0  in sync
 *   1  the database is behind this repo — do not promote
 *   2  no database URL available, nothing was checked (a warning, not a verdict)
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");
const FILE_RE = /^(\d{14})_(.+)\.sql$/;

/** Connection-string env names, in the order a caller most likely means them. */
const URL_ENV_VARS = ["SUPABASE_DB_URL", "POSTGRES_URL", "DATABASE_URL"];

function arg(name) {
  const flag = `--${name}`;
  const argv = process.argv.slice(2);
  const i = argv.indexOf(flag);
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : "";
}

export function parseMigrationFileNames(files) {
  return files
    .map((file) => {
      const m = FILE_RE.exec(file);
      return m ? { version: m[1], name: m[2] } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.version.localeCompare(b.version));
}

/**
 * The verdict, as a value. `missing` is the shape that takes a feature down —
 * the repo asks for something the database has never created. `extra` is the
 * database carrying a version this repo no longer has, which a squash or rename
 * produces legitimately, so it is reported and not fatal.
 */
export function diffMigrations(local, applied) {
  const appliedSet = new Set(applied.map((r) => r.version));
  const localSet = new Set(local.map((r) => r.version));
  return {
    missing: local.filter((r) => !appliedSet.has(r.version)),
    extra: applied.filter((r) => !localSet.has(r.version)),
  };
}

function localMigrations() {
  return parseMigrationFileNames(readdirSync(MIGRATIONS_DIR));
}

/**
 * The ledger Supabase itself writes. Absent entirely on a database that has
 * never been managed by the CLI — that is not "in sync", it is "unknown", so it
 * is reported as a failure to check rather than a pass.
 */
async function appliedVersions(dbUrl) {
  const { Client } = await import("pg");
  const local = /^(localhost|127\.0\.0\.1)(:|$)/.test(new URL(dbUrl).host);
  const client = new Client({
    connectionString: dbUrl,
    // Supabase terminates TLS with its own chain; a promote check must not fail
    // on certificate plumbing, and it reads nothing secret either way.
    ssl: local ? undefined : { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
    statement_timeout: 15_000,
  });
  await client.connect();
  try {
    const ledger = await client.query(
      `select 1 from information_schema.tables
        where table_schema = 'supabase_migrations' and table_name = 'schema_migrations'`,
    );
    if (ledger.rowCount === 0) return null;
    const { rows } = await client.query(
      `select version, coalesce(name, '') as name
         from supabase_migrations.schema_migrations order by version`,
    );
    return rows.map((r) => ({ version: String(r.version), name: String(r.name) }));
  } finally {
    await client.end().catch(() => {});
  }
}

function label(target) {
  return target ? ` (${target})` : "";
}

async function main() {
  const target = arg("target");
  const dbUrl = arg("db-url") || URL_ENV_VARS.map((v) => process.env[v]).find(Boolean) || "";

  const local = localMigrations();
  if (local.length === 0) {
    console.error("No migrations found under supabase/migrations — is this the repo root?");
    return 1;
  }

  if (!dbUrl) {
    console.log(`migration parity: NOT CHECKED${label(target)} — no database URL available.`);
    console.log(`  repo has ${local.length} migrations, newest ${local[local.length - 1].version}`);
    console.log("  To check a deployed database, pass its pooler connection string:");
    console.log("    node scripts/check-migration-parity.mjs --db-url \"$SUPABASE_DB_URL\" --target staging");
    console.log("  Or use the Supabase CLI against a linked project:");
    console.log("    supabase link --project-ref <ref> && npm run db:status");
    return 2;
  }

  let applied;
  try {
    applied = await appliedVersions(dbUrl);
  } catch (e) {
    // Never leak the connection string, which may carry a password.
    console.log(`migration parity: NOT CHECKED${label(target)} — could not read the migration ledger.`);
    console.log(`  ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }

  if (applied === null) {
    console.log(`migration parity: NOT CHECKED${label(target)} — no supabase_migrations.schema_migrations table.`);
    console.log("  This database has never been managed by the Supabase CLI, so there is nothing to compare.");
    return 2;
  }

  const { missing, extra } = diffMigrations(local, applied);

  if (extra.length > 0) {
    console.log(`migration parity: ${extra.length} applied migration(s) not in this repo${label(target)}`);
    for (const r of extra) console.log(`  extra  ${r.version}  ${r.name}`);
    console.log("  Not fatal — a squashed or renamed migration looks like this.");
  }

  if (missing.length > 0) {
    console.error(`migration parity: FAIL${label(target)} — ${missing.length} migration(s) in this repo have NEVER been applied.`);
    for (const r of missing) console.error(`  missing  ${r.version}  ${r.name}`);
    console.error("");
    console.error("  Code that queries what these create will fail against this database, and the");
    console.error("  failure usually surfaces as an unrelated product bug rather than a schema error.");
    console.error("  Apply them before promoting:  npm run db:push");
    return 1;
  }

  console.log(
    `migration parity: OK${label(target)} — all ${local.length} repo migrations applied` +
      ` (newest ${local[local.length - 1].version}).`,
  );
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("check-migration-parity.mjs")) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    });
}
