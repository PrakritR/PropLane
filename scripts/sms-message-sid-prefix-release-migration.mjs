#!/usr/bin/env node
/** Exact-target, additive Message SID correction. Preflight is read-only. */
import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { backup, connect, credential } from "./sms-durability-release-migrations.mjs";
import { reviewedSmsMigrations, SMS_RELEASE_TARGETS, sha256 } from "./sms-durability-release-manifest.mjs";
import { functionBody, reviewedSource as reviewedCompletedReceipt, assertFunction, assertIndex } from "./sms-completed-receipt-release-migration.mjs";

export const MIGRATION = Object.freeze({
  version: "20260926220000", name: "sms_message_sid_prefix_correction",
  hash: "3ff94400ba309effa6b75c3d4535f89fd9f646884682207feb2911c258b449ae",
});
const BACKUP_DIR = join(homedir(), ".codex", "release-backups", "sms-20260926");
const FUNCTIONS = [
  { name: "queue_sms_projection_manager_log_intent", signature: "queue_sms_projection_manager_log_intent()", prior: "20260925160000_sms_projection_corrections.sql", returnType: "trigger" },
  { name: "project_sms_conversation_event", signature: "project_sms_conversation_event(jsonb)", prior: "20260925180000_sms_projection_durability_correction2.sql", returnType: "jsonb" },
  { name: "import_sms_projection_historical_event", signature: "import_sms_projection_historical_event(text,text)", prior: "20260926150000_sms_completed_receipt_originals.sql", returnType: "jsonb" },
];
const PREREQUISITES = [
  ...reviewedSmsMigrations().map(({ version, name, hash }) => ({ version, name, hash })),
  { version: "20260926150000", name: "sms_completed_receipt_originals", hash: "5b4235ff958a0eb1c6b0f07ea589922d1a94d4e770de7b03f1dc5f75358642fa" },
  { version: "20260926190000", name: "sms_retained_historical_source", hash: "a829b4cf30cebc57e50ca486318e7751cf6823ff3c451e9d3038d6c267eba0f6" },
  { version: "20260926210000", name: "sms_notice_atomic_reopen", hash: "6c9f3a06643ef8220d93da803eaebc1666c4d7054f259840859a753ddfda7d54" },
];
const PROJECTION_TABLES = ["sms_projection_conversations", "sms_projection_turns", "sms_projection_aliases", "sms_projection_pending", "sms_projection_view_state", "sms_projection_cutover", "sms_projection_deleted_events", "sms_projection_ambiguous_aliases"];
const PROJECTION_RPCS = ["delete_sms_projection_conversation(uuid,uuid,uuid)", "bind_sms_projection_legacy_thread_alias(uuid,uuid,text,text,text,text,uuid,timestamptz,text)"];

export function parseOptions(argv) {
  const out = { phase: "preflight" }, seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (["--target", "--phase", "--backup-file"].includes(flag)) {
      if (seen.has(flag) || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`Invalid or duplicate option: ${flag}`);
      seen.add(flag);
      out[flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
    } else if (flag === "--apply-authorized" && !seen.has(flag)) { seen.add(flag); out.applyAuthorized = true; }
    else throw new Error(`Unknown or duplicate option: ${flag}`);
  }
  if (!Object.hasOwn(SMS_RELEASE_TARGETS, out.target) || !["preflight", "rehearsal", "apply", "postflight"].includes(out.phase)) {
    throw new Error("Exact target and phase required");
  }
  if (out.phase === "rehearsal" && out.target !== "staging") throw new Error("Rehearsal is staging-only");
  if (out.phase === "apply") {
    if (!out.applyAuthorized || !out.backupFile) throw new Error("Apply requires authorization and backup file");
    const file = resolve(out.backupFile);
    if (dirname(file) !== BACKUP_DIR || !basename(file).startsWith(`sms-sid-prefix-${out.target}-`) || !file.endsWith(".dump")) {
      throw new Error("Backup path must be private and target-named");
    }
    out.backupFile = file;
  } else if (out.applyAuthorized || out.backupFile) throw new Error("Apply flags invalid for this phase");
  return out;
}

export function reviewedSource() {
  const sql = readFileSync(new URL(`../supabase/migrations/${MIGRATION.version}_${MIGRATION.name}.sql`, import.meta.url), "utf8");
  if (sha256(sql) !== MIGRATION.hash || Buffer.byteLength(sql) > 50_000) throw new Error("SID correction SQL changed");
  const bodies = FUNCTIONS.map((fn) => ({ ...fn,
    priorBody: functionBody(readFileSync(new URL(`../supabase/migrations/${fn.prior}`, import.meta.url), "utf8"), fn.name),
    nextBody: functionBody(sql, fn.name),
  }));
  return { sql, bodies };
}

export function assertLedger(rows, applied) {
  const expected = [...PREREQUISITES, ...(applied ? [MIGRATION] : [])];
  if (rows.length !== expected.length) throw new Error("SID correction ledger roster differs");
  for (const entry of expected) {
    const matching = rows.filter((row) => row.version === entry.version || row.name === entry.name);
    if (matching.length !== 1 || matching[0].version !== entry.version || matching[0].name !== entry.name ||
        !Array.isArray(matching[0].statements) || sha256(matching[0].statements.join("\n")) !== entry.hash) {
      throw new Error(`SID correction ledger differs: ${entry.version}`);
    }
  }
}

export function assertFunctions(rows, source, applied) {
  if (rows.length !== source.bodies.length) throw new Error("SID correction function roster differs");
  for (const fn of source.bodies) {
    const matching = rows.filter((row) => row.signature === fn.signature);
    const row = matching[0];
    if (matching.length !== 1 || row.body !== (applied ? fn.nextBody : fn.priorBody) ||
        row.returnType !== fn.returnType || row.language !== "plpgsql" || row.volatility !== "v" ||
        !row.securityDefiner || !row.searchPath?.includes("search_path=public, pg_temp") ||
        row.owner !== "postgres" || row.anonExecute || row.authExecute || !row.serviceExecute) {
      throw new Error(`SID correction function definition or ACL differs: ${fn.name}`);
    }
  }
}

export async function checkCatalog(client, source, applied) {
  const versions = [...PREREQUISITES.map((item) => item.version), MIGRATION.version];
  const names = [...PREREQUISITES.map((item) => item.name), MIGRATION.name];
  const ledger = (await client.query(`select version,name,statements from supabase_migrations.schema_migrations
    where version=any($1::text[]) or name=any($2::text[])`, [versions, names])).rows;
  assertLedger(ledger, applied);
  const functions = (await client.query(`select replace(replace(p.oid::regprocedure::text,'public.',''),', ',',') signature,
    p.prosrc body,p.prorettype::regtype::text "returnType",l.lanname language,p.provolatile volatility,
    p.prosecdef "securityDefiner",p.proconfig[1] "searchPath",pg_get_userbyid(p.proowner) owner,
    has_function_privilege('anon',p.oid,'EXECUTE') "anonExecute",
    has_function_privilege('authenticated',p.oid,'EXECUTE') "authExecute",
    has_function_privilege('service_role',p.oid,'EXECUTE') "serviceExecute"
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang
    where n.nspname='public' and p.proname=any($1::text[])`, [source.bodies.map((fn) => fn.name)])).rows;
  assertFunctions(functions, source, applied);
  // Keep the earlier release gates even though this migration replaces the
  // importer body. A successful three-function check alone cannot prove the
  // projection tables and other RPCs remain private.
  for (const table of PROJECTION_TABLES) {
    const result = await client.query(`select c.relrowsecurity rls,
      has_table_privilege('anon',$1,'SELECT') or has_table_privilege('anon',$1,'INSERT') or has_table_privilege('anon',$1,'UPDATE') or has_table_privilege('anon',$1,'DELETE') anon_access,
      has_table_privilege('authenticated',$1,'SELECT') or has_table_privilege('authenticated',$1,'INSERT') or has_table_privilege('authenticated',$1,'UPDATE') or has_table_privilege('authenticated',$1,'DELETE') auth_access,
      has_table_privilege('service_role',$1,'SELECT') and has_table_privilege('service_role',$1,'INSERT') and has_table_privilege('service_role',$1,'UPDATE') and has_table_privilege('service_role',$1,'DELETE') service_access
      from pg_class c where c.oid=to_regclass($1)`, [`public.${table}`]);
    if (result.rows.length !== 1 || !result.rows[0].rls || result.rows[0].anon_access ||
        result.rows[0].auth_access || !result.rows[0].service_access) throw new Error(`SMS table ACL/RLS mismatch: ${table}`);
  }
  for (const signature of PROJECTION_RPCS) {
    const result = await client.query(`select has_function_privilege('anon',$1,'EXECUTE') anon_access,
      has_function_privilege('authenticated',$1,'EXECUTE') auth_access,
      has_function_privilege('service_role',$1,'EXECUTE') service_access`, [`public.${signature}`]);
    if (result.rows.length !== 1 || result.rows[0].anon_access || result.rows[0].auth_access ||
        !result.rows[0].service_access) throw new Error(`SMS function ACL mismatch: ${signature}`);
  }
  const completed = reviewedCompletedReceipt();
  await assertFunction(client, "resolve_sms_completed_receipt_original(text,uuid)",
    "resolve_sms_completed_receipt_original", completed.resolverBody, 1);
  for (const index of completed.indexes) await assertIndex(client, index, true);
  const cutover = await client.query("select ready from public.sms_projection_cutover where singleton=true");
  if (cutover.rows.length !== 1) throw new Error("SMS cutover singleton missing");
  const trigger = (await client.query(`select t.tgenabled enabled,p.proname function_name from pg_trigger t
    join pg_proc p on p.oid=t.tgfoid where t.tgrelid='public.manager_sms_messages'::regclass
    and t.tgname='queue_sms_projection_manager_log_intent' and not t.tgisinternal`)).rows;
  if (trigger.length !== 1 || trigger[0].enabled !== "O" || trigger[0].function_name !== "queue_sms_projection_manager_log_intent") {
    throw new Error("SID correction manager-log trigger differs");
  }
  if (applied) {
    for (const table of ["sms_projection_turns", "sms_projection_deleted_events"]) {
      const missing = (await client.query(`select count(*)::integer n from public.${table}
        where provider_sid is null and source_namespace like 'twilio:%'
        and source_event_id ~ '^(SM|MM)[0-9a-fA-F]{32}$'`)).rows[0]?.n;
      if (missing !== 0) throw new Error(`SID correction existing provider markers missing: ${table}`);
    }
  }
  return sha256(JSON.stringify({ ledger, functions, trigger }));
}

async function readOnly(client, source, applied) {
  await client.query("begin read only");
  try { await client.query("set local role postgres"); return await checkCatalog(client, source, applied); }
  finally { await client.query("rollback").catch(() => undefined); }
}

export async function runTransaction(client, source, commit, fingerprint) {
  await client.query("begin");
  let commitAttempted = false;
  try {
    await client.query("set local role postgres");
    await client.query("set local lock_timeout='5s'");
    await client.query("set local statement_timeout='30s'");
    if (!(await client.query("select pg_try_advisory_xact_lock(20260926220000::bigint) acquired")).rows[0]?.acquired) throw new Error("SID correction lock unavailable");
    if (await checkCatalog(client, source, false) !== fingerprint) throw new Error("Catalog changed since preflight");
    await client.query(source.sql);
    await client.query("insert into supabase_migrations.schema_migrations(version,name,statements) values($1,$2,$3)", [MIGRATION.version, MIGRATION.name, [source.sql]]);
    await checkCatalog(client, source, true);
    if (commit) { commitAttempted = true; await client.query("commit"); }
    else await client.query("rollback");
  } catch (error) {
    if (!commitAttempted) await client.query("rollback").catch(() => undefined);
    throw error;
  }
}

async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const source = reviewedSource();
  if (options.phase === "apply") {
    const dir = lstatSync(BACKUP_DIR);
    if (!dir.isDirectory() || (dir.mode & 0o777) !== 0o700) throw new Error("Private backup directory must be 0700");
  }
  const targetRef = SMS_RELEASE_TARGETS[options.target], config = credential(targetRef);
  let client = await connect(config);
  try {
    if (options.phase === "postflight") {
      const fingerprint = await readOnly(client, source, true);
      console.log(JSON.stringify({ target: options.target, targetRef, phase: options.phase, fingerprint, verified: true }));
      return;
    }
    const beforeFingerprint = await readOnly(client, source, false);
    if (options.phase === "preflight") {
      console.log(JSON.stringify({ target: options.target, targetRef, phase: options.phase, beforeFingerprint, version: MIGRATION.version, hash: MIGRATION.hash, ready: true }));
      return;
    }
    let backupHash;
    if (options.phase === "apply") {
      backup(config, options.backupFile);
      if ((statSync(options.backupFile).mode & 0o777) !== 0o600) throw new Error("Backup permissions differ from 0600");
      backupHash = await hashFile(options.backupFile);
    }
    await runTransaction(client, source, options.phase === "apply", beforeFingerprint);
    if (options.phase === "rehearsal") {
      await readOnly(client, source, false);
      console.log(JSON.stringify({ target: options.target, targetRef, phase: options.phase, rolledBack: true }));
      return;
    }
    await client.end();
    client = await connect(config);
    const fingerprint = await readOnly(client, source, true);
    console.log(JSON.stringify({ target: options.target, targetRef, phase: options.phase,
      beforeFingerprint, backupFile: options.backupFile, backupHash, fingerprint, outcome: "committed_and_verified" }));
  } finally { await client.end().catch(() => undefined); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`SID correction operation failed: ${error.message}. Inspect exact target read-only before retry if commit was attempted.`); process.exitCode = 1; });
}
