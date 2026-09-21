#!/usr/bin/env node
/** Offline preparation only. No credentials, database driver, child process or network access. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

export const TARGETS = Object.freeze({ staging: "xwszcafaontidfgznlxd", production: "qahnczmilgptcedaqype" });
const SOURCE_DIR = fileURLToPath(new URL("../supabase/migrations/", import.meta.url));
// New entries may be added only after independent SQL review. Never change applied SQL pins.
const PINS = Object.freeze([
  ["20260917120000", "authenticated_sms_test_identity", "146335b64c2b0d99888ab1a2340e8721f469a83e91bf9a02524cf8eed051b1fa"],
  ["20260917193000", "authenticated_sms_test_tour_context", "a7ecaf2504e7eda820e4059e2341f965b31769c1ac82d0c468b6fe6dcb5cec6d"],
  ["20260917201500", "sms_test_pending_action_and_delivery_provenance", "41ea1c43af24d96b90452f103db8e6670995dc6f519c02cb70152317479353cc"],
  ["20260918130000", "sms_test_tour_wrapper_failed_replace_guard", "9f667d62dfd5acdba18d0f8c49e5a15d536cd87030ee1a08cb82a9f10b10c298"],
  ["20260918131500", "test_workspaces", "54a71a6bdb59ca7123a24235106199a6ed3b97e20ec5595d49a1a049a452b601"],
  ["20260918133000", "remove_raw_live_listing_read_policy", "5d53108acf2a8155aeedcb8aacf44c8cb450978621d5124e0d201c32e622a4fd"],
  ["20260919113000", "reconcile_sms_test_google_cleanup_claim_fence", "cdc40f142b47c647e81b50ca66d7b0a1641c9a3907f88f1011a40ca3ef28f722"],
  ["20260919120000", "harden_test_workspace_schedule_slice", "ffef538feb885bfbca0c311e0482572ea81aa12ce86099c15f70204cdca35de5"],
  ["20260919123000", "revoke_classified_test_workspace_direct_access", "52c4f59995d8812cbb504db4485aa18076fc53050904d0d1a814bfd5c82f8d80"],
  ["20260919124500", "harden_late_test_workspace_direct_access", "f25bc175cfcc79aa29994c705e70a20e44bca8f97fbad97b05c629c25c24a282"],
].map((entry) => Object.freeze(entry)));
const CREATED_TABLES = Object.freeze(["test_workspaces", "test_workspace_members", "test_workspace_schedule_records"]);
const EXCEPTIONS = Object.freeze(["profiles", "profile_roles", "test_workspaces", "test_workspace_members", "site_content_records", "site_config_records", "site_preset_records"]);
// Actual staging and production inventory, absent from DEV. Candidate forward SQL is pinned above; independent release review remains required.
const REQUIRED_FORWARD_TABLES = Object.freeze(["agent_user_preferences", "webhook_deliveries", "webhook_subscriptions"]);
const REVIEWED_FORWARD_POLICY_TABLES = REQUIRED_FORWARD_TABLES;

export function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
const sqlLiteral = (value) => `'${value.replaceAll("'", "''")}'`;
const jsonLiteral = (value) => `${sqlLiteral(JSON.stringify(value))}::jsonb`;
const sorted = (values) => [...values].sort();

/** Mask SQL literals/comments, retaining only top-level syntax for transaction safety checks. */
export function assertTransactionalSql(sql) {
  let plain = "";
  for (let i = 0; i < sql.length;) {
    if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i + 2);
      i = end < 0 ? sql.length : end + 1; plain += "\n"; continue;
    }
    if (sql.startsWith("/*", i)) {
      let depth = 1; i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith("/*", i)) { depth++; i += 2; }
        else if (sql.startsWith("*/", i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) throw new Error("Unterminated SQL comment.");
      plain += " "; continue;
    }
    const dollar = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
    if (dollar) {
      const end = sql.indexOf(dollar[0], i + dollar[0].length);
      if (end < 0) throw new Error("Unterminated dollar-quoted SQL body.");
      i = end + dollar[0].length; plain += " "; continue;
    }
    if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i];
      const escaped = quote === "'" && /(?:^|[^\w$])[eE]$/.test(sql.slice(0, i));
      i++; let closed = false;
      while (i < sql.length) {
        if (escaped && sql[i] === "\\") { i += 2; continue; }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { i += 2; continue; }
          i++; closed = true; break;
        }
        i++;
      }
      if (!closed) throw new Error("Unterminated quoted SQL value.");
      plain += " "; continue;
    }
    plain += sql[i++];
  }
  if (/^\s*\\/m.test(plain)) throw new Error("psql commands are forbidden in migration sources.");
  for (const statement of plain.split(";").map((part) => part.trim()).filter(Boolean)) {
    if (/^(begin|commit|end|rollback|abort|savepoint|release|vacuum|set|reset|discard|copy)\b/i.test(statement)
      || /^(start|prepare)\s+transaction\b/i.test(statement)
      || /^alter\s+system\b/i.test(statement)
      || /^(create\s+(unique\s+)?index|drop\s+index)\s+concurrently\b/i.test(statement)) {
      throw new Error("Migration contains a transaction escape or unsupported top-level command.");
    }
  }
  return true;
}

export function reviewedMigrations({ readSource = (file) => readFileSync(join(SOURCE_DIR, file)), files = readdirSync(SOURCE_DIR) } = {}) {
  return PINS.map(([version, name, expected]) => {
    const file = `${version}_${name}.sql`;
    if (files.filter((candidate) => candidate.startsWith(`${version}_`)).join() !== file) {
      throw new Error(`Missing or duplicate pinned migration version: ${version}.`);
    }
    const bytes = readSource(file);
    if (sha256(bytes) !== expected) throw new Error(`Pinned migration hash changed: ${file}.`);
    const sql = bytes.toString("utf8");
    assertTransactionalSql(sql);
    // One exact file body per ledger array, without normalizing whitespace or SQL literals.
    return { version, name, file, sha256: expected, statements: [sql], sql };
  });
}

export function policyInventory(migrations = reviewedMigrations()) {
  const source = migrations.find((row) => row.version === "20260919123000")?.sql;
  const block = /foreach table_name in array array\[([\s\S]*?)\]/.exec(source ?? "");
  if (!block) throw new Error("Reviewed direct-access policy inventory is missing.");
  const base = [...block[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
  if (base.length !== 146 || new Set(base).size !== 146) throw new Error("Reviewed policy inventory changed.");
  const denied = sorted([...base, ...REVIEWED_FORWARD_POLICY_TABLES]);
  const missingForward = REQUIRED_FORWARD_TABLES.filter((table) => !denied.includes(table));
  return { denied, exceptions: [...EXCEPTIONS], created: [...CREATED_TABLES], missingForward,
    finalTables: sorted([...denied, ...EXCEPTIONS]) };
}

/** Historical SQL is hashed with unambiguous UTF-8 length framing, never copied to output. */
function frame(value) { return value === null ? "N" : `S${Buffer.byteLength(value, "utf8")}:${value}`; }
export function ledgerRowDigest(row) {
  return sha256(frame(row.version) + frame(row.name) + (row.statements === null
    ? "N" : `A${row.statements.length}:` + row.statements.map(frame).join("")));
}
function fingerprints(rows) {
  return [...rows].sort((a, b) => a.version < b.version ? -1 : a.version > b.version ? 1 : 0)
    .map((row) => ({ version: row.version, name: row.name, sha256: ledgerRowDigest(row) }));
}
function validText(value, max) { return typeof value === "string" && value.length <= max && !value.includes("\0"); }

export function validateSnapshot(snapshot, target) {
  if (!Object.hasOwn(TARGETS, target) || !snapshot || snapshot.project !== TARGETS[target] || snapshot.read_only !== "on"
    || !Array.isArray(snapshot.ledger) || !snapshot.ledger.length || snapshot.ledger.length > 10_000
    || !Array.isArray(snapshot.tables) || !snapshot.tables.length) throw new Error("Complete exact-target read-only snapshot required.");
  const versions = new Set();
  const ledger = snapshot.ledger.map((row) => {
    if (!row || !validText(row.version, 128) || !row.version || versions.has(row.version)
      || !(row.name === null || validText(row.name, 512))
      || !(row.statements === null || (Array.isArray(row.statements)
        && row.statements.every((statement) => statement === null || validText(statement, 10_000_000))))) {
      throw new Error("Ledger requires unique versions and exact name/statements, including historical nulls.");
    }
    versions.add(row.version);
    return { version: row.version, name: row.name, statements: row.statements === null ? null : [...row.statements] };
  });
  const tables = snapshot.tables.map((row) => {
    if (!row || !/^[a-z][a-z0-9_]*$/.test(row.name) || row.rls !== true) throw new Error("Public table inventory must include names and enabled RLS.");
    return { name: row.name, rls: true };
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (new Set(tables.map((row) => row.name)).size !== tables.length) throw new Error("Duplicate public table inventory.");
  return { project: snapshot.project, ledger, tables };
}

export function inspectTargetState(snapshot, target, migrations = reviewedMigrations()) {
  const validated = validateSnapshot(snapshot, target);
  const present = [];
  for (const migration of migrations) {
    const matches = validated.ledger.filter((row) => row.version === migration.version || row.name === migration.name);
    if (matches.length > 1 || (matches.length === 1 && (matches[0].version !== migration.version
      || matches[0].name !== migration.name || ledgerRowDigest(matches[0]) !== ledgerRowDigest(migration)))) {
      throw new Error(`Conflicting target migration identity or statements: ${migration.version}.`);
    }
    if (matches.length) present.push(migration.version);
  }
  if (present.length && present.length !== migrations.length) throw new Error("Partial release migration state; forward reconciliation needs separate review.");
  const inventory = policyInventory(migrations);
  const expectedTables = present.length ? inventory.finalTables : inventory.finalTables.filter((name) => !CREATED_TABLES.includes(name));
  const actual = validated.tables.map((row) => row.name);
  const missing = expectedTables.filter((name) => !actual.includes(name));
  const extra = actual.filter((name) => !expectedTables.includes(name));
  if (missing.length || extra.length) throw new Error(`Public table inventory mismatch; missing=${missing.join(",")}; extra=${extra.join(",")}.`);
  if (inventory.missingForward.length) throw new Error(`Reviewed forward coverage is required: ${inventory.missingForward.join(",")}.`);
  return { ...validated, inventory, status: present.length ? "already_complete" : "ready", historical: fingerprints(validated.ledger) };
}

// Match ledgerRowDigest's framing using PostgreSQL UTF-8 byte lengths and array ordinality.
const ROW_DIGEST_SQL = `encode(sha256(convert_to(
  'S'||octet_length(version)::text||':'||version ||
  case when name is null then 'N' else 'S'||octet_length(name)::text||':'||name end ||
  case when statements is null then 'N' else 'A'||cardinality(statements)::text||':'||
    coalesce((select string_agg(case when item is null then 'N' else 'S'||octet_length(item)::text||':'||item end,'' order by ordinal)
      from unnest(statements) with ordinality as statement_items(item,ordinal)), '') end, 'UTF8')), 'hex')`;
const LEDGER_FINGERPRINT_SQL = `(select coalesce(jsonb_agg(jsonb_build_object('version',version,'name',name,'sha256',digest) order by version collate "C"),'[]'::jsonb)
  from (select version,name,${ROW_DIGEST_SQL} as digest from supabase_migrations.schema_migrations) ledger_digest)`;
const TABLE_INVENTORY_SQL = `(select coalesce(jsonb_agg(jsonb_build_object('name',c.relname,'rls',c.relrowsecurity) order by c.relname collate "C"),'[]'::jsonb)
  from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p'))`;

export function buildAtomicBundle({ target, snapshot, backupSha256, readSource, files }) {
  const migrations = reviewedMigrations({ readSource, files });
  const state = inspectTargetState(snapshot, target, migrations);
  if (state.status !== "ready") throw new Error("Release bundle already complete; do not replay or repair history.");
  if (!/^[a-f0-9]{64}$/.test(backupSha256 ?? "")) throw new Error("Verified backup-manifest SHA-256 is required.");
  const expectedAfter = fingerprints([...state.ledger, ...migrations]);
  const denialTargets = state.inventory.denied.map(sqlLiteral).join(",");
  const predicateBody = /as \$\$([\s\S]*?)\$\$;/i.exec(migrations.find((row) => row.version === "20260919123000").sql)?.[1];
  if (!predicateBody) throw new Error("Pinned invoker predicate body missing.");
  const ledgerInserts = migrations.map((row) => `insert into supabase_migrations.schema_migrations(version,name,statements) values (${sqlLiteral(row.version)},${sqlLiteral(row.name)},array[${sqlLiteral(row.sql)}]::text[]);`).join("\n");
  const sql = `-- OFFLINE REVIEW ARTIFACT. Exact target: ${target} / ${TARGETS[target]}.
-- Root must independently verify TLS endpoint/project identity and backup before setting session attestations.
BEGIN;
SET LOCAL standard_conforming_strings = on;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SET LOCAL idle_in_transaction_session_timeout = '180s';
LOCK TABLE supabase_migrations.schema_migrations IN SHARE ROW EXCLUSIVE MODE;
DO $release_preconditions$
BEGIN
  IF current_setting('proplane.release_project_ref',true) IS DISTINCT FROM ${sqlLiteral(TARGETS[target])}
    OR current_setting('proplane.release_backup_sha256',true) IS DISTINCT FROM ${sqlLiteral(backupSha256)}
  THEN RAISE EXCEPTION 'Root target/backup attestation missing or wrong'; END IF;
  IF NOT pg_try_advisory_xact_lock(20260919123000::bigint) THEN RAISE EXCEPTION 'Release already locked'; END IF;
  IF ${LEDGER_FINGERPRINT_SQL} IS DISTINCT FROM ${jsonLiteral(state.historical)}
  THEN RAISE EXCEPTION 'Exact historical migration ledger changed'; END IF;
  IF ${TABLE_INVENTORY_SQL} IS DISTINCT FROM ${jsonLiteral(state.tables)}
  THEN RAISE EXCEPTION 'Complete public table inventory changed'; END IF;
  IF current_setting('server_encoding') <> 'UTF8' THEN RAISE EXCEPTION 'UTF8 ledger fingerprinting required'; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND ((table_name='agent_sessions' AND column_name='test_actor_user_id')
        OR (table_name='prospect_sms_bursts' AND column_name='test_actor_user_id')
        OR (table_name='agent_pending_actions' AND column_name='sms_test_actor_user_id')))
    OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname IN ('record_authenticated_sms_test_ingress','test_workspace_for_user'))
  THEN RAISE EXCEPTION 'Unledgered partial test-workspace schema detected'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role' AND rolbypassrls)
    OR to_regclass('storage.objects') IS NULL
    OR to_regprocedure('public.allocate_sms_proxy_number(uuid)') IS NULL
  THEN RAISE EXCEPTION 'Required service role, storage or allocator prerequisite missing'; END IF;
END $release_preconditions$;
${migrations.map((row) => `\n-- EXACT ${row.file} SHA256 ${row.sha256}\n${row.sql}`).join("\n")}
DO $release_schema_postconditions$
DECLARE table_name text;
BEGIN
  IF ${TABLE_INVENTORY_SQL} IS DISTINCT FROM ${jsonLiteral(state.inventory.finalTables.map((name) => ({ name, rls: true })))}
  THEN RAISE EXCEPTION 'Final complete public table inventory differs'; END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.manager_property_records'::regclass AND polname='manager_property_records_select_live')
  THEN RAISE EXCEPTION 'Raw live listing read policy remains'; END IF;
  FOREACH table_name IN ARRAY ARRAY[${denialTargets}] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=to_regclass('public.'||quote_ident(table_name))
      AND p.polname='test_workspace_classified_direct_deny' AND NOT p.polpermissive AND p.polcmd='*'
      AND p.polroles=ARRAY[(SELECT oid FROM pg_roles WHERE rolname='authenticated')]::oid[]
      AND p.polqual IS NOT NULL AND p.polwithcheck IS NOT NULL
      AND position('is_classified_test_workspace_principal' in pg_get_expr(p.polqual,p.polrelid))>0
      AND position('is_classified_test_workspace_principal' in pg_get_expr(p.polwithcheck,p.polrelid))>0)
    THEN RAISE EXCEPTION 'Missing restrictive business policy: %',table_name; END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='storage.objects'::regclass AND relrowsecurity)
    OR NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='storage.objects'::regclass
      AND polname='test_workspace_classified_direct_storage_deny' AND NOT polpermissive AND polcmd='*'
      AND polroles=ARRAY[(SELECT oid FROM pg_roles WHERE rolname='authenticated')]::oid[]
      AND polqual IS NOT NULL AND polwithcheck IS NOT NULL)
  THEN RAISE EXCEPTION 'Restrictive storage policy missing'; END IF;
  IF has_function_privilege('anon','public.allocate_sms_proxy_number(uuid)','EXECUTE')
    OR has_function_privilege('authenticated','public.allocate_sms_proxy_number(uuid)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.allocate_sms_proxy_number(uuid)','EXECUTE')
    OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.is_classified_test_workspace_principal()'::regprocedure
      AND NOT prosecdef AND prosrc=${sqlLiteral(predicateBody)})
    OR NOT has_function_privilege('authenticated','public.is_classified_test_workspace_principal()','EXECUTE')
    OR has_function_privilege('anon','public.is_classified_test_workspace_principal()','EXECUTE')
    OR NOT has_table_privilege('authenticated','public.test_workspace_members','SELECT')
    OR has_table_privilege('authenticated','public.test_workspace_members','INSERT,UPDATE,DELETE,TRUNCATE')
    OR has_table_privilege('anon','public.test_workspace_members','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
  THEN RAISE EXCEPTION 'Allocator privileges, invoker predicate or membership grants differ'; END IF;
END $release_schema_postconditions$;
${ledgerInserts}
DO $release_ledger_postconditions$
BEGIN
  IF ${LEDGER_FINGERPRINT_SQL} IS DISTINCT FROM ${jsonLiteral(expectedAfter)}
  THEN RAISE EXCEPTION 'Ledger must preserve all historical rows and add only exact reviewed entries'; END IF;
END $release_ledger_postconditions$;
COMMIT;
`;
  return { sql, plan: { target, project: TARGETS[target], status: "prepared_not_applied", backupSha256,
    bundleSha256: sha256(sql), ledgerBefore: state.historical, ledgerAfter: expectedAfter,
    migrations: migrations.map(({ version, name, file, sha256: hash }) => ({ version, name, file, sha256: hash })),
    policies: state.inventory.denied.length,
    limitations: ["Session attestations are not independent project identity proof.", "Offline catalog checks do not prove RLS, storage, RPC or application behavior.", "Full private backup and exact target verification remain root-owned requirements."] } };
}

export function parseArgs(argv) {
  const args = {};
  const allowed = new Set(["--target", "--snapshot", "--backup-sha256", "--out"]);
  for (let i = 0; i < argv.length; i += 2) {
    if (!allowed.has(argv[i]) || Object.hasOwn(args, argv[i]) || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("Unknown, repeated or missing argument. No apply/credential flags exist.");
    args[argv[i]] = argv[i + 1];
  }
  if (argv.length && allowed.size !== Object.keys(args).length) throw new Error("Preparation requires target, snapshot, backup-sha256 and out together.");
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!Object.keys(args).length) {
    const migrations = reviewedMigrations();
    const inventory = policyInventory(migrations);
    console.log(JSON.stringify({ status: inventory.missingForward.length ? "blocked_forward_review" : "manifest_only",
      targets: TARGETS, missingForwardPolicyTables: inventory.missingForward,
      migrations: migrations.map(({ version, name, file, sha256: hash }) => ({ version, name, file, sha256: hash })) }, null, 2));
    return;
  }
  const bundle = buildAtomicBundle({ target: args["--target"], snapshot: JSON.parse(readFileSync(args["--snapshot"], "utf8")), backupSha256: args["--backup-sha256"] });
  const output = resolve(args["--out"]);
  // A new private directory and exclusive files prevent overwriting reviewed artifacts.
  mkdirSync(output, { mode: 0o700 });
  writeFileSync(join(output, "bundle.sql"), bundle.sql, { flag: "wx", mode: 0o600 });
  writeFileSync(join(output, "plan.json"), JSON.stringify(bundle.plan, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ status: bundle.plan.status, target: bundle.plan.target, output, bundleSha256: bundle.plan.bundleSha256 }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : "Preparation refused."); process.exitCode = 1; }
}
