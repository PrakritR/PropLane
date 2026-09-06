import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCTION_PROJECT, assertProductionUrl, productionDatabaseConfig, connectProductionDatabase } from "./production-database.mjs";

// Fixed reviewed files only. Changing a migration requires another review and
// explicitly updating its pin; no directory scan or arbitrary SQL/path option.
const MANIFEST = [
  ["20260906020000", "shared_rate_limits", "b69744eb4c17d6b386d20fec365412529138387c9c96f9d9684d540c80c93a25"],
  ["20260906030000", "application_document_envelopes", "60878b499bdaead9d226df39b68739f5cfcb32cf1432809f22761dad4536ede2"],
  ["20260906031000", "application_document_aliases", "73d2e5ac21d7cfffe5abb11f5ed4bbecaaba7fae1a730640a4bdc33cea440c77"],
  ["20260906040000", "sensitive_table_browser_privileges", "90652ba1e6b18c1f38ca270614f12783350bccf60f3f435dfe6778ae78644b7b"],
  ["20260906050000", "application_record_normalization", "536cdb2d7829811faa1ed68147a6eade2a542abcf7144f217faa97e7c6671f76"],
];
const BASE_TABLES = ["public.profiles", "public.profile_roles", "public.manager_application_records",
  "public.cosigner_submission_records", "public.manager_automation_settings", "public.screening_orders",
  "public.application_fee_waiver_redemptions", "storage.buckets", "storage.objects", "supabase_migrations.schema_migrations"];
const NEW_TABLES = ["public.rate_limit_buckets", "public.application_document_storage_aliases"];
const PRIVATE_TABLES = ["public.manager_application_records", "public.cosigner_submission_records", "public.manager_automation_settings", ...NEW_TABLES];
const PROFILE_TABLES = ["public.profiles", "public.profile_roles"];
const FUNCTIONS = [
  { signature: "public.consume_rate_limit(text,integer,integer)", version: "20260906020000", definer: false, returns: "boolean" },
  { signature: "public.normalize_application_record_id(text,jsonb,jsonb)", version: "20260906050000", definer: true, returns: "void" },
];
const MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf", "application/octet-stream"];
const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];

export function reviewedProductionMigrations() {
  return MANIFEST.map(([version, name, sha256]) => {
    const sql = readFileSync(new URL(`../../supabase/migrations/${version}_${name}.sql`, import.meta.url), "utf8");
    if (createHash("sha256").update(sql).digest("hex") !== sha256) throw new Error("Reviewed migration file digest changed.");
    return { version, name, sha256, sql };
  });
}

export function parseProductionSchemaArgs(args) {
  const allowed = new Set(["--apply", "--dry-run", `--confirm-project=${PRODUCTION_PROJECT}`]);
  if (new Set(args).size !== args.length || args.some((arg) => !allowed.has(arg)) ||
      (args.includes("--apply") && args.includes("--dry-run"))) throw new Error("Unsupported production schema arguments.");
  const apply = args.includes("--apply");
  const confirmProject = args.includes(`--confirm-project=${PRODUCTION_PROJECT}`) ? PRODUCTION_PROJECT : undefined;
  if (apply && confirmProject !== PRODUCTION_PROJECT) throw new Error("Explicit production project confirmation required.");
  return { apply, confirmProject };
}

async function inspect(db, migrations) {
  const tables = (await db.query(`/* production-schema:tables */
    select requested as name, c.oid is not null as present, c.relkind, c.relrowsecurity as rls,
      (select count(*)::int from pg_policy p where p.polrelid=c.oid) as policy_count
    from unnest($1::text[]) requested left join pg_class c on c.oid=to_regclass(requested)`, [[...BASE_TABLES, ...NEW_TABLES]])).rows;
  const tableMap = new Map(tables.map((row) => [row.name, row]));
  const prerequisites = BASE_TABLES.every((name) => tableMap.get(name)?.present && tableMap.get(name)?.relkind === "r");
  const history = tableMap.get("supabase_migrations.schema_migrations")?.present ? (await db.query(
    "/* production-schema:history */ select version,name,statements from supabase_migrations.schema_migrations where version=any($1::text[])",
    [migrations.map((item) => item.version)],
  )).rows : [];
  const statuses = migrations.map((migration) => {
    const rows = history.filter((row) => row.version === migration.version);
    return { version: migration.version, status: rows.length === 0 ? "absent" : rows.length === 1 &&
      rows[0].name === migration.name && Array.isArray(rows[0].statements) && rows[0].statements.length === 1 &&
      rows[0].statements[0] === migration.sql ? "matches" : "drift" };
  });
  const functions = (await db.query(`/* production-schema:functions */
    select signature, p.oid is not null as present, p.prosecdef as definer, p.prosrc as body,
      p.proconfig as config, format_type(p.prorettype,null) as returns, pg_get_userbyid(p.proowner) as owner,
      case when p.oid is not null then has_function_privilege('anon',p.oid,'EXECUTE') end as anon_execute,
      case when p.oid is not null then has_function_privilege('authenticated',p.oid,'EXECUTE') end as user_execute,
      case when p.oid is not null then has_function_privilege('service_role',p.oid,'EXECUTE') end as server_execute
    from unnest($1::text[]) signature left join pg_proc p on p.oid=to_regprocedure(signature)`, [FUNCTIONS.map((item) => item.signature)])).rows;
  const bucket = tableMap.get("storage.buckets")?.present ? (await db.query(
    "/* production-schema:bucket */ select public,file_size_limit,allowed_mime_types from storage.buckets where id='application-documents'",
  )).rows : [];
  const existingPrivate = PRIVATE_TABLES.filter((name) => tableMap.get(name)?.present);
  const existingProfiles = PROFILE_TABLES.filter((name) => tableMap.get(name)?.present);
  const grants = (await db.query(`/* production-schema:grants */
    select table_name, role_name, privilege, has_table_privilege(role_name,table_name,privilege) as allowed
    from unnest($1::text[]) table_name cross join unnest(array['anon','authenticated','service_role']) role_name
    cross join unnest($2::text[]) privilege`, [[...existingPrivate, ...existingProfiles], PRIVILEGES])).rows;
  const columns = (await db.query(`/* production-schema:columns */
    select requested as table_name,a.attname as name,format_type(a.atttypid,a.atttypmod) as type,a.attnotnull as required
    from unnest($1::text[]) requested join pg_attribute a on a.attrelid=to_regclass(requested)
    where a.attnum>0 and not a.attisdropped`, [[...existingPrivate, "public.screening_orders", "public.application_fee_waiver_redemptions"]])).rows;
  const constraints = (await db.query(`/* production-schema:constraints */
    select requested as table_name,c.contype as kind,c.confdeltype as delete_action,
      c.confrelid::regclass::text as referenced_table,
      array(select a.attname::text from unnest(c.conkey) with ordinality k(attnum,position)
        join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum order by k.position) as columns,
      pg_get_constraintdef(c.oid) as definition
    from unnest($1::text[]) requested join pg_constraint c on c.conrelid=to_regclass(requested)`, [NEW_TABLES.filter((name) => tableMap.get(name)?.present)])).rows;
  return { tableMap, statuses, functions, bucket, grants, columns, constraints, prerequisites };
}

function functionValid(state, migration) {
  const spec = FUNCTIONS.find((item) => item.version === migration.version);
  const row = state.functions.find((item) => item.signature === spec.signature);
  const body = migration.sql.split("as $$\n")[1]?.split("\n$$;")[0]?.trim();
  return Boolean(row?.present && row.definer === spec.definer && row.returns === spec.returns && row.owner === "postgres" &&
    row.body?.trim() === body && row.config?.length === 1 && /^search_path=(?:""|)$/.test(row.config[0]) &&
    row.anon_execute === false && row.user_execute === false && row.server_execute === true);
}

function bucketValid(state) {
  const bucket = state.bucket[0];
  return state.bucket.length === 1 && bucket.public === false && Number(bucket.file_size_limit) === 15732736 &&
    Array.isArray(bucket.allowed_mime_types) && bucket.allowed_mime_types.length === MIME_TYPES.length &&
    MIME_TYPES.every((mime) => bucket.allowed_mime_types.includes(mime)) && state.tableMap.get("storage.objects")?.rls === true;
}

function privateTableValid(state, name, noPolicies = false) {
  const table = state.tableMap.get(name);
  const grants = state.grants.filter((row) => row.table_name === name);
  return Boolean(table?.present && table.relkind === "r" && table.rls === true && (!noPolicies || table.policy_count === 0) &&
    grants.length === 21 && grants.filter((row) => row.role_name !== "service_role").every((row) => row.allowed === false) &&
    ["SELECT", "INSERT", "UPDATE", "DELETE"].every((privilege) => grants.some((row) => row.role_name === "service_role" && row.privilege === privilege && row.allowed === true)));
}

function columnsPresent(state, table, spec) {
  return Object.entries(spec).every(([name, type]) => state.columns.some((column) => column.table_name === table && column.name === name && column.type === type));
}

function constraintsValid(state, table) {
  const constraints = state.constraints.filter((row) => row.table_name === table);
  const hasKey = (kind, column) => constraints.some((row) => row.kind === kind && row.columns?.length === 1 && row.columns[0] === column);
  const checks = constraints.filter((row) => row.kind === "c").map((row) => row.definition.replace(/::text|[\s()]/g, ""));
  if (table === NEW_TABLES[0]) return hasKey("p", "bucket_key") &&
    ["CHECKbucket_key~'^[a-f0-9]{64}$'", "CHECKrequest_count>0"].every((check) => checks.includes(check));
  return hasKey("p", "source_path") && hasKey("u", "encrypted_path") &&
    constraints.some((row) => row.kind === "f" && row.columns?.length === 1 && row.columns[0] === "application_id" &&
      ["public.manager_application_records", "manager_application_records"].includes(row.referenced_table) && row.delete_action === "c" && /REFERENCES (?:public\.)?manager_application_records\(id\)/.test(row.definition)) &&
    ["CHECKsource_path<>encrypted_path", "CHECKsource_path~~'application/%'ANDsource_path!~~'%.penc'", "CHECKencrypted_path~~'application/%.penc'"].every((check) => checks.includes(check));
}

function migrationValid(state, migration) {
  switch (migration.version) {
    case "20260906020000": return privateTableValid(state, NEW_TABLES[0], true) && constraintsValid(state, NEW_TABLES[0]) && functionValid(state, migration) &&
      columnsPresent(state, NEW_TABLES[0], { bucket_key: "text", request_count: "integer", reset_at: "timestamp with time zone" });
    case "20260906030000": return bucketValid(state);
    case "20260906031000": return privateTableValid(state, NEW_TABLES[1], true) && constraintsValid(state, NEW_TABLES[1]) &&
      columnsPresent(state, NEW_TABLES[1], { source_path: "text", application_id: "text", encrypted_path: "text", created_at: "timestamp with time zone", source_removed_at: "timestamp with time zone" });
    case "20260906040000": return PRIVATE_TABLES.slice(0, 3).every((name) => privateTableValid(state, name)) && PROFILE_TABLES.every((name) => {
      const grants = state.grants.filter((row) => row.table_name === name && row.role_name !== "service_role");
      return state.tableMap.get(name)?.rls === true && grants.length === 14 && grants.filter((row) => ["TRUNCATE", "REFERENCES", "TRIGGER"].includes(row.privilege)).every((row) => row.allowed === false);
    });
    case "20260906050000": return functionValid(state, migration);
    default: return false;
  }
}

function plan(state, migrations) {
  const untrackedObjects = state.statuses.some(({ version, status }) => status === "absent" && (
    (version === "20260906020000" && (state.tableMap.get(NEW_TABLES[0])?.present || state.functions.find((row) => row.signature === FUNCTIONS[0].signature)?.present)) ||
    (version === "20260906031000" && state.tableMap.get(NEW_TABLES[1])?.present) ||
    (version === "20260906050000" && state.functions.find((row) => row.signature === FUNCTIONS[1].signature)?.present)));
  const exactApplied = state.statuses.every(({ version, status }) => status !== "matches" || migrationValid(state, migrations.find((item) => item.version === version)));
  const requiredColumns = columnsPresent(state, "public.manager_application_records", { id: "text", manager_user_id: "uuid", resident_email: "text", property_id: "text", assigned_property_id: "text", row_data: "jsonb", created_at: "timestamp with time zone", updated_at: "timestamp with time zone" }) &&
    columnsPresent(state, "public.cosigner_submission_records", { signer_app_id: "text", row_data: "jsonb", updated_at: "timestamp with time zone" }) &&
    ["public.screening_orders", "public.application_fee_waiver_redemptions"].every((table) => columnsPresent(state, table, { application_id: "text" }));
  return { prerequisitesPresent: state.prerequisites && requiredColumns && state.bucket.length === 1,
    historyMatches: state.statuses.filter((row) => row.status === "matches").length,
    pendingMigrations: state.statuses.filter((row) => row.status === "absent").length,
    historyDrift: state.statuses.some((row) => row.status === "drift"), untrackedObjects, appliedBoundariesValid: exactApplied,
    canApply: state.prerequisites && requiredColumns && state.bucket.length === 1 && !untrackedObjects && exactApplied && !state.statuses.some((row) => row.status === "drift") };
}

/** No row inventory or quota probe; the only writes are the five pinned SQL
 * files plus their exact migration-history entries, in the same transaction. */
export async function installProductionSchema({ apply = false, confirmProject, url = process.env.NEXT_PUBLIC_SUPABASE_URL,
  config, connect = connectProductionDatabase, log = console.log }) {
  assertProductionUrl(url);
  if (apply && confirmProject !== PRODUCTION_PROJECT) throw new Error("Explicit production project confirmation required.");
  const migrations = reviewedProductionMigrations();
  const db = await connect(config ?? productionDatabaseConfig());
  try {
    await db.query(apply ? "begin" : "begin read only");
    await db.query("set local role postgres");
    await db.query("set local statement_timeout = '30s'");
    await db.query("set local lock_timeout = '5s'");
    if (apply) {
      await db.query("select pg_advisory_xact_lock(20260906, 20000)");
      // Serialize history writers; a missing history table fails without DDL.
      await db.query("lock table supabase_migrations.schema_migrations in share row exclusive mode");
    }
    const before = await inspect(db, migrations);
    const beforePlan = plan(before, migrations);
    if (apply && !beforePlan.canApply) throw new Error("Production schema prerequisites or drift require review.");
    let applied = 0;
    if (apply) for (const migration of migrations) {
      if (before.statuses.find((row) => row.version === migration.version).status === "matches") continue;
      await db.query(migration.sql);
      await db.query("insert into supabase_migrations.schema_migrations(version,name,statements) values ($1,$2,$3)", [migration.version, migration.name, [migration.sql]]);
      applied++;
    }
    const after = apply ? await inspect(db, migrations) : before;
    const afterPlan = plan(after, migrations);
    const boundariesValid = migrations.every((migration) => migrationValid(after, migration));
    // The profile migration only removes dangerous non-row privileges. Preserve
    // the prior effective browser SELECT/INSERT/UPDATE/DELETE access exactly.
    const profileRowGrantsPreserved = before.grants.filter((row) => PROFILE_TABLES.includes(row.table_name) && row.role_name !== "service_role" && ["SELECT", "INSERT", "UPDATE", "DELETE"].includes(row.privilege)).every((row) =>
      after.grants.some((next) => next.table_name === row.table_name && next.role_name === row.role_name && next.privilege === row.privilege && next.allowed === row.allowed));
    if (apply && (!afterPlan.canApply || afterPlan.historyMatches !== 5 || !boundariesValid || !profileRowGrantsPreserved)) throw new Error("Production schema post-apply verification failed.");
    await db.query(apply ? "commit" : "rollback");
    const evidence = { productionProjectConfirmed: true, clientTlsVerified: true, apply, fixedMigrations: 5, applied,
      before: beforePlan, after: afterPlan, boundariesValid, profileRowGrantsPreserved };
    log(JSON.stringify(evidence));
    return evidence;
  } finally {
    await db.query("rollback").catch(() => undefined);
    await db.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => installProductionSchema(parseProductionSchemaArgs(process.argv.slice(2)))).catch(() => {
    console.error("Production schema preparation failed. Check explicit project confirmation, verified TLS, prerequisites, fixed migration history and boundary verification. No credentials or customer values are logged. If COMMIT acknowledgement was lost, inspect with dry-run before retrying.");
    process.exitCode = 1;
  });
}
