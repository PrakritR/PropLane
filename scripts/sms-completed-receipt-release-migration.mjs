#!/usr/bin/env node
/** One additive completed-receipt SMS migration. Preflight is read-only by default. */
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { backup, connect, credential } from "./sms-durability-release-migrations.mjs";
import { assertSmsLedger, reviewedSmsMigrations, sha256 } from "./sms-durability-release-manifest.mjs";

export const TARGETS = Object.freeze({
  dev: "emstjswhotsnyksqhqyf",
  staging: "xwszcafaontidfgznlxd",
  production: "qahnczmilgptcedaqype",
});
export const MIGRATION = Object.freeze({
  version: "20260926150000",
  name: "sms_completed_receipt_originals",
  hash: "5b4235ff958a0eb1c6b0f07ea589922d1a94d4e770de7b03f1dc5f75358642fa",
});
const BACKUP_DIR = join(homedir(), ".codex", "release-backups", "sms-20260926");
const RESOLVER = "resolve_sms_completed_receipt_original(text,uuid)";
const IMPORTER = "import_sms_projection_historical_event(text,text)";
const RESOLVER_NAME = "resolve_sms_completed_receipt_original";
const IMPORTER_NAME = "import_sms_projection_historical_event";
const OLD_VERSIONS = ["20260925130000", "20260925140000", "20260925150000", "20260925160000", "20260925170000", "20260925180000"];
const INDEX_CONTRACTS = Object.freeze({
  sms_inbound_receipts_payload_cursor_idx: Object.freeze({
    name: "sms_inbound_receipts_payload_cursor_idx", table: "sms_inbound_receipts", method: "btree", unique: false,
    keys: ["first_received_at", "message_sid"], predicates: ["(inbound_payload IS NOT NULL)", "inbound_payload IS NOT NULL"],
    ddl: "create index if not exists sms_inbound_receipts_payload_cursor_idx on public.sms_inbound_receipts (first_received_at,message_sid) where inbound_payload is not null;",
  }),
  manager_sms_numbers_historic_phone_epoch_idx: Object.freeze({
    name: "manager_sms_numbers_historic_phone_epoch_idx", table: "manager_sms_numbers", method: "btree", unique: false,
    keys: ["phone_number", "coalesce(provisioned_at,requested_at)", "released_at"],
    predicates: [
      "(provision_state = ANY (ARRAY['active'::text, 'released'::text]))",
      "provision_state = ANY (ARRAY['active'::text, 'released'::text])",
    ],
    ddl: "create index if not exists manager_sms_numbers_historic_phone_epoch_idx on public.manager_sms_numbers (phone_number,(coalesce(provisioned_at,requested_at)),released_at) where provision_state in ('active','released');",
  }),
});
const normalizeIndexSql = (value) => value.toLowerCase().replace(/\s+/g, "").replace(/^\((.*)\)$/, "$1");

export function reviewedIndexes(sql) {
  const statements = [...sql.matchAll(/create\s+(?:unique\s+)?index\s+if\s+not\s+exists\s+([a-z][a-z0-9_]*)\s+on\s+public\.[\s\S]*?;/gi)];
  const names = statements.map((match) => match[1]);
  if ((sql.match(/create\s+(?:unique\s+)?index\b/gi) ?? []).length !== names.length ||
      names.length < 1 || new Set(names).size !== names.length ||
      !names.includes("manager_sms_numbers_historic_phone_epoch_idx")) {
    throw new Error("Completed-receipt index roster changed");
  }
  return statements.map((match) => {
    const contract = INDEX_CONTRACTS[match[1]];
    if (!contract || normalizeIndexSql(match[0]) !== normalizeIndexSql(contract.ddl)) {
      throw new Error(`Completed-receipt index source changed: ${match[1]}`);
    }
    return contract;
  });
}

export function parseOptions(argv) {
  const out = { phase: "preflight", applyAuthorized: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--target") out.target = argv[++i];
    else if (argv[i] === "--phase") out.phase = argv[++i];
    else if (argv[i] === "--backup-file") out.backupFile = argv[++i];
    else if (argv[i] === "--apply-authorized") out.applyAuthorized = true;
    else throw new Error("Unknown completed-receipt migration option");
  }
  if (!Object.hasOwn(TARGETS, out.target) || !["preflight", "apply", "postflight"].includes(out.phase)) {
    throw new Error("Exact --target dev|staging|production and --phase preflight|apply|postflight required");
  }
  if (out.phase !== "apply" && (out.backupFile || out.applyAuthorized)) throw new Error("Apply options in read-only phase");
  if (out.phase === "apply") {
    if (!out.applyAuthorized || !out.backupFile) throw new Error("Apply requires --apply-authorized and a fresh --backup-file");
    const file = resolve(out.backupFile);
    const directory = dirname(file);
    const name = basename(file);
    if (directory !== BACKUP_DIR || realpathSync(directory) !== BACKUP_DIR ||
        !lstatSync(directory).isDirectory() || (lstatSync(directory).mode & 0o777) !== 0o700 ||
        !name.startsWith(`sms-completed-receipt-${out.target}-`) || !name.endsWith(".dump")) {
      throw new Error("Backup must be a new target-named .dump in the private release directory");
    }
    out.backupFile = file;
  }
  return out;
}

export function functionBody(sql, name) {
  const prefix = `create or replace function public.${name}(`;
  const start = sql.indexOf(prefix);
  if (start < 0 || sql.indexOf(prefix, start + prefix.length) >= 0) throw new Error(`Expected exactly one function: ${name}`);
  const bodyStart = sql.indexOf("as $$", start);
  const nextFunction = sql.indexOf("create or replace function public.", start + prefix.length);
  if (bodyStart < 0 || (nextFunction >= 0 && nextFunction < bodyStart)) throw new Error(`Function body missing: ${name}`);
  const contentStart = bodyStart + "as $$".length;
  const contentEnd = sql.indexOf("$$;", contentStart);
  if (contentEnd < 0 || (nextFunction >= 0 && nextFunction < contentEnd)) throw new Error(`Function body unterminated: ${name}`);
  return sql.slice(contentStart, contentEnd);
}

export function reviewedSource() {
  const six = reviewedSmsMigrations();
  if (six.map((item) => item.version).join(",") !== OLD_VERSIONS.join(",")) throw new Error("Prior SMS migration roster changed");
  const sql = readFileSync(new URL(`../supabase/migrations/${MIGRATION.version}_${MIGRATION.name}.sql`, import.meta.url), "utf8");
  if (sha256(sql) !== MIGRATION.hash) throw new Error("Completed-receipt migration source hash changed");
  if (Buffer.byteLength(sql) > 100_000) throw new Error("Completed-receipt migration exceeds reviewed bound");
  const oldImporterBody = functionBody(six.at(-1).sql, IMPORTER_NAME);
  const importerBody = functionBody(sql, IMPORTER_NAME);
  const resolverBody = functionBody(sql, RESOLVER_NAME);
  const indexes = reviewedIndexes(sql);
  if ((importerBody.match(/public\.resolve_sms_completed_receipt_original\(/g) ?? []).length !== 2 ||
      !resolverBody.includes("p_expected_owner")) throw new Error("Completed-receipt source call contract changed");
  return { six, sql, oldImporterBody, importerBody, resolverBody, indexes };
}

export async function assertLedger(client, six, applied) {
  const versions = [...OLD_VERSIONS, MIGRATION.version];
  const names = [...six.map((item) => item.name), MIGRATION.name];
  const rows = (await client.query(
    "select version,name,statements from supabase_migrations.schema_migrations where version=any($1::text[]) or name=any($2::text[]) order by version",
    [versions, names],
  )).rows;
  const prior = rows.filter((row) => OLD_VERSIONS.includes(row.version));
  if (prior.length !== six.length || rows.some((row) => !versions.includes(row.version))) throw new Error("Prior SMS ledger roster differs");
  assertSmsLedger(prior, six, { expectApplied: true });
  const newRows = rows.filter((row) => row.version === MIGRATION.version || row.name === MIGRATION.name);
  if (!applied && newRows.length !== 0) throw new Error("Completed-receipt migration already recorded");
  if (applied && (newRows.length !== 1 || newRows[0].version !== MIGRATION.version ||
      newRows[0].name !== MIGRATION.name || !Array.isArray(newRows[0].statements) ||
      sha256(newRows[0].statements.join("\n")) !== MIGRATION.hash)) {
    throw new Error("Completed-receipt migration ledger differs");
  }
}

async function functionCatalog(client, signature, name) {
  const overloads = (await client.query(`select p.oid::text oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname=$1`, [name])).rows;
  const detail = (await client.query(`select p.prosrc, p.prosecdef, p.provolatile, p.proconfig,
    pg_get_userbyid(p.proowner) owner,
    has_function_privilege('anon',p.oid,'EXECUTE') anon_access,
    has_function_privilege('authenticated',p.oid,'EXECUTE') auth_access,
    has_function_privilege('service_role',p.oid,'EXECUTE') service_access
    from pg_proc p where p.oid=to_regprocedure($1)`, [`public.${signature}`])).rows;
  return { overloads, detail };
}

export async function assertFunction(client, signature, name, expectedBody, expectedCount) {
  const { overloads, detail } = await functionCatalog(client, signature, name);
  if (overloads.length !== expectedCount) throw new Error(`SMS function overload/absence mismatch: ${name}`);
  if (expectedCount === 0) return;
  const row = detail[0];
  if (detail.length !== 1 || row.prosrc !== expectedBody || !row.prosecdef || row.provolatile !== "v" ||
      !row.proconfig?.includes("search_path=public, pg_temp") || row.owner !== "postgres" ||
      row.anon_access || row.auth_access || !row.service_access) {
    throw new Error(`SMS function definition/ACL mismatch: ${name}`);
  }
}

// The final reviewed SQL supplies the index roster. Query by index name even
// before apply: CREATE INDEX IF NOT EXISTS would otherwise silently accept a
// same-name relation with an incompatible definition.
export async function assertIndex(client, expected, applied) {
  const rows = (await client.query(`select ns.nspname schema_name, idx.relkind index_kind,
      tabns.nspname table_schema, tab.relname table_name, am.amname method,
      i.indisunique is_unique, i.indisvalid is_valid, i.indisready is_ready,
      i.indnkeyatts key_count,
      array(select pg_get_indexdef(i.indexrelid,k,true)
        from generate_series(1,i.indnkeyatts) k order by k) key_definitions,
      pg_get_expr(i.indpred,i.indrelid) predicate
    from pg_class idx join pg_namespace ns on ns.oid=idx.relnamespace
    left join pg_index i on i.indexrelid=idx.oid
    left join pg_class tab on tab.oid=i.indrelid
    left join pg_namespace tabns on tabns.oid=tab.relnamespace
    left join pg_am am on am.oid=idx.relam
    where ns.nspname='public' and idx.relname=$1`, [expected.name])).rows;
  if (!applied && rows.length === 0) return;
  const row = rows[0];
  if (rows.length !== 1 || row.schema_name !== "public" || row.index_kind !== "i" ||
      row.table_schema !== "public" || row.table_name !== expected.table ||
      row.method !== expected.method || row.is_unique !== expected.unique ||
      row.is_valid !== true || row.is_ready !== true ||
      Number(row.key_count) !== expected.keys.length ||
      !Array.isArray(row.key_definitions) ||
      row.key_definitions.length !== expected.keys.length ||
      row.key_definitions.some((key, index) => normalizeIndexSql(key) !== normalizeIndexSql(expected.keys[index])) ||
      !expected.predicates.some((predicate) => predicate === row.predicate ||
        (predicate !== null && row.predicate !== null &&
          normalizeIndexSql(predicate) === normalizeIndexSql(row.predicate)))) {
    throw new Error(`Completed-receipt index definition mismatch: ${expected.name}`);
  }
}

export async function catalog(client, source, applied) {
  await assertLedger(client, source.six, applied);
  const prerequisites = (await client.query(`select
    to_regclass('public.sms_inbound_receipts') is not null receipts,
    to_regclass('public.inbound_sms_log') is not null inbound_log,
    to_regclass('public.prospect_sms_ingress') is not null ingress,
    to_regclass('public.prospect_sms_bursts') is not null bursts,
    to_regclass('public.sms_projection_turns') is not null turns`)).rows[0];
  if (!prerequisites || Object.values(prerequisites).some((value) => value !== true)) throw new Error("Completed-receipt prerequisite missing");
  await assertFunction(client, RESOLVER, RESOLVER_NAME, source.resolverBody, applied ? 1 : 0);
  await assertFunction(client, IMPORTER, IMPORTER_NAME, applied ? source.importerBody : source.oldImporterBody, 1);
  for (const index of source.indexes) await assertIndex(client, index, applied);
}

async function readOnlyCatalog(client, source, applied, checkCatalog = catalog) {
  await client.query("begin read only");
  try {
    await client.query("set local role postgres");
    await checkCatalog(client, source, applied);
  } finally {
    await client.query("rollback").catch(() => undefined);
  }
}

export async function runMigration(options, dependencies = {}) {
  const source = (dependencies.reviewedSource ?? reviewedSource)();
  const config = (dependencies.credential ?? credential)(TARGETS[options.target]);
  const open = dependencies.connect ?? connect;
  const makeBackup = dependencies.backup ?? backup;
  const checkCatalog = dependencies.catalog ?? catalog;
  let client = await open(config);
  try {
    if (options.phase === "postflight") {
      await readOnlyCatalog(client, source, true, checkCatalog);
      console.log(JSON.stringify({ target: options.target, phase: "postflight", ledger: "seven_exact", catalog: "verified" }));
      return;
    }
    await readOnlyCatalog(client, source, false, checkCatalog);
    if (options.phase === "preflight") {
      console.log(JSON.stringify({ target: options.target, phase: "preflight", priorLedger: "six_exact",
        migration: { version: MIGRATION.version, hash: MIGRATION.hash }, ready: true }));
      return;
    }
    makeBackup(config, options.backupFile);
    await client.query("begin");
    let commitAttempted = false;
    try {
      await client.query("set local role postgres");
      await client.query("set local lock_timeout='3s'");
      await client.query("set local statement_timeout='60s'");
      const lock = (await client.query("select pg_try_advisory_xact_lock(20260926150000::bigint) acquired")).rows[0];
      if (!lock?.acquired) throw new Error("Completed-receipt migration lock unavailable");
      await checkCatalog(client, source, false);
      await client.query(source.sql);
      await client.query("insert into supabase_migrations.schema_migrations(version,name,statements) values($1,$2,$3)",
        [MIGRATION.version, MIGRATION.name, [source.sql]]);
      await checkCatalog(client, source, true);
      commitAttempted = true;
      await client.query("commit");
    } catch (error) {
      if (!commitAttempted) await client.query("rollback").catch(() => undefined);
      throw error;
    }
    await client.end();
    client = await open(config);
    await readOnlyCatalog(client, source, true, checkCatalog);
    console.log(JSON.stringify({ target: options.target, phase: "apply", outcome: "committed_and_verified",
      backupFile: options.backupFile, ledger: "seven_exact", catalog: "verified" }));
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function main() {
  await runMigration(parseOptions(process.argv.slice(2)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error("Completed-receipt migration failed. Commit may be uncertain; inspect exact ledger and catalog before retrying.");
    process.exitCode = 1;
  });
}
