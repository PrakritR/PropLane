#!/usr/bin/env node
/** Exact-target release transport. No database access without an explicit target. */
import { resolve, dirname } from "node:path";
import { lstatSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { backup, connect, credential } from "./sms-durability-release-migrations.mjs";
import { SMS_RELEASE_TARGETS, sha256 } from "./sms-durability-release-manifest.mjs";
import { reviewedIdentityDepositMigrations, assertIdentityDepositLedger } from "./identity-deposit-release-manifest.mjs";

const TABLES = ["security_deposit_return_attempts", "security_deposit_unmatched_refunds", "resident_identity_subjects", "resident_identity_inquiries", "resident_identity_webhook_events", "resident_identity_manual_reviews", "resident_evidence_policies"];
const OWNED = TABLES.filter((name) => name !== "security_deposit_unmatched_refunds");
const NAMES = ["commit_security_deposit_disposition", "commit_security_deposit_disposition_unreserved", "reserve_security_deposit_return", "settle_security_deposit_return", "bind_security_deposit_refund", "reconcile_external_security_deposit_refund", "apply_resident_identity_event", "retry_expired_resident_identity", "prevent_resident_evidence_policy_update"];
const HELP = 'help: --target staging|production --confirm-ref <exact-ref> [--phase preflight|rehearsal|apply|postflight] [--baseline <sha256>] [--postflight-hash <sha256>] [--backup-file <private-path>] [--apply-authorized]';
export function parseOptions(argv) {
  const out = { phase: "preflight" }, seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--help") return { help: true };
    if (seen.has(flag)) throw new Error("Duplicate flag");
    seen.add(flag);
    if (flag === "--apply-authorized") { out.authorized = true; continue; }
    if (!["--target", "--confirm-ref", "--phase", "--baseline", "--postflight-hash", "--backup-file"].includes(flag) || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("Unknown flag or missing value");
    out[flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  if (!Object.hasOwn(SMS_RELEASE_TARGETS, out.target) || out.confirmRef !== SMS_RELEASE_TARGETS[out.target] || !["preflight", "rehearsal", "apply", "postflight"].includes(out.phase)) throw new Error("Target and exact confirmation reference required");
  if (["rehearsal", "apply"].includes(out.phase) && !/^[a-f0-9]{64}$/.test(out.baseline ?? "")) throw new Error("Reviewed baseline fingerprint required");
  if (out.phase === "apply" && (!out.authorized || !/^[a-f0-9]{64}$/.test(out.postflightHash ?? "") || !out.backupFile)) throw new Error("Apply needs authorization, rehearsal postflight hash and backup path");
  if (out.phase !== "apply" && (out.authorized || out.postflightHash || out.backupFile)) throw new Error("Apply flags require apply phase");
  if (!["rehearsal", "apply"].includes(out.phase) && out.baseline) throw new Error("Baseline only applies to rehearsal or apply");
  return out;
}
async function catalog(client, migrations, applied) {
  const ledger = (await client.query("select version,name,statements from supabase_migrations.schema_migrations where version=any($1::text[]) or name=any($2::text[]) order by version", [migrations.map(m=>m.version), migrations.map(m=>m.name)])).rows;
  assertIdentityDepositLedger(ledger, migrations, applied);
  const prerequisites = (await client.query("select to_regclass('public.security_deposit_ledger') is not null deposit, to_regclass('public.manager_property_records') is not null property, to_regprocedure('public.account_recovery_write_guard()') is not null guard, to_regprocedure('public.account_recovery_capture_delete()') is not null capture")).rows[0];
  if (Object.values(prerequisites).some(v=>v !== true)) throw new Error("Prerequisite missing");
  const tables = (await client.query(`select c.relname name,c.relrowsecurity rls,has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') anon,has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE') authwrite,has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE') service from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any($1::text[]) and c.relkind in ('r','p') order by c.relname`, [TABLES])).rows;
  const functions = (await client.query(`select p.proname name,pg_get_function_identity_arguments(p.oid) args,pg_get_functiondef(p.oid) definition,coalesce(p.proacl::text,'') acl from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any($1::text[]) order by 1,2`, [NAMES])).rows;
  if (!applied) {
    if (tables.length || functions.length !== 1 || functions[0].name !== "commit_security_deposit_disposition") throw new Error("Unexpected existing target schema");
  } else {
    if (tables.length !== TABLES.length || tables.some(t=>!t.rls || t.anon || t.authwrite || !t.service)) throw new Error("Table ACL or RLS mismatch");
    const guards = (await client.query(`select c.relname name,count(*)::int count from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any($1::text[]) and not t.tgisinternal and t.tgenabled='O' and t.tgnargs=0 and t.tgqual is null and t.tgconstraint=0 and t.tgattr::text='' and ((t.tgname='account_recovery_write_guard' and t.tgtype=31 and t.tgfoid=to_regprocedure('public.account_recovery_write_guard()')) or (t.tgname='account_recovery_capture_delete' and t.tgtype=9 and t.tgfoid=to_regprocedure('public.account_recovery_capture_delete()'))) group by c.relname order by c.relname`, [OWNED])).rows;
    if (guards.length !== OWNED.length || guards.some(g=>g.count !== 2)) throw new Error("Recovery triggers mismatch");
    if (NAMES.some(name=>!functions.some(f=>f.name===name))) throw new Error("Expected function missing");
  }
  return sha256(JSON.stringify({ prerequisites, tables, functions }));
}
async function readOnly(client, migrations, applied) {
  await client.query("begin read only");
  try { await client.query("set local role postgres"); return await catalog(client, migrations, applied); }
  finally { await client.query("rollback").catch(()=>undefined); }
}
async function transaction(client, migrations, options) {
  await client.query("begin"); let committing = false;
  try {
    await client.query("set local role postgres");
    await client.query("set local lock_timeout='5s'");
    await client.query("set local statement_timeout='60s'");
    if (!(await client.query("select pg_try_advisory_xact_lock(20261106120000::bigint) acquired")).rows[0]?.acquired) throw new Error("Migration lock unavailable");
    if (await catalog(client, migrations, false) !== options.baseline) throw new Error("Catalog differs from reviewed baseline");
    for (const m of migrations) { await client.query(m.sql); await client.query("insert into supabase_migrations.schema_migrations(version,name,statements) values($1,$2,$3)", [m.version,m.name,[m.sql]]); }
    const post = await catalog(client, migrations, true);
    if (options.phase === "apply" && post !== options.postflightHash) throw new Error("Postflight differs from reviewed rehearsal");
    if (options.phase === "apply") { committing = true; await client.query("commit"); } else await client.query("rollback");
    return post;
  } catch (error) { if (!committing) await client.query("rollback").catch(()=>undefined); throw error; }
}
async function main() {
  const options = parseOptions(process.argv.slice(2)); if (options.help) { console.log(HELP); return; }
  // Fail closed until catalog and rehearsal checks receive independent review.
  if (options.phase !== "preflight") throw new Error("Release phases are disabled pending independent catalog review");
  const migrations = reviewedIdentityDepositMigrations(), config = credential(SMS_RELEASE_TARGETS[options.target]);
  let client = await connect(config);
  try {
    if (options.phase === "preflight" || options.phase === "postflight") {
      const fingerprint = await readOnly(client, migrations, options.phase === "postflight");
      console.log(`target: ${options.target}\nphase: ${options.phase}\nfingerprint: ${fingerprint}`); return;
    }
    if (options.phase === "apply") {
      const file = resolve(options.backupFile), dir = lstatSync(dirname(file));
      if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o777) !== 0o700) throw new Error("Backup directory must be private");
      backup(config, file);
      if ((statSync(file).mode & 0o777) !== 0o600) throw new Error("Backup permissions mismatch");
    }
    const post = await transaction(client, migrations, options);
    if (options.phase === "rehearsal") {
      if (await readOnly(client, migrations, false) !== options.baseline) throw new Error("Rollback verification failed");
      console.log(`target: ${options.target}\nphase: rehearsal\nrolledBack: true\npostflightHash: ${post}`); return;
    }
    await client.end(); client = await connect(config);
    if (await readOnly(client, migrations, true) !== post) throw new Error("Committed postflight differs; inspect before retry");
    console.log(`target: ${options.target}\nphase: apply\noutcome: committed_and_verified\nfingerprint: ${post}`);
  } finally { await client.end().catch(()=>undefined); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(()=>{ console.log(`error: operation refused or failed; inspect target and backup before retry\n${HELP}`); process.exitCode=1; });
