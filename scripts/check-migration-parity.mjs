#!/usr/bin/env node
/**
 * Fail closed when a migration in this repo cannot be matched unambiguously to
 * the Supabase migration ledger for the database the code will run against.
 *
 * Supabase can record the same migration under different apply-time versions,
 * so migration NAME is the identity. Versions remain useful evidence, but are
 * not used to decide whether a named migration was applied. Empty names,
 * duplicates, and remote-only bundle names are unresolved rather than guessed.
 *
 * Reads and prints versions and migration names only. Connection errors are
 * deliberately redacted because driver messages can contain credentials.
 *
 * Exit codes:
 *   0  exact, unambiguous name parity
 *   1  migration drift or ambiguous migration history
 *   2  the target could not be checked
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");
const FILE_RE = /^(\d{14})_(.+)\.sql$/;
const PROJECT_REF_RE = /^[a-z0-9]{20}$/;
const DIRECT_HOST_RE = /^db\.([a-z0-9]{20})\.supabase\.co$/;
const POOLER_HOST_RE = /^[a-z0-9-]+\.pooler\.supabase\.com$/;
const POOLER_USER_RE = /^(?:postgres|cli_login_postgres)\.([a-z0-9]{20})$/;
const ALLOWED_CONNECTION_PARAMS = new Set(["sslmode", "ssl"]);

export const TARGET_PROJECT_REFS = Object.freeze({
  dev: "emstjswhotsnyksqhqyf",
  staging: "xwszcafaontidfgznlxd",
  production: "qahnczmilgptcedaqype",
});

/** Connection-string env names, in the order a caller most likely means them. */
const URL_ENV_VARS = ["SUPABASE_DB_URL", "POSTGRES_URL", "DATABASE_URL"];

export function parseArguments(argv) {
  const values = { target: "", dbUrl: "" };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const match = /^--(target|db-url)(?:=(.*))?$/.exec(token);
    if (!match) return { ok: false, reason: "invalid-arguments" };
    const key = match[1];
    if (seen.has(key)) return { ok: false, reason: "invalid-arguments" };
    seen.add(key);
    const value = match[2] === undefined ? argv[++index] : match[2];
    if (!value || value.startsWith("--")) return { ok: false, reason: "invalid-arguments" };
    if (key === "target") values.target = value;
    else values.dbUrl = value;
  }
  return { ok: true, ...values };
}

export function parseMigrationFileNames(files) {
  return files
    .map((file) => {
      const match = FILE_RE.exec(file);
      return match ? { version: match[1], name: match[2] } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.version.localeCompare(b.version));
}

/**
 * Names and versions must each be nonempty and unique within one history.
 * A duplicate name makes it impossible to know which SQL that name represents;
 * a duplicate version cannot be installed in Supabase's primary-key ledger.
 */
export function migrationIdentityProblems(rows, source) {
  const problems = [];
  const names = new Map();
  const versions = new Map();

  rows.forEach((row, index) => {
    const name = typeof row?.name === "string" ? row.name : "";
    const version = typeof row?.version === "string" ? row.version : "";

    if (!name || name.trim() !== name) {
      problems.push({ source, kind: "invalid-name", index, version });
    } else if (names.has(name)) {
      problems.push({ source, kind: "duplicate-name", index, version, name });
    } else {
      names.set(name, index);
    }

    if (!version || version.trim() !== version) {
      problems.push({ source, kind: "invalid-version", index, version });
    } else if (versions.has(version)) {
      problems.push({ source, kind: "duplicate-version", index, version, name });
    } else {
      versions.set(version, index);
    }
  });

  return problems;
}

/** Compare exact, nonempty names. No version or bundle equivalence is inferred. */
export function diffMigrations(local, applied) {
  const problems = [
    ...migrationIdentityProblems(local, "repo"),
    ...migrationIdentityProblems(applied, "database"),
  ];
  const appliedNames = new Set(applied.map((row) => row.name).filter(Boolean));
  const localNames = new Set(local.map((row) => row.name).filter(Boolean));

  return {
    missing: local.filter((row) => !appliedNames.has(row.name)),
    extra: applied.filter((row) => !localNames.has(row.name)),
    problems,
  };
}

export function hasFatalMigrationDrift(result) {
  return result.missing.length > 0 || result.problems.length > 0;
}

function parseConnectionUrl(dbUrl) {
  try {
    const parsed = new URL(dbUrl);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return null;
    if (!parsed.hostname || !parsed.username) return null;
    const seenParams = new Set();
    for (const [key, value] of parsed.searchParams) {
      if (!ALLOWED_CONNECTION_PARAMS.has(key) || seenParams.has(key)) return null;
      seenParams.add(key);
      if (key === "ssl" && value !== "true" && value !== "false") return null;
      if (key === "sslmode" && !["disable", "allow", "prefer", "require", "verify-ca", "verify-full", "no-verify"].includes(value)) return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * A named target accepts only that project's direct Supabase host or a Supabase
 * pooler username carrying that exact project ref. This runs before importing
 * pg or opening a socket. With no target, any valid PostgreSQL URL is allowed
 * for safe local diagnostics.
 */
export function validateTargetConnection(target, dbUrl) {
  if (target && !Object.hasOwn(TARGET_PROJECT_REFS, target)) {
    return { ok: false, reason: "unknown-target" };
  }

  const parsed = parseConnectionUrl(dbUrl);
  if (!parsed) return { ok: false, reason: "malformed-url" };
  if (!target) return { ok: true };

  const expected = TARGET_PROJECT_REFS[target];
  const hostname = parsed.hostname.toLowerCase();
  let username;
  try {
    username = decodeURIComponent(parsed.username);
  } catch {
    return { ok: false, reason: "malformed-url" };
  }

  const direct = DIRECT_HOST_RE.exec(hostname);
  if (direct) {
    const userProject = POOLER_USER_RE.exec(username)?.[1];
    const validUser = username === "postgres" || userProject === expected;
    return direct[1] === expected && validUser
      ? { ok: true }
      : { ok: false, reason: "target-mismatch" };
  }

  const poolerProject = POOLER_USER_RE.exec(username)?.[1];
  if (POOLER_HOST_RE.test(hostname) && PROJECT_REF_RE.test(poolerProject ?? "")) {
    return poolerProject === expected
      ? { ok: true }
      : { ok: false, reason: "target-mismatch" };
  }

  return { ok: false, reason: "target-mismatch" };
}

function localMigrations() {
  const sqlFiles = readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith(".sql"));
  const migrations = parseMigrationFileNames(sqlFiles);
  return {
    migrations,
    invalidFiles: sqlFiles.filter(
      (file) => !migrations.some((migration) => file === `${migration.version}_${migration.name}.sql`),
    ),
  };
}

/** Read only the ledger Supabase itself writes. */
async function appliedMigrations(dbUrl) {
  const { Client } = await import("pg");
  const parsed = new URL(dbUrl);
  const local = /^(localhost|127\.0\.0\.1)$/.test(parsed.hostname);
  const client = new Client({
    connectionString: dbUrl,
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
    return rows.map((row) => ({ version: String(row.version), name: String(row.name) }));
  } finally {
    await client.end().catch(() => {});
  }
}

function label(target) {
  return target ? ` (${target})` : "";
}

function printProblems(problems) {
  for (const problem of problems) {
    const identity = problem.name ? ` ${problem.name}` : " <anonymous>";
    console.error(`  invalid ${problem.source} ${problem.kind} ${problem.version || "<no-version>"}${identity}`);
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (!args.ok) {
    console.log("migration parity: NOT CHECKED - invalid command arguments.");
    return 2;
  }
  const target = args.target;
  const dbUrl = args.dbUrl || URL_ENV_VARS.map((name) => process.env[name]).find(Boolean) || "";
  const { migrations: local, invalidFiles } = localMigrations();

  if (local.length === 0) {
    console.error("migration parity: FAIL - no migrations found under supabase/migrations.");
    return 1;
  }

  if (!dbUrl) {
    if (target && !Object.hasOwn(TARGET_PROJECT_REFS, target)) {
      console.log(`migration parity: NOT CHECKED${label(target)} - unknown target.`);
    } else {
      console.log(`migration parity: NOT CHECKED${label(target)} - no database URL available.`);
      console.log(`  repo has ${local.length} migrations, newest ${local[local.length - 1].version}`);
    }
    return 2;
  }

  const targetCheck = validateTargetConnection(target, dbUrl);
  if (!targetCheck.ok) {
    const message = targetCheck.reason === "unknown-target"
      ? "unknown target"
      : targetCheck.reason === "malformed-url"
        ? "malformed database URL"
        : "connection does not match target";
    console.log(`migration parity: NOT CHECKED${label(target)} - ${message}.`);
    return 2;
  }

  if (invalidFiles.length > 0) {
    console.error("migration parity: FAIL - invalid migration filenames make parity ambiguous.");
    for (const file of invalidFiles) console.error(`  invalid file ${file}`);
    return 1;
  }

  let applied;
  try {
    applied = await appliedMigrations(dbUrl);
  } catch {
    console.log(`migration parity: NOT CHECKED${label(target)} - could not read the migration ledger.`);
    console.log("  Connection details and driver errors were suppressed.");
    return 2;
  }

  if (applied === null) {
    console.log(`migration parity: NOT CHECKED${label(target)} - no supabase_migrations.schema_migrations table.`);
    return 2;
  }

  const result = diffMigrations(local, applied);
  const { missing, extra, problems } = result;
  if (extra.length > 0) {
    console.log(`migration parity: ${extra.length} applied migration name(s) not in this repo${label(target)}.`);
    for (const row of extra) console.log(`  extra  ${row.version}  ${row.name || "<anonymous>"}`);
  }

  if (hasFatalMigrationDrift(result)) {
    console.error(`migration parity: FAIL${label(target)} - migration history is missing or unresolved.`);
    for (const row of missing) console.error(`  missing     ${row.version}  ${row.name}`);
    printProblems(problems);
    if (missing.length > 0 && extra.length > 0) {
      console.error("  Extra bundle names were not treated as equivalents for missing repo names.");
    }
    console.error("  No version or anonymous-history equivalence was inferred.");
    return 1;
  }

  console.log(
    `migration parity: OK${label(target)} - all ${local.length} repo migration names are applied` +
      ` (newest repo version ${local[local.length - 1].version}).`,
  );
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("check-migration-parity.mjs")) {
  main()
    .then((code) => process.exit(code))
    .catch(() => {
      console.error("migration parity: FAIL - unexpected checker error; details suppressed.");
      process.exit(1);
    });
}
