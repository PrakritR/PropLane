#!/usr/bin/env node
/** Exact-target release transport. No database access without an explicit target. */
import { resolve, dirname } from "node:path";
import { lstatSync, statSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { backup, connect, credential } from "./sms-durability-release-migrations.mjs";
import { SMS_RELEASE_TARGETS, sha256 } from "./sms-durability-release-manifest.mjs";
import { reviewedIdentityDepositMigrations, identityDepositLedgerState } from "./identity-deposit-release-manifest.mjs";

/** Objects the twelfth migration adds. Absent in `absent` and `prefix`, present in `complete`. */
const NEW_TABLES = ["household_charge_refund_attempts"];
const NEW_FUNCTIONS = ["reserve_household_charge_refund", "stamp_household_charge_refund_platform_key", "bind_household_charge_refund"];
const PREFIX_TABLES = ["security_deposit_return_attempts", "security_deposit_unmatched_refunds", "resident_identity_subjects", "resident_identity_inquiries", "resident_identity_webhook_events", "resident_identity_manual_reviews", "resident_evidence_policies"];
const TABLES = [...PREFIX_TABLES, ...NEW_TABLES];
const OWNED = TABLES.filter((name) => name !== "security_deposit_unmatched_refunds");
const PREFIX_NAMES = ["commit_security_deposit_disposition", "commit_security_deposit_disposition_unreserved", "reserve_security_deposit_return", "settle_security_deposit_return", "bind_security_deposit_refund", "reconcile_external_security_deposit_refund", "apply_resident_identity_event", "retry_expired_resident_identity", "prevent_resident_evidence_policy_update"];
const NAMES = [...PREFIX_NAMES, ...NEW_FUNCTIONS];
/** `false`/`true` are the historical before/after; the third state is staging and dev. */
function expectedState(expected) {
  if (expected === false || expected === "absent") return "absent";
  if (expected === true || expected === "complete") return "complete";
  if (expected === "prefix") return "prefix";
  throw new Error("Unexpected existing target schema");
}
const HELP = 'help: --target staging|production --confirm-ref <exact-ref> [--phase preflight|rehearsal|apply|postflight] [--baseline <sha256>] [--postflight-hash <sha256>] [--backup-file <private-path>] [--catalog-file <private-path>] [--apply-authorized]';
export function parseOptions(argv) {
  const out = { phase: "preflight" }, seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--help") return { help: true };
    if (seen.has(flag)) throw new Error("Duplicate flag");
    seen.add(flag);
    if (flag === "--apply-authorized") { out.authorized = true; continue; }
    if (!["--target", "--confirm-ref", "--phase", "--baseline", "--postflight-hash", "--backup-file", "--catalog-file"].includes(flag) || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("Unknown flag or missing value");
    out[flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  if (!Object.hasOwn(SMS_RELEASE_TARGETS, out.target) || out.confirmRef !== SMS_RELEASE_TARGETS[out.target] || !["preflight", "rehearsal", "apply", "postflight"].includes(out.phase)) throw new Error("Target and exact confirmation reference required");
  if (["rehearsal", "apply"].includes(out.phase) && !/^[a-f0-9]{64}$/.test(out.baseline ?? "")) throw new Error("Reviewed baseline fingerprint required");
  if (out.phase === "apply" && (!out.authorized || !/^[a-f0-9]{64}$/.test(out.postflightHash ?? "") || !out.backupFile)) throw new Error("Apply needs authorization, rehearsal postflight hash and backup path");
  if (out.phase !== "apply" && (out.authorized || out.postflightHash || out.backupFile)) throw new Error("Apply flags require apply phase");
  if (!["rehearsal", "apply"].includes(out.phase) && out.baseline) throw new Error("Baseline only applies to rehearsal or apply");
  if (["preflight", "rehearsal"].includes(out.phase) && !out.catalogFile) throw new Error("Preflight and rehearsal require a private catalog artifact path");
  if (!["preflight", "rehearsal"].includes(out.phase) && out.catalogFile) throw new Error("Catalog artifact only applies to preflight or rehearsal");
  return out;
}
export async function catalog(client, migrations, applied) {
  const expected = expectedState(applied);
  const ledger = (await client.query("select version,name,statements from supabase_migrations.schema_migrations where version=any($1::text[]) or name=any($2::text[]) order by version", [migrations.map(m=>m.version), migrations.map(m=>m.name)])).rows;
  const state = identityDepositLedgerState(ledger, migrations);
  if (state.kind !== expected) throw new Error(`Migration ledger differs: ${migrations[state.applied]?.version ?? migrations[0].version}`);
  const prerequisites = (await client.query("select to_regclass('public.security_deposit_ledger') is not null deposit, to_regclass('public.manager_property_records') is not null property, to_regprocedure('public.account_recovery_write_guard()') is not null guard, to_regprocedure('public.account_recovery_capture_delete()') is not null capture")).rows[0];
  if (Object.values(prerequisites).some(v=>v !== true)) throw new Error("Prerequisite missing");
  const names = [...TABLES, "security_deposit_ledger"];
  const tables = (await client.query(`select c.relname name,c.relrowsecurity rls,
    has_table_privilege('anon',c.oid,'SELECT') anon_select, has_table_privilege('anon',c.oid,'INSERT') anon_insert,
    has_table_privilege('anon',c.oid,'UPDATE') anon_update, has_table_privilege('anon',c.oid,'DELETE') anon_delete, has_table_privilege('anon',c.oid,'TRUNCATE') anon_truncate, has_table_privilege('anon',c.oid,'REFERENCES') anon_references, has_table_privilege('anon',c.oid,'TRIGGER') anon_trigger,
    has_table_privilege('authenticated',c.oid,'SELECT') auth_select, has_table_privilege('authenticated',c.oid,'INSERT') auth_insert,
    has_table_privilege('authenticated',c.oid,'UPDATE') auth_update, has_table_privilege('authenticated',c.oid,'DELETE') auth_delete, has_table_privilege('authenticated',c.oid,'TRUNCATE') auth_truncate, has_table_privilege('authenticated',c.oid,'REFERENCES') auth_references, has_table_privilege('authenticated',c.oid,'TRIGGER') auth_trigger,
    has_table_privilege('service_role',c.oid,'SELECT') service_select, has_table_privilege('service_role',c.oid,'INSERT') service_insert,
    has_table_privilege('service_role',c.oid,'UPDATE') service_update, has_table_privilege('service_role',c.oid,'DELETE') service_delete, has_table_privilege('service_role',c.oid,'TRUNCATE') service_truncate, has_table_privilege('service_role',c.oid,'REFERENCES') service_references, has_table_privilege('service_role',c.oid,'TRIGGER') service_trigger,
    coalesce(c.relacl::text,'') acl from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname=any($1::text[]) and c.relkind in ('r','p') order by c.relname`, [names])).rows;
  const functions = (await client.query(`select p.proname name,oidvectortypes(p.proargtypes) arguments,pg_get_functiondef(p.oid) definition,
    coalesce(p.proacl::text,'') acl,p.prosecdef security_definer,coalesce(p.proconfig::text,'') config,
    has_function_privilege('anon',p.oid,'EXECUTE') anon_execute,has_function_privilege('authenticated',p.oid,'EXECUTE') auth_execute,
    has_function_privilege('service_role',p.oid,'EXECUTE') service_execute
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any($1::text[]) order by 1,2`, [[...NAMES,"account_recovery_write_guard","account_recovery_capture_delete"]])).rows;
  const columns = (await client.query(`select c.relname table_name,a.attname name,format_type(a.atttypid,a.atttypmod) type,a.attnotnull required,pg_get_expr(d.adbin,d.adrelid) default_expr from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum where n.nspname='public' and c.relname=any($1::text[]) order by c.relname,a.attnum`, [names])).rows;
  const constraints = (await client.query(`select c.relname table_name,k.conname name,pg_get_constraintdef(k.oid) definition from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any($1::text[]) order by 1,2`, [names])).rows;
  const indexes = (await client.query(`select tablename table_name,indexname name,indexdef definition from pg_indexes where schemaname='public' and tablename=any($1::text[]) order by 1,2`, [names])).rows;
  const policies = (await client.query(`select tablename table_name,policyname name,permissive,roles::text,cmd,qual,with_check from pg_policies where schemaname='public' and tablename=any($1::text[]) order by 1,2`, [names])).rows;
  const triggers = (await client.query(`select c.relname table_name,t.tgname name,pg_get_triggerdef(t.oid) definition,t.tgenabled enabled,t.tgtype type,t.tgnargs nargs,t.tgattr::text attributes,t.tgqual is null unqualified,t.tgconstraint=0 unconstrained,p.proname function_name,n2.nspname function_schema from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace join pg_proc p on p.oid=t.tgfoid join pg_namespace n2 on n2.oid=p.pronamespace where n.nspname='public' and c.relname=any($1::text[]) and not t.tgisinternal order by 1,2`, [names])).rows;
  const catalogState = { prerequisites, tables, functions, columns, constraints, indexes, policies, triggers };
  assertCatalog(catalogState, expected);
  return { state: catalogState, ledger: state, fingerprint: sha256(JSON.stringify(catalogState)) };
}
const SIGNATURES = [
  ["commit_security_deposit_disposition", "uuid, uuid, bigint, bigint, bigint, text, date, jsonb, text, jsonb"],
  ["commit_security_deposit_disposition_unreserved", "uuid, uuid, bigint, bigint, bigint, text, date, jsonb, text, jsonb"],
  ["reserve_security_deposit_return", "uuid, uuid, text, text, bigint, bigint, bigint, jsonb"],
  ["settle_security_deposit_return", "uuid"], ["bind_security_deposit_refund", "uuid, text, text, bigint, text"],
  ["bind_security_deposit_refund", "uuid, text, text, bigint, text, uuid"],
  ["reconcile_external_security_deposit_refund", "text, text"],
  ["apply_resident_identity_event", "text, text, uuid, text, timestamp with time zone, text"],
  ["retry_expired_resident_identity", "uuid"], ["prevent_resident_evidence_policy_update", ""],
];
/** Added by the twelfth migration only. */
const NEW_SIGNATURES = [
  ["reserve_household_charge_refund", "uuid, text, text, text, text, text, bigint, jsonb"],
  ["stamp_household_charge_refund_platform_key", "uuid, text"],
  ["bind_household_charge_refund", "uuid, text, text, bigint, text, text, uuid"],
];
export function assertCatalog(state, applied) {
  const expected = expectedState(applied);
  if (Object.values(state.prerequisites).some(v => v !== true)) throw new Error("Prerequisite missing");
  const targetTables = state.tables.filter(t=>TABLES.includes(t.name));
  const targets = state.functions.filter(f=>NAMES.includes(f.name));
  if (expected === "absent") {
    if (targetTables.length || targets.length !== 1 || targets[0].name !== "commit_security_deposit_disposition" || targets[0].arguments !== SIGNATURES[0][1]) throw new Error("Unexpected existing target schema");
    return;
  }
  // In `prefix` the twelfth migration has NOT run, so its objects must be absent — presence of
  // a table is never evidence a migration was applied, and its absence here is the check that
  // the twelfth is genuinely still pending.
  const expectedTables = expected === "prefix" ? PREFIX_TABLES : TABLES;
  const expectedSignatures = expected === "prefix" ? SIGNATURES : [...SIGNATURES, ...NEW_SIGNATURES];
  if (expected === "prefix" && (state.tables.some(t=>NEW_TABLES.includes(t.name)) || state.functions.some(f=>NEW_FUNCTIONS.includes(f.name)))) {
    throw new Error("Unexpected existing target schema");
  }
  if (targetTables.length !== expectedTables.length || targetTables.some(t => !t.rls || ["select","insert","update","delete","truncate","references","trigger"].some(p=>t[`anon_${p}`] || !t[`service_${p}`]) || ["insert","update","delete","truncate","references","trigger"].some(p=>t[`auth_${p}`]) || t.auth_select !== t.name.startsWith("resident_"))) throw new Error("Table privilege or RLS mismatch");
  if (targets.length !== expectedSignatures.length) throw new Error("Function signature count differs");
  for (const [name,args] of expectedSignatures) {
    const f=targets.find(f=>f.name===name && f.arguments===args);
    if (!f) throw new Error("Expected function signature missing");
    if (name !== "prevent_resident_evidence_policy_update" && (!f.security_definer || f.anon_execute || f.auth_execute || !f.config.includes("search_path=public") || (name !== "commit_security_deposit_disposition_unreserved" && !(name === "bind_security_deposit_refund" && args.endsWith("bigint, text")) && !f.service_execute))) throw new Error("Function security mismatch");
    if ((name === "commit_security_deposit_disposition_unreserved" || (name === "bind_security_deposit_refund" && args === "uuid, text, text, bigint, text")) && f.service_execute) throw new Error("Retired function remains callable");
  }
  const policyNames = [
    ["resident_identity_subjects", "resident_identity_subject_owner_read"],
    ["resident_identity_inquiries", "resident_identity_inquiry_owner_read"],
    ["resident_identity_webhook_events", "resident_identity_event_owner_read"],
    ["resident_identity_manual_reviews", "resident_identity_review_owner_read"],
    ["resident_evidence_policies", "resident_evidence_policy_owner_read"],
  ];
  const targetPolicies=state.policies.filter(p=>TABLES.includes(p.table_name));
  const evidenceQual = "(EXISTS ( SELECT 1 FROM manager_property_records p WHERE ((p.id = resident_evidence_policies.property_id) AND (p.manager_user_id = auth.uid()))))";
  const normalizeQual = value => (value ?? "").replace(/\s+/g, "").toLowerCase();
  if (targetPolicies.length !== 5 || policyNames.some(([table,name])=>!targetPolicies.some(p=>p.table_name===table && p.name===name && p.cmd==="SELECT" && p.roles==="{authenticated}" && p.permissive==="PERMISSIVE" && p.with_check===null && normalizeQual(p.qual) === normalizeQual(table === "resident_evidence_policies" ? evidenceQual : "(resident_user_id = auth.uid())")))) throw new Error("Owner read policy mismatch");
  const ownedNow = expected === "prefix" ? OWNED.filter((name) => !NEW_TABLES.includes(name)) : OWNED;
  for (const table of ownedNow) for (const [name,type] of [["account_recovery_write_guard",31],["account_recovery_capture_delete",9]]) {
    const t=state.triggers.find(t=>t.table_name===table && t.name===name);
    if (!t || t.type!==type || t.enabled!=="O" || t.nargs!==0 || t.attributes!=="" || !t.unqualified || !t.unconstrained || t.function_name!==name || t.function_schema!=="public") throw new Error("Recovery trigger mismatch");
  }
  const immutable=state.triggers.find(t=>t.table_name==="resident_evidence_policies" && t.name==="resident_evidence_policy_immutable");
  if (!immutable || immutable.enabled!=="O" || immutable.type!==19 || immutable.function_name!=="prevent_resident_evidence_policy_update" || immutable.function_schema!=="public" || immutable.nargs!==0 || !immutable.unqualified || !immutable.unconstrained || immutable.attributes!=="") throw new Error("Evidence policy immutable trigger mismatch");
}

export async function readOnly(client, migrations, applied) {
  await client.query("begin read only");
  try { await client.query("set local role postgres"); return await catalog(client, migrations, applied); }
  finally { await client.query("rollback").catch(()=>undefined); }
}
/**
 * Apply only the PENDING migrations, under the lock, after re-reading the baseline and the
 * applied prefix inside the transaction. `options.before` is the reviewed before-state
 * (`absent` for production, `prefix` for staging and dev) and `options.pending` is the exact
 * suffix that is allowed to run — the committed eleven are never re-executed.
 */
export async function transaction(client, migrations, options, inspect = catalog) {
  await client.query("begin"); let committing = false;
  try {
    await client.query("set local role postgres");
    await client.query("set local lock_timeout='5s'");
    await client.query("set local statement_timeout='60s'");
    if (!(await client.query("select pg_try_advisory_xact_lock(20261106120000::bigint) acquired")).rows[0]?.acquired) throw new Error("Migration lock unavailable");
    const before = options.before ?? "absent";
    const pending = options.pending ?? migrations;
    if (!pending.length) throw new Error("Nothing pending for this target");
    if ((await inspect(client, migrations, before)).fingerprint !== options.baseline) throw new Error("Catalog differs from reviewed baseline");
    for (const m of pending) { await client.query(m.sql); await client.query("insert into supabase_migrations.schema_migrations(version,name,statements) values($1,$2,$3)", [m.version,m.name,[m.sql]]); }
    const post = await inspect(client, migrations, "complete");
    if (options.phase === "apply" && post.fingerprint !== options.postflightHash) throw new Error("Postflight differs from reviewed rehearsal");
    if (options.phase === "apply") { committing = true; await client.query("commit"); } else await client.query("rollback");
    return post;
  } catch (error) { if (!committing) await client.query("rollback").catch(()=>undefined); throw error; }
}
/** Reported when the COMMIT landed but its own verification could not be reached. */
export const COMMITTED_UNVERIFIED = "Committed but unverified; refresh the credential and inspect before any retry";

/**
 * Verify the committed schema over a connection of its own.
 *
 * The credential `main` opened with is short-lived, and the apply phase spends that life on
 * the backup and the migration transaction, so by the time the commit lands the CLI login can
 * already have expired. Re-resolving the SAME confirmed target and minting a fresh credential
 * keeps the TLS root pin and the identity/role check (`credential` + `connect` own both) while
 * giving the verification a live session.
 *
 * EVERY transport failure on this side of the commit — minting, connecting, the read-only
 * catalog session itself, or closing it — is reported as committed-but-unverified, never as a
 * failed apply. The session can expire mid-inspect just as easily as before it, and the whole
 * point is that the operator is never told "operation failed" about a COMMIT that landed. The
 * two outcomes that are NOT transport keep their own words: a fingerprint difference and
 * `assertCatalog`'s schema-divergence refusals are real findings about the committed schema.
 * The transaction is never retried either way.
 */
export async function verifyCommittedPostflight(target, migrations, fingerprint, deps = {}) {
  const mint = deps.credential ?? credential;
  const open = deps.connect ?? connect;
  const inspect = deps.readOnly ?? readOnly;
  let client;
  try { client = await open(mint(SMS_RELEASE_TARGETS[target])); }
  catch { throw new Error(COMMITTED_UNVERIFIED); }
  try {
    let post;
    try { post = await inspect(client, migrations, "complete"); }
    catch (error) { throw committedVerificationError(error); }
    if (post.fingerprint !== fingerprint) throw new Error("Committed postflight differs; inspect before retry");
    return post.fingerprint;
  } finally {
    try { await client.end?.(); }
    catch { /* the catalog answer is already in hand; a failed close proves nothing about it */ }
  }
}

/**
 * A catalog refusal is a finding about the committed schema and keeps its own message; anything
 * else that came out of the verification session is transport, and the operator must be told the
 * COMMIT landed and was not verified rather than that the operation failed.
 */
function committedVerificationError(error) {
  const message = error instanceof Error ? error.message : "";
  return isSafeError(message) ? error : new Error(COMMITTED_UNVERIFIED);
}

/** A backup can outlive the bootstrap credential; open a fresh exact-target session. */
export async function refreshAfterBackup(target, oldClient, deps = {}) {
  await oldClient.end().catch(() => undefined);
  const config = (deps.credential ?? credential)(SMS_RELEASE_TARGETS[target]);
  return (deps.connect ?? connect)(config);
}

/** The reviewed before-state of a target, read from its own ledger. Refuses anything else. */
export async function readLedgerState(client, migrations) {
  const rows = (await client.query("select version,name,statements from supabase_migrations.schema_migrations where version=any($1::text[]) or name=any($2::text[]) order by version", [migrations.map(m=>m.version), migrations.map(m=>m.name)])).rows;
  return identityDepositLedgerState(rows, migrations);
}

/** The CLI login needs the explicit local postgres role to read the migration ledger. */
export async function readLedgerStateReadOnly(client, migrations) {
  await client.query("begin read only");
  try {
    await client.query("set local role postgres");
    return await readLedgerState(client, migrations);
  } finally {
    await client.query("rollback").catch(() => undefined);
  }
}

export function assertPrivateDirectory(path) {
  const dir = lstatSync(dirname(resolve(path)));
  if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o777) !== 0o700) throw new Error("Artifact directory must be private");
}
async function main() {
  const options = parseOptions(process.argv.slice(2)); if (options.help) { console.log(HELP); return; }
  const migrations = reviewedIdentityDepositMigrations(), config = credential(SMS_RELEASE_TARGETS[options.target]);
  let client = await connect(config);
  try {
    // The target's own ledger decides which reviewed state it is in, and therefore which
    // migrations may run at all. Nothing is inferred from the presence of a table.
    const ledger = await readLedgerStateReadOnly(client, migrations);
    if (options.phase === "preflight" || options.phase === "postflight") {
      const expected = options.phase === "postflight" ? "complete" : ledger.kind;
      const result = await readOnly(client, migrations, expected);
      const fingerprint = result.fingerprint;
      if (options.phase === "preflight") {
        const file = resolve(options.catalogFile);
        assertPrivateDirectory(file);
        writeFileSync(file, JSON.stringify({ target: options.target, ref: options.confirmRef, state: ledger.kind,
          applied: ledger.applied, pending: ledger.pending.map((m)=>m.version), fingerprint, catalog: result.state }, null, 2), { flag: "wx", mode: 0o600 });
      }
      console.log(`target: ${options.target}\nphase: ${options.phase}\nstate: ${ledger.kind}\napplied: ${ledger.applied}\npending: ${ledger.pending.map((m)=>m.version).join(",") || "none"}\nfingerprint: ${fingerprint}`); return;
    }
    if (ledger.kind === "complete") throw new Error("Target is already complete; postflight only");
    if (options.phase === "apply") {
      const file = resolve(options.backupFile);
      assertPrivateDirectory(file);
      backup(config, file);
      if ((statSync(file).mode & 0o777) !== 0o600) throw new Error("Backup permissions mismatch");
      client = await refreshAfterBackup(options.target, client);
    }
    const post = await transaction(client, migrations, { ...options, before: ledger.kind, pending: ledger.pending });
    if (options.phase === "rehearsal") {
      if ((await readOnly(client, migrations, ledger.kind)).fingerprint !== options.baseline) throw new Error("Rollback verification failed");
      const file = resolve(options.catalogFile); assertPrivateDirectory(file);
      writeFileSync(file, JSON.stringify({ target: options.target, ref: options.confirmRef, state: ledger.kind,
        applied: ledger.applied, pending: ledger.pending.map((m)=>m.version), baseline: options.baseline,
        fingerprint: post.fingerprint, catalog: post.state }, null, 2), { flag: "wx", mode: 0o600 });
      console.log(`target: ${options.target}\nphase: rehearsal\nstate: ${ledger.kind}\npending: ${ledger.pending.map((m)=>m.version).join(",")}\nrolledBack: true\npostflightHash: ${post.fingerprint}`); return;
    }
    const committed = client; client = undefined;
    await committed.end().catch(()=>undefined);
    const verified = await verifyCommittedPostflight(options.target, migrations, post.fingerprint);
    console.log(`target: ${options.target}\nphase: apply\noutcome: committed_and_verified\nfingerprint: ${verified}`);
  } finally { await client?.end().catch(()=>undefined); }
}
const SAFE_ERRORS = new Set([
  "Duplicate flag", "Unknown flag or missing value", "Target and exact confirmation reference required",
  "Reviewed baseline fingerprint required", "Apply needs authorization, rehearsal postflight hash and backup path",
  "Apply flags require apply phase", "Baseline only applies to rehearsal or apply",
  "Preflight and rehearsal require a private catalog artifact path", "Catalog artifact only applies to preflight or rehearsal",
  "Release phases are disabled pending independent catalog review", "Artifact directory must be private",
  "Prerequisite missing", "Unexpected existing target schema", "Table privilege or RLS mismatch",
  "Function signature count differs", "Expected function signature missing", "Function security mismatch",
  "Retired function remains callable", "Owner read policy mismatch", "Recovery trigger mismatch",
  "Evidence policy immutable trigger mismatch", "Migration lock unavailable", "Catalog differs from reviewed baseline",
  "Postflight differs from reviewed rehearsal", "Backup permissions mismatch", "Rollback verification failed",
  "Committed postflight differs; inspect before retry", "Credential bootstrap failed", "Credential shape invalid",
  "Credential target mismatch", "Database TLS root changed", "Database identity/role mismatch", "Database backup failed",
  "Database backup archive invalid", COMMITTED_UNVERIFIED,
  "Nothing pending for this target", "Target is already complete; postflight only",
]);
export function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message : "";
  if (isSafeError(message)) return message;
  return "Operation failed; inspect the target and backup before retry";
}
function isSafeError(message) {
  return SAFE_ERRORS.has(message) || /^(?:Migration source changed|Unexpected migration ledger entry|Migration ledger differs): [0-9]{14}$/.test(message);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error)=>{ console.log(`error: ${safeErrorMessage(error)}\n${HELP}`); process.exitCode=1; });
