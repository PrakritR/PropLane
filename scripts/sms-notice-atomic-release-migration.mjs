#!/usr/bin/env node
/** Bounded release operation for the manager SMS atomic notice function. */
import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { backup, connect, credential } from "./sms-durability-release-migrations.mjs";
import { SMS_RELEASE_TARGETS, sha256 } from "./sms-durability-release-manifest.mjs";

const VERSION = "20260926210000";
const NAME = "sms_notice_atomic_reopen";
const HASH = "6c9f3a06643ef8220d93da803eaebc1666c4d7054f259840859a753ddfda7d54";
const SIGNATURE = "append_manager_sms_inbox_notice(uuid,text,text,text,jsonb,jsonb,boolean,text[])";
const BACKUP_DIR = "/Users/akhilvemuri/.codex/release-backups/sms-20260926";

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
  if (!Object.hasOwn(SMS_RELEASE_TARGETS, out.target) || !["preflight", "rehearsal", "apply", "postflight"].includes(out.phase)) throw new Error("Exact target and phase required");
  if (out.phase === "rehearsal" && out.target !== "staging") throw new Error("Rehearsal is staging-only");
  if (out.phase === "apply") {
    if (!out.applyAuthorized || !out.backupFile) throw new Error("Apply requires explicit authorization flag and backup file");
    const file = resolve(out.backupFile);
    if (dirname(file) !== BACKUP_DIR || !basename(file).startsWith(`sms-notice-atomic-${out.target}-`) || !file.endsWith(".dump")) throw new Error("Backup path must be private and target-named");
    out.backupFile = file;
  } else if (out.applyAuthorized || out.backupFile) throw new Error("Apply flags invalid for this phase");
  return out;
}

export function reviewedMigration() {
  const sql = readFileSync(new URL(`../supabase/migrations/${VERSION}_${NAME}.sql`, import.meta.url), "utf8");
  if (sha256(sql) !== HASH) throw new Error("Atomic notice migration source changed");
  const body = sql.match(/\bas \$\$([\s\S]*?)\$\$/i)?.[1];
  if (!body) throw new Error("Atomic notice function body missing");
  return { version: VERSION, name: NAME, hash: HASH, sql, body };
}

export function assertCatalogShape(state, migration, applied) {
  if (applied) {
    if (state.ledger.length !== 1 || state.ledger[0].version !== migration.version || state.ledger[0].name !== migration.name ||
      state.ledger[0].statements?.length !== 1 || sha256(state.ledger[0].statements[0]) !== migration.hash) throw new Error("Atomic notice ledger differs");
    const f = state.functions;
    if (f.length !== 1 || f[0].signature !== SIGNATURE || f[0].body !== migration.body || f[0].returnType !== "jsonb" ||
      f[0].language !== "plpgsql" || f[0].volatility !== "v" || f[0].securityDefiner || f[0].searchPath !== "search_path=public, pg_temp" ||
      f[0].anonExecute || f[0].authExecute || !f[0].serviceExecute) throw new Error("Atomic notice function definition or ACL differs");
  } else if (state.ledger.length || state.functions.length) throw new Error("Atomic notice migration partially or fully present");
  if (!state.prerequisites.inbox || !state.prerequisites.controls) throw new Error("Atomic notice prerequisite missing");
}

export async function checkCatalog(client, migration, applied) {
  const ledger = (await client.query("select version,name,statements from supabase_migrations.schema_migrations where version=$1 or name=$2", [migration.version, migration.name])).rows;
  const functions = (await client.query(`select replace(replace(p.oid::regprocedure::text,'public.',''),', ',',') signature,p.prosrc body,
    p.prorettype::regtype::text "returnType",l.lanname language,p.provolatile volatility,p.prosecdef "securityDefiner",p.proconfig[1] "searchPath",
    has_function_privilege('anon',p.oid,'EXECUTE') "anonExecute",has_function_privilege('authenticated',p.oid,'EXECUTE') "authExecute",
    has_function_privilege('service_role',p.oid,'EXECUTE') "serviceExecute"
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang
    where n.nspname='public' and p.proname='append_manager_sms_inbox_notice'`)).rows;
  const prerequisites = (await client.query("select to_regclass('public.portal_inbox_thread_records') is not null inbox, to_regclass('public.manager_tour_followup_controls') is not null controls")).rows[0];
  const state = { ledger, functions, prerequisites };
  assertCatalogShape(state, migration, applied);
  return sha256(JSON.stringify(state));
}

async function readOnly(client, migration, applied) {
  await client.query("begin read only");
  try { await client.query("set local role postgres"); return await checkCatalog(client, migration, applied); }
  finally { await client.query("rollback").catch(() => undefined); }
}

export async function runTransaction(client, migration, commit, fingerprint) {
  await client.query("begin");
  let commitAttempted = false;
  try {
    await client.query("set local role postgres");
    await client.query("set local lock_timeout='5s'");
    await client.query("set local statement_timeout='30s'");
    if (!(await client.query("select pg_try_advisory_xact_lock(20260926210000::bigint) acquired")).rows[0]?.acquired) throw new Error("Atomic notice migration lock unavailable");
    if (await checkCatalog(client, migration, false) !== fingerprint) throw new Error("Catalog changed since preflight");
    await client.query(migration.sql);
    await client.query("insert into supabase_migrations.schema_migrations(version,name,statements) values($1,$2,$3)", [migration.version, migration.name, [migration.sql]]);
    await checkCatalog(client, migration, true);
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
  const args = parseOptions(process.argv.slice(2));
  const migration = reviewedMigration();
  if (args.phase === "apply") {
    const dir = lstatSync(BACKUP_DIR);
    if (!dir.isDirectory() || (dir.mode & 0o777) !== 0o700) throw new Error("Private backup parent must be 0700");
  }
  const targetRef = SMS_RELEASE_TARGETS[args.target], config = credential(targetRef);
  let client = await connect(config);
  try {
    if (args.phase === "postflight") {
      const fingerprint = await readOnly(client, migration, true);
      console.log(JSON.stringify({ target: args.target, targetRef, phase: args.phase, fingerprint, verified: true }));
      return;
    }
    const beforeFingerprint = await readOnly(client, migration, false);
    if (args.phase === "preflight") {
      console.log(JSON.stringify({ target: args.target, targetRef, phase: args.phase, beforeFingerprint, version: migration.version, hash: migration.hash, ready: true }));
      return;
    }
    let backupHash;
    if (args.phase === "apply") {
      backup(config, args.backupFile);
      if ((statSync(args.backupFile).mode & 0o777) !== 0o600) throw new Error("Backup permissions differ from 0600");
      backupHash = await hashFile(args.backupFile);
    }
    await runTransaction(client, migration, args.phase === "apply", beforeFingerprint);
    if (args.phase === "rehearsal") {
      await readOnly(client, migration, false);
      console.log(JSON.stringify({ target: args.target, targetRef, phase: args.phase, rolledBack: true }));
      return;
    }
    await client.end();
    client = await connect(config);
    const fingerprint = await readOnly(client, migration, true);
    console.log(JSON.stringify({ target: args.target, targetRef, phase: args.phase, beforeFingerprint, backupFile: args.backupFile, backupHash, fingerprint, outcome: "committed_and_verified" }));
  } finally { await client.end().catch(() => undefined); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`Atomic notice operation failed: ${error.message}. Inspect exact target read-only before retry if commit was attempted.`); process.exitCode = 1; });
}
