#!/usr/bin/env node
/**
 * Fixed, one-shot transport for the reviewed communication-credit bundle.
 * It deliberately accepts neither SQL nor connection/target overrides.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLE_NAME, BUNDLE_VERSION, buildAtomicBundle, preparationReport, reviewedMigrationManifest } from "./prepare-20260911-comms-billing-migrations.mjs";

const BUNDLE_SHA256 = "c8013155b6cb51792950177cd47b348d51d7ce24df7869a5892ec74bb29541ff";
const CA_SHA256 = "700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7";
const WAIVER = "2026-09-11-production-comms-billing";
const CLI = "supabase@2.117.0";
const TARGETS = Object.freeze({ staging: "xwszcafaontidfgznlxd", production: "qahnczmilgptcedaqype" });
const CLI_ENV_KEYS = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "SUPABASE_ACCESS_TOKEN"];
const REQUIRED = ["public.profiles", "public.manager_comms_billing_accounts", "public.manager_comms_usage_events", "public.manager_automation_settings", "public.sms_outbox", "supabase_migrations.schema_migrations"];
const TABLES = ["comms_credit_policy", "manager_comms_credit_purchases", "manager_comms_credit_adjustments"];
const COLUMNS = [
  ["manager_comms_billing_accounts", "credit_period_start"], ["manager_comms_billing_accounts", "included_allowance_cents"],
  ["manager_comms_billing_accounts", "included_remaining_cents"], ["manager_comms_billing_accounts", "purchased_credit_cents"],
  ["manager_comms_billing_accounts", "credit_cutover_at"], ["manager_comms_billing_accounts", "stripe_customer_id"],
  ["manager_comms_usage_events", "credit_state"], ["manager_comms_usage_events", "included_debit_cents"],
  ["manager_comms_usage_events", "purchased_debit_cents"], ["manager_comms_usage_events", "platform_absorbed_cents"],
  ["manager_comms_usage_events", "credit_period_start"], ["sms_outbox", "campaign_budget_spent_on"],
];
const COLUMN_SHAPES = Object.freeze(Object.fromEntries(COLUMNS.map(([table, column]) => {
  const integer = ["included_allowance_cents", "included_remaining_cents", "purchased_credit_cents", "included_debit_cents", "purchased_debit_cents", "platform_absorbed_cents"].includes(column);
  const text = column === "stripe_customer_id" || column === "credit_state";
  return [`${table}.${column}`, {
    table_name: table,
    column_name: column,
    udt_name: integer ? "int4" : text ? "text" : column === "campaign_budget_spent_on" ? "date" : "timestamptz",
    is_nullable: integer || column === "credit_state" ? "NO" : "YES",
    column_default: integer ? "0" : column === "credit_state" ? "'legacy'::text" : null,
  }];
})));
const FUNCTIONS = [
  "comms_wallet_snapshot(uuid,integer,integer,boolean)", "comms_wallet_snapshots(jsonb)",
  "reserve_comms_credit(uuid,integer,integer,text,text,numeric,integer,jsonb,boolean)", "finish_comms_credit(uuid,text,boolean)",
  "fulfill_comms_credit_purchase(uuid,uuid,text,text,integer,text,text)", "reverse_comms_credit_purchase(text,integer,text,text)",
  "settle_comms_credit_quantity(uuid,text,numeric)", "save_manager_payment_preferences(uuid,jsonb)",
  "set_staff_payment_fee_override(uuid,text)", "claim_comms_budget_alert(uuid)", "spend_sms_outbox_segment_budget(uuid,text)",
];

class Failure extends Error {
  constructor(stage) { super(`Communication billing migration ${stage} failed. No credentials, SQL, or database output is displayed.`); this.code = `COMMS_BILLING_${stage.toUpperCase().replaceAll(/[^A-Z0-9]+/g, "_")}`; }
}
const fail = (stage) => new Failure(stage);
function sanitized(error, stage = "orchestration") { throw error instanceof Failure ? error : fail(stage); }
const hash = (value) => createHash("sha256").update(value).digest("hex");
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const ordered = (rows) => [...rows].sort((a, b) => `${a.version}\0${a.name}`.localeCompare(`${b.version}\0${b.name}`));

/** Closed CLI surface. Manifest-only remains the safe default. */
export function parseArgs(args) {
  if (args.length === 0) return { operation: "manifest" };
  const productionApply = args.length === 5 && args[0] === "--apply-production" && args[1] === "--bundle-sha256" && args[2] === BUNDLE_SHA256 && args[3] === "--waiver" && args[4] === WAIVER;
  if (productionApply) return { operation: "apply", target: "production", productionWaiver: true };
  if (args.length !== 1 && args.length !== 3) throw new Error("Unsupported communication billing operation.");
  const operation = args[0];
  const matches = /^(--preflight|--verify|--apply)-(staging|production)$/.exec(operation);
  if (!matches) throw new Error("Unsupported communication billing operation.");
  const [, verb, target] = matches;
  if (verb !== "--apply") {
    if (args.length !== 1) throw new Error("Read-only communication billing operations accept no acknowledgements.");
    return { operation: verb.slice(2), target };
  }
  if (target === "production") throw new Error("Production apply requires the exact approved waiver acknowledgement.");
  if (args.length !== 3 || args[1] !== "--bundle-sha256" || args[2] !== BUNDLE_SHA256) {
    throw new Error("Apply requires the exact reviewed bundle acknowledgement.");
  }
  return { operation: "apply", target };
}

function assertWaiver(target) {
  if (target !== "production") return;
  const args = process.argv.slice(2);
  if (!args.includes("--waiver") || args.length !== 5 || args[3] !== "--waiver" || args[4] !== WAIVER) throw fail("production waiver acknowledgement");
  let waiver;
  try { waiver = readFileSync(new URL(`../docs/waivers/${WAIVER}.md`, import.meta.url), "utf8"); } catch { throw fail("production waiver validation"); }
  const current = hash(readFileSync(fileURLToPath(import.meta.url)));
  if (!/^Status:\s*\*\*APPROVED\b(?![^\n]*\bCONSUMED\b)/m.test(waiver) ||
      !new RegExp(`(?:Runner|Entrypoint) SHA-256:\\s*\\\`${current}\\\``).test(waiver)) throw fail("production waiver validation");
}

function exactBundle() {
  const sources = reviewedMigrationManifest();
  const bundle = buildAtomicBundle(sources);
  if (Buffer.byteLength(bundle) !== 67040 || hash(bundle) !== BUNDLE_SHA256) throw fail("bundle digest validation");
  const begin = "begin;\n"; const commit = "commit;\n";
  if (!bundle.startsWith(begin) || !bundle.endsWith(commit) || bundle.indexOf(begin, begin.length) !== -1 || bundle.lastIndexOf(commit) !== bundle.length - commit.length) throw fail("bundle framing validation");
  return { sources, bundle, interior: bundle.slice(begin.length, -commit.length) };
}

function cliInvocation(target, environment = process.env, makeTemp = () => mkdtempSync(join(tmpdir(), "proplane-comms-cli-"))) {
  const cwd = makeTemp();
  try {
    chmodSync(cwd, 0o700); mkdirSync(join(cwd, "supabase"), { mode: 0o700 });
    writeFileSync(join(cwd, "supabase", "config.toml"), 'project_id = "comms-billing-login"\n', { mode: 0o600 });
    const env = {};
    for (const key of CLI_ENV_KEYS) if (typeof environment[key] === "string" && environment[key]) env[key] = environment[key];
    if (!env.PATH || !env.HOME || Object.keys(env).some((key) => !CLI_ENV_KEYS.includes(key))) throw fail("credential environment validation");
    return { cwd, env, file: "npx", args: ["-y", CLI, "db", "dump", "--project-ref", TARGETS[target], "--data-only", "--schema", "public", "--dry-run", "--yes"] };
  } catch (error) { try { rmSync(cwd, { recursive: true, force: true }); } catch {} sanitized(error, "credential workspace validation"); }
}

function verifyInvocation(invocation, target) {
  const expected = ["-y", CLI, "db", "dump", "--project-ref", TARGETS[target], "--data-only", "--schema", "public", "--dry-run", "--yes"];
  if (!invocation || invocation.file !== "npx" || invocation.args.join("\0") !== expected.join("\0") ||
      (statSync(invocation.cwd).mode & 0o777) !== 0o700 || readdirSync(invocation.cwd).join("\0") !== "supabase" ||
      (statSync(join(invocation.cwd, "supabase")).mode & 0o777) !== 0o700 ||
      readFileSync(join(invocation.cwd, "supabase", "config.toml"), "utf8") !== 'project_id = "comms-billing-login"\n' ||
      (statSync(join(invocation.cwd, "supabase", "config.toml")).mode & 0o777) !== 0o600 ||
      !invocation.env.PATH || !invocation.env.HOME || Object.keys(invocation.env).some((key) => !CLI_ENV_KEYS.includes(key))) throw fail("credential invocation validation");
}

function acquireCredentials(target, { spawn = spawnSync, environment = process.env } = {}) {
  const invocation = cliInvocation(target, environment);
  try {
    verifyInvocation(invocation, target);
    const result = spawn(invocation.file, invocation.args, { cwd: invocation.cwd, env: invocation.env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 90_000 });
    if (result.status !== 0 || result.signal || result.error?.code === "ETIMEDOUT") throw fail("credential acquisition");
    return connectionFromCli(String(result.stdout ?? ""), target);
  } catch (error) { sanitized(error, "credential acquisition"); }
  finally { try { rmSync(invocation.cwd, { recursive: true, force: true }); } catch {} }
}

export function connectionFromCli(output, target) {
  const fields = {};
  for (const key of ["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE"]) {
    const found = [...output.matchAll(new RegExp(`(?:^|\\n)export ${key}="([^"\\r\\n]+)"(?=\\r?$|\\n)`, "g"))];
    if (found.length !== 1) throw fail("credential binding validation");
    fields[key] = found[0][1];
  }
  const project = TARGETS[target];
  const direct = fields.PGHOST === `db.${project}.supabase.co` && fields.PGUSER === "cli_login_postgres";
  const pooler = /^(?:[a-z0-9-]+\.){1,2}pooler\.supabase\.com$/.test(fields.PGHOST) && fields.PGUSER === `cli_login_postgres.${project}`;
  if ((!direct && !pooler) || fields.PGPORT !== "5432" || fields.PGDATABASE !== "postgres") throw fail("credential binding validation");
  let ca; try { ca = readFileSync(new URL("./lib/supabase-root-2021.crt", import.meta.url), "utf8"); } catch { throw fail("TLS root validation"); }
  if (hash(ca) !== CA_SHA256) throw fail("TLS root validation");
  return { host: fields.PGHOST, port: 5432, user: fields.PGUSER, password: fields.PGPASSWORD, database: "postgres", ssl: { ca, servername: fields.PGHOST, rejectUnauthorized: true }, connectionTimeoutMillis: 15_000, statement_timeout: 15_000 };
}

async function bounded(stage, operation) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => { timer = setTimeout(() => reject(fail(`${stage} timeout`)), 30_000); })]); }
  catch (error) { sanitized(error, stage); } finally { clearTimeout(timer); }
}
async function query(client, sql, values, stage = "database query") { return bounded(stage, () => values === undefined ? client.query(sql) : client.query(sql, values)); }
function track(client) { let asyncError; if (!client || typeof client.on !== "function") return () => {}; client.on("error", () => { asyncError ||= fail("driver asynchronous error"); }); return () => { if (asyncError) throw asyncError; }; }
async function end(client) { try { if (client?.end) await bounded("database cleanup", () => client.end()); } catch {} }
async function connect(createClient, connection) { const client = createClient(connection); const assertAsync = track(client); try { await bounded("database connect", () => client.connect()); assertAsync(); return { client, assertAsync }; } catch (error) { await end(client); sanitized(error, "database connect"); } }

function expectedLedger(sources, bundle, historical = []) { return ordered([...historical, ...sources.map(({ version, name, sql }) => ({ version, name, statements: [sql] })), { version: BUNDLE_VERSION, name: BUNDLE_NAME, statements: [bundle] }]); }

export async function readCatalog(client, { readOnly = false } = {}) {
  let began = false;
  try {
    if (readOnly) { await query(client, "BEGIN READ ONLY", undefined, "read-only begin"); began = true; await query(client, "SET LOCAL ROLE postgres", undefined, "read-only role"); }
    const ledger = (await query(client, "select version,name,statements from supabase_migrations.schema_migrations order by version,name")).rows;
    const prerequisitesMissing = Number((await query(client, "select count(*)::int n from unnest($1::text[]) x where to_regclass(x) is null", [REQUIRED])).rows[0]?.n);
    const recoveryPrerequisites = (await query(client, "select to_regprocedure('public.spend_sms_segment_budget(integer)') is not null and to_regprocedure('public.account_recovery_write_guard()') is not null and to_regprocedure('public.account_recovery_capture_delete()') is not null ok")).rows[0]?.ok === true;
    const manualPayments = (await query(client, "select a.attname is null or (a.atttypid='jsonb'::regtype and a.attnotnull and pg_get_expr(d.adbin,d.adrelid) in ('''{}''::jsonb','jsonb_build_object()')) compatible,exists(select 1 from public.manager_automation_settings where manual_payments='{}'::jsonb and jsonb_typeof(row_data->'manualPayments')='object') backfill from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid='public.manager_automation_settings'::regclass and a.attname='manual_payments' and not a.attisdropped")).rows[0];
    const columns = (await query(client, "select table_name,column_name,udt_name,is_nullable,column_default from information_schema.columns where table_schema='public' and (table_name||'.'||column_name)=any($1::text[]) order by 1,2", [COLUMNS.map(([table, column]) => `${table}.${column}`)])).rows;
    const targets = (await query(client, "select c.relname,c.relrowsecurity,(select count(*)::int from pg_policy where polrelid=c.oid) policies,has_table_privilege('service_role',c.oid,'select') service_select,has_table_privilege('service_role',c.oid,'insert') service_insert,has_table_privilege('service_role',c.oid,'update') service_update,has_table_privilege('service_role',c.oid,'delete') service_delete,has_table_privilege('anon',c.oid,'select') anon_select,has_table_privilege('anon',c.oid,'insert') anon_insert,has_table_privilege('anon',c.oid,'update') anon_update,has_table_privilege('anon',c.oid,'delete') anon_delete,has_table_privilege('authenticated',c.oid,'select') authenticated_select,has_table_privilege('authenticated',c.oid,'insert') authenticated_insert,has_table_privilege('authenticated',c.oid,'update') authenticated_update,has_table_privilege('authenticated',c.oid,'delete') authenticated_delete,coalesce(bool_or(has_column_privilege('anon',c.oid,a.attnum,'select') or has_column_privilege('anon',c.oid,a.attnum,'insert') or has_column_privilege('anon',c.oid,a.attnum,'update') or has_column_privilege('anon',c.oid,a.attnum,'references')),false) anon_column_access,coalesce(bool_or(has_column_privilege('authenticated',c.oid,a.attnum,'select') or has_column_privilege('authenticated',c.oid,a.attnum,'insert') or has_column_privilege('authenticated',c.oid,a.attnum,'update') or has_column_privilege('authenticated',c.oid,a.attnum,'references')),false) authenticated_column_access,coalesce(bool_and(has_column_privilege('service_role',c.oid,a.attnum,'select') and has_column_privilege('service_role',c.oid,a.attnum,'insert') and has_column_privilege('service_role',c.oid,a.attnum,'update') and has_column_privilege('service_role',c.oid,a.attnum,'references')),false) service_column_access from pg_class c left join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped where c.relnamespace='public'::regnamespace and c.relname=any($1::text[]) group by c.oid,c.relname,c.relrowsecurity order by c.relname", [TABLES])).rows;
    const indexes = (await query(client, "select c.relname indexname,t.relname table_name,i.indisunique,i.indisvalid,i.indnkeyatts,pg_get_indexdef(i.indexrelid) indexdef,coalesce(pg_get_expr(i.indpred,i.indrelid),'') predicate from pg_index i join pg_class c on c.oid=i.indexrelid join pg_class t on t.oid=i.indrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any(array['comms_credit_purchases_owner_created','manager_billing_customer_unique']) order by c.relname")).rows;
    const functions = (await query(client, "select p.proname,pg_catalog.oidvectortypes(p.proargtypes) args,p.prosecdef,p.proconfig,has_function_privilege('service_role',p.oid,'execute') service_execute,has_function_privilege('anon',p.oid,'execute') anon_execute,has_function_privilege('authenticated',p.oid,'execute') authenticated_execute from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any($1::text[]) order by 1,2", [FUNCTIONS.map((x) => x.slice(0, x.indexOf("(")))] )).rows;
    const triggers = (await query(client, "select c.relname,t.tgname,t.tgenabled,t.tgtype,t.tgattr::text update_columns,pg_get_expr(t.tgqual,t.tgrelid) when_clause,nf.nspname||'.'||p.proname||'('||pg_catalog.oidvectortypes(p.proargtypes)||')' fn from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace join pg_proc p on p.oid=t.tgfoid join pg_namespace nf on nf.oid=p.pronamespace where not t.tgisinternal and n.nspname='public' and c.relname=any(array['manager_comms_credit_purchases','manager_comms_credit_adjustments']) and t.tgname=any(array['account_recovery_write_guard','account_recovery_capture_delete']) order by 1,2")).rows;
    const shape = targets.length === TABLES.length ? (await query(client, "select (select count(*)::int from public.comms_credit_policy where singleton) singleton,(select count(*)::int from public.comms_credit_policy) policy_rows,(select count(*)::int from pg_attribute a join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid in ('public.manager_comms_billing_accounts'::regclass,'public.manager_comms_usage_events'::regclass) and a.attname in ('included_allowance_cents','included_remaining_cents','purchased_credit_cents','included_debit_cents','purchased_debit_cents','platform_absorbed_cents') and a.attnotnull and pg_get_expr(d.adbin,d.adrelid)='0') credit_defaults")).rows[0] : null;
    const constraints = (await query(client, "select conname,pg_get_constraintdef(oid) definition from pg_constraint where conrelid='public.manager_comms_usage_events'::regclass and conname=any(array['comms_usage_credit_state_check','manager_comms_usage_events_quantity_check']) order by conname")).rows;
    const activity = (await query(client, "select count(*) filter(where pid<>pg_backend_pid() and backend_type='client backend')::int other_sessions,count(*) filter(where pid<>pg_backend_pid() and backend_type='client backend' and state<>'idle')::int active_sessions,count(*) filter(where pid<>pg_backend_pid() and backend_type='client backend' and xact_start<clock_timestamp()-interval '5 minutes')::int long_transactions,count(*) filter(where pid<>pg_backend_pid() and backend_type='client backend' and wait_event_type='Lock')::int lock_waiters from pg_stat_activity where datname=current_database()")).rows[0];
    return { ledger, prerequisitesMissing, recoveryPrerequisites, manualPayments, columns, targets, indexes, functions, triggers, shape, constraints, activity };
  } finally { if (began) { try { await query(client, "ROLLBACK", undefined, "read-only rollback"); } catch { throw fail("read-only rollback"); } } }
}

function clean(state, sources) {
  const identities = new Set([...sources.map((x) => `${x.version}\0${x.name}`), `${BUNDLE_VERSION}\0${BUNDLE_NAME}`]);
  if (state.prerequisitesMissing !== 0 || !state.recoveryPrerequisites || !state.manualPayments?.compatible || state.manualPayments?.backfill || state.columns.length || state.targets.length || state.indexes.length || state.functions.length || state.triggers.length || state.activity?.long_transactions || state.activity?.lock_waiters || state.ledger.some((row) => identities.has(`${row.version}\0${row.name}`) || sources.some((s) => row.version === s.version || row.name === s.name) || row.version === BUNDLE_VERSION || row.name === BUNDLE_NAME)) throw fail("preflight validation");
}
function installed(state, sources, bundle, historical) {
  const exactFunctions = FUNCTIONS.map((fn) => `public.${fn}`).sort();
  const exactColumns = Object.values(COLUMN_SHAPES).sort((a, b) => `${a.table_name}.${a.column_name}`.localeCompare(`${b.table_name}.${b.column_name}`));
  const actualColumns = [...state.columns].sort((a, b) => `${a.table_name}.${a.column_name}`.localeCompare(`${b.table_name}.${b.column_name}`));
  const actualFunctions = state.functions.map((r) => `public.${r.proname}(${String(r.args).replaceAll(/\s+/g, "").replaceAll(/integer/g, "integer")})`).sort();
  const expectedTriggers = TABLES.slice(1).flatMap((relname) => [
    { relname, tgname: "account_recovery_capture_delete", fn: "public.account_recovery_capture_delete()", tgtype: 9 },
    { relname, tgname: "account_recovery_write_guard", fn: "public.account_recovery_write_guard()", tgtype: 31 },
  ]).sort((a, b) => `${a.relname}\0${a.tgname}`.localeCompare(`${b.relname}\0${b.tgname}`));
  const timezoneFunctions = new Set(["claim_comms_budget_alert", "comms_wallet_snapshot", "comms_wallet_snapshots", "spend_sms_outbox_segment_budget"]);
  const exactFunctionConfig = (row) => {
    const expected = [row.proname === "claim_comms_budget_alert" ? "search_path=public" : "search_path=public, pg_temp"];
    if (timezoneFunctions.has(row.proname)) expected.push("TimeZone=UTC");
    return same([...row.proconfig].sort(), expected.sort());
  };
  const expectedIndexes = [{ indexname: "comms_credit_purchases_owner_created", table_name: "manager_comms_credit_purchases", indisunique: false, indisvalid: true, indnkeyatts: 2, indexdef: "CREATE INDEX comms_credit_purchases_owner_created ON public.manager_comms_credit_purchases USING btree (manager_user_id, created_at DESC)", predicate: "" }, { indexname: "manager_billing_customer_unique", table_name: "manager_comms_billing_accounts", indisunique: true, indisvalid: true, indnkeyatts: 1, indexdef: "CREATE UNIQUE INDEX manager_billing_customer_unique ON public.manager_comms_billing_accounts USING btree (stripe_customer_id) WHERE (stripe_customer_id IS NOT NULL)", predicate: "(stripe_customer_id IS NOT NULL)" }];
  const expectedConstraints = [{ conname: "comms_usage_credit_state_check", definition: "CHECK ((credit_state = ANY (ARRAY['legacy'::text, 'reserved'::text, 'settled'::text, 'released'::text])))" }, { conname: "manager_comms_usage_events_quantity_check", definition: "CHECK (((quantity > (0)::numeric) OR ((quantity = (0)::numeric) AND (credit_state = 'released'::text))))" }];
  if (!same(ordered(state.ledger), expectedLedger(sources, bundle, historical)) || !same(actualColumns, exactColumns) || !same(state.indexes, expectedIndexes) || !same(state.constraints, expectedConstraints) || state.targets.length !== 3 || state.targets.some((row) => !row.relrowsecurity || row.policies !== 0 || !row.service_select || !row.service_insert || !row.service_update || !row.service_delete || !row.service_column_access || row.anon_select || row.anon_insert || row.anon_update || row.anon_delete || row.anon_column_access || row.authenticated_select || row.authenticated_insert || row.authenticated_update || row.authenticated_delete || row.authenticated_column_access) ||
      !same(actualFunctions, exactFunctions) || state.functions.some((row) => !row.prosecdef || !Array.isArray(row.proconfig) || !exactFunctionConfig(row) || !row.service_execute || row.anon_execute || row.authenticated_execute) ||
      !same(state.triggers.map(({ relname, tgname, fn, tgtype, tgenabled, update_columns, when_clause }) => ({ relname, tgname, fn, tgtype: Number(tgtype), tgenabled, update_columns, when_clause })), expectedTriggers.map((row) => ({ ...row, tgenabled: "O", update_columns: "", when_clause: null }))) ||
      Number(state.shape?.singleton) !== 1 || Number(state.shape?.policy_rows) !== 1 || Number(state.shape?.credit_defaults) !== 6) throw fail("catalog verification");
}

async function freshReadback(createClient, connection, sources, bundle, baseline) {
  let connectionState;
  try { connectionState = await connect(createClient, connection); const state = await readCatalog(connectionState.client, { readOnly: true }); connectionState.assertAsync(); try { installed(state, sources, bundle, baseline.ledger); return "installed"; } catch { return same(state, baseline) ? "clean" : "invalid"; } }
  catch { return "unavailable"; } finally { await end(connectionState?.client); }
}

/** Dependencies are injectable only for local tests; CLI input never reaches them. */
export async function runFixedOperation({ operation, target }, dependencies = {}) {
  const { sources, bundle, interior } = exactBundle();
  if (operation === "manifest") return preparationReport();
  if (operation === "apply") assertWaiver(target);
  const connection = dependencies.connection ?? acquireCredentials(target, dependencies);
  const createClient = dependencies.createClient ?? ((config) => { const require = createRequire(import.meta.url); return new (require("pg").Client)(config); });
  let initial;
  try {
    initial = await connect(createClient, connection);
    const before = await readCatalog(initial.client, { readOnly: true }); initial.assertAsync();
    if (operation === "verify") {
      const newIds = new Set([...sources.map((row) => `${row.version}\0${row.name}`), `${BUNDLE_VERSION}\0${BUNDLE_NAME}`]);
      installed(before, sources, bundle, before.ledger.filter((row) => !newIds.has(`${row.version}\0${row.name}`)));
      return { outcome: "verified", target, migrationCount: sources.length };
    }
    clean(before, sources);
    if (operation === "preflight") return { outcome: "preflight_passed", target, migrationCount: sources.length, ledgerRows: before.ledger.length, activity: before.activity };
    const again = await readCatalog(initial.client, { readOnly: true }); initial.assertAsync(); clean(again, sources);
    if (!same(before.ledger, again.ledger)) throw fail("ledger drift validation");
    let commitAttempted = false; let commitConfirmed = false; let rollbackConfirmed = false; let transactionFailure;
    try {
      await query(initial.client, "BEGIN", undefined, "transaction begin"); await query(initial.client, "SET LOCAL ROLE postgres", undefined, "transaction role");
      await query(initial.client, interior, undefined, "fixed bundle interior");
      await query(initial.client, "insert into supabase_migrations.schema_migrations(version,name,statements) values($1,$2,array[$3::text])", [BUNDLE_VERSION, BUNDLE_NAME, bundle], "auxiliary ledger insertion");
      const beforeCommit = await readCatalog(initial.client); initial.assertAsync(); installed(beforeCommit, sources, bundle, before.ledger);
      commitAttempted = true; await query(initial.client, "COMMIT", undefined, "commit"); initial.assertAsync(); commitConfirmed = true;
    } catch (error) { transactionFailure = error; if (!commitAttempted) { try { await query(initial.client, "ROLLBACK", undefined, "rollback"); initial.assertAsync(); rollbackConfirmed = true; } catch {} } }
    await end(initial.client); initial = undefined;
    const readback = await freshReadback(createClient, connection, sources, bundle, before);
    if (commitConfirmed && readback === "installed") return { outcome: "success", target, migrationCount: sources.length };
    if (!commitConfirmed && rollbackConfirmed && transactionFailure && readback === "clean") return { outcome: "rolled_back_or_refused", target, migrationCount: sources.length };
    return { outcome: "uncertain_or_partial", target, migrationCount: sources.length };
  } finally { await end(initial?.client); }
}

function main() {
  return runFixedOperation(parseArgs(process.argv.slice(2)));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((result) => { console.log(JSON.stringify(result)); if (result.outcome && !["success", "preflight_passed", "verified"].includes(result.outcome)) process.exitCode = 1; })
    .catch((error) => { console.error(error instanceof Error ? error.message : "Communication billing migration failed."); process.exitCode = 1; });
}
