import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NONPRODUCTION_PROJECTS, nonproductionDatabaseConfig, connectNonproductionDatabase } from "./nonproduction-database.mjs";

const MIGRATION_VERSION = "20260906020000";
const MIGRATION_NAME = "shared_rate_limits";
const MIGRATION_SQL = readFileSync(new URL(`../../supabase/migrations/${MIGRATION_VERSION}_${MIGRATION_NAME}.sql`, import.meta.url), "utf8");
const TABLE_NAME = "public.rate_limit_buckets";
const FUNCTION_NAME = "public.consume_rate_limit(text,integer,integer)";

async function beginTransaction(db, role, readOnly = false) {
  await db.query(readOnly ? "begin read only" : "begin");
  // Roles are fixed call-site constants, never user/CLI input.
  await db.query(role === "service_role" ? "set local role service_role" : "set local role postgres");
  await db.query("set local statement_timeout = '15s'");
  await db.query("set local lock_timeout = '5s'");
}

async function inspectState(db) {
  const { rows: [objects] } = await db.query(`select
    to_regclass('public.rate_limit_buckets') is not null as table_present,
    to_regprocedure('public.consume_rate_limit(text,integer,integer)') is not null as function_present,
    to_regclass('supabase_migrations.schema_migrations') is not null as history_table_present`);
  const history = objects.history_table_present
    ? (await db.query("select name, statements from supabase_migrations.schema_migrations where version=$1", [MIGRATION_VERSION])).rows[0]
    : null;
  const historyStatus = !objects.history_table_present ? "history_table_missing"
    : !history ? "absent"
      : history.name === MIGRATION_NAME && Array.isArray(history.statements) &&
        history.statements.length === 1 && history.statements[0] === MIGRATION_SQL ? "matches" : "drift";
  const objectStatus = objects.table_present
    ? objects.function_present ? "complete" : "table_only"
    : objects.function_present ? "function_only" : "absent";
  return { ...objects, objectStatus, historyStatus,
    canApply: historyStatus === "matches" || (historyStatus === "absent" && objectStatus === "absent") };
}

async function inspectPermissions(db, state) {
  if (!state.table_present || !state.function_present) return null;
  const { rows: [table] } = await db.query("select relrowsecurity as rls, relkind from pg_class where oid=to_regclass($1)", [TABLE_NAME]);
  const browser = await db.query(`select role_name, privilege,
    has_table_privilege(role_name, $1, privilege) as allowed
    from unnest(array['anon','authenticated']) as role_name
    cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) as privilege`, [TABLE_NAME]);
  const server = await db.query(`select privilege, has_table_privilege('service_role', $1, privilege) as allowed
    from unnest(array['SELECT','INSERT','UPDATE','DELETE']) as privilege`, [TABLE_NAME]);
  const { rows: [execute] } = await db.query(`select
    has_function_privilege('anon', $1, 'EXECUTE') as anon_execute,
    has_function_privilege('authenticated', $1, 'EXECUTE') as user_execute,
    has_function_privilege('service_role', $1, 'EXECUTE') as server_execute`, [FUNCTION_NAME]);
  return { rls: table?.rls === true, isTable: table?.relkind === "r",
    browserChecksComplete: browser.rows.length === 14 && browser.rows.every((row) => typeof row.allowed === "boolean"),
    browserTableAccess: browser.rows.filter((row) => row.allowed).map(({ role_name, privilege }) => ({ role: role_name, privilege })),
    serverTableAccess: server.rows.length === 4 && server.rows.every((row) => row.allowed === true), ...execute };
}

function permissionsMeetBoundary(permissions) {
  return permissions?.rls && permissions.isTable && permissions.browserChecksComplete && permissions.browserTableAccess.length === 0 &&
    permissions.serverTableAccess && permissions.anon_execute === false &&
    permissions.user_execute === false && permissions.server_execute === true;
}

/** Hosted writes are reached only by the CLI's explicit --apply; injectable IO supports a no-cloud test harness. */
export async function prepareLimiterDatabase({ ref, apply, config, connect = connectNonproductionDatabase, log = console.log }) {
  if (!NONPRODUCTION_PROJECTS.includes(ref)) throw new Error("Development or staging project required.");
  const db = await connect(config);
  try {
    await beginTransaction(db, "postgres", !apply);
    const before = await inspectState(db);
    if (apply) {
      if (!before.canApply) throw new Error("Limiter migration history or existing objects require manual drift review.");
      // Reapply this one fixed, idempotent migration only when history is exact,
      // or when both objects and version are absent. Never trust a signature alone.
      await db.query(MIGRATION_SQL);
      if (before.historyStatus === "absent") {
        // A concurrent installer must fail/retry, not silently swallow version drift.
        await db.query("insert into supabase_migrations.schema_migrations(version, name, statements) values ($1, $2, $3)",
          [MIGRATION_VERSION, MIGRATION_NAME, [MIGRATION_SQL]]);
      }
    }
    const after = apply ? await inspectState(db) : before;
    const permissions = await inspectPermissions(db, after);
    if (apply && (after.historyStatus !== "matches" || !permissionsMeetBoundary(permissions))) {
      throw new Error("Limiter schema, history or permissions do not meet the expected boundary.");
    }
    await db.query(apply ? "commit" : "rollback");
    log(JSON.stringify({ project: ref, mode: apply ? "apply" : "dry-run", clientTlsVerified: true,
      before, after, permissions, permissionsMeetBoundary: Boolean(permissionsMeetBoundary(permissions)) }));
    if (apply) {
      // A nonzero leading nibble prevents the limiter's unrelated expired-row housekeeping.
      const key = `1${randomBytes(32).toString("hex").slice(1)}`;
      try {
        const outcomes = await Promise.allSettled(Array.from({ length: 12 }, async () => {
          const connection = await connect(config);
          try {
            await beginTransaction(connection, "service_role");
            const result = await connection.query("select public.consume_rate_limit($1, 3, 60000) as allowed", [key]);
            await connection.query("commit");
            if (typeof result.rows[0]?.allowed !== "boolean") throw new Error("Invalid quota response.");
            return result.rows[0].allowed;
          } finally { await connection.end(); }
        }));
        if (outcomes.some((outcome) => outcome.status === "rejected")) throw new Error("Concurrent quota test failed.");
        const allowed = outcomes.filter((outcome) => outcome.status === "fulfilled" && outcome.value).length;
        if (allowed !== 3) throw new Error("Concurrent quota test failed.");
        log(JSON.stringify({ project: ref, parallelConnections: 12, allowed, rejected: 12 - allowed }));
      } finally {
        await beginTransaction(db, "postgres");
        await db.query("delete from public.rate_limit_buckets where bucket_key=$1", [key]);
        await db.query("commit");
      }
    }
  } finally {
    await db.query("rollback").catch(() => undefined);
    await db.end();
  }
}

async function main() {
  const [ref, flag, ...extra] = process.argv.slice(2);
  if (extra.length || (flag && flag !== "--apply")) throw new Error("Use <dev-or-staging-ref> [--apply].");
  await prepareLimiterDatabase({ ref, apply: flag === "--apply", config: nonproductionDatabaseConfig(ref) });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error("Nonproduction database preparation failed. Check target, CLI login, CA, migration history and permissions; no credentials are logged. If migration committed before a probe failed, inspect schema before retrying.");
    process.exitCode = 1;
  });
}
