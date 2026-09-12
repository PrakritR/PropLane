#!/usr/bin/env node
/** Preparation-only, deterministic communication-credit rollout bundle. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PINNED_COMMIT = "8ce3868b4e5775661956c6c3f36fcb146bfa931a";
export const BUNDLE_VERSION = "20260911161000";
export const BUNDLE_NAME = "comms_billing_rollout";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CORRECTION_FILE = "scripts/rollouts/2026-09-11-comms-billing/20260911160000_comms_credit_recovery_guards.sql";
const CORRECTION_SIZE = 1579;
const CORRECTION_SHA256 = "229e0699bc0e4685dc8ba2f6380ef9d2358816a1d72415abe7d4adb7a9c49713";
const PINNED = [
  ["20260910140000", "manager_communication_credits", 21013, "70e8ddd6138d74f67712076498ec6d5d88f2568470fe446b9954aa4102562c13"],
  ["20260910160000", "comms_credit_alerts", 1725, "d6b0dc09f80894e26e1b8b0b9df25f98e85729b948c2c9f94130211481bea07f"],
  ["20260910170000", "manager_billing_customer", 354, "7ff6fc4cbaf2e2835194610ea8af22aaa9b772bb1e5ba76943fceaf1336fd4da"],
  ["20260910180000", "comms_wallet_snapshots", 1153, "c67d8283ba00d4c1798b370eb5d1374c9309c3f78ed9e9d6086bf87f7bf1572b"],
  ["20260910190000", "sms_outbox_campaign_budget", 1467, "9c32e16882f869ae059483655b087117edd2a2c740a40321dc9c28f2d53ead47"],
];
const NEW_COLUMNS = [
  ["manager_comms_billing_accounts", "credit_period_start"], ["manager_comms_billing_accounts", "included_allowance_cents"],
  ["manager_comms_billing_accounts", "included_remaining_cents"], ["manager_comms_billing_accounts", "purchased_credit_cents"],
  ["manager_comms_billing_accounts", "credit_cutover_at"], ["manager_comms_billing_accounts", "stripe_customer_id"],
  ["manager_comms_usage_events", "credit_state"], ["manager_comms_usage_events", "included_debit_cents"],
  ["manager_comms_usage_events", "purchased_debit_cents"], ["manager_comms_usage_events", "platform_absorbed_cents"],
  ["manager_comms_usage_events", "credit_period_start"], ["sms_outbox", "campaign_budget_spent_on"],
];
const NEW_FUNCTIONS = ["comms_wallet_snapshot", "reserve_comms_credit", "finish_comms_credit", "fulfill_comms_credit_purchase", "reverse_comms_credit_purchase", "settle_comms_credit_quantity", "save_manager_payment_preferences", "set_staff_payment_fee_override", "claim_comms_budget_alert", "comms_wallet_snapshots", "spend_sms_outbox_segment_budget"];
const sqlLiteral = (value) => `'${value.replaceAll("'", "''")}'`;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function gitObject(path) {
  return Buffer.from(execFileSync("git", ["show", `${PINNED_COMMIT}:${path}`], { cwd: ROOT, encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] }));
}

export function reviewedMigrationManifest({ readPinned = gitObject, readCorrection = () => readFileSync(new URL(`../${CORRECTION_FILE}`, import.meta.url)) } = {}) {
  const sources = PINNED.map(([version, name, size, sha256]) => {
    const file = `${version}_${name}.sql`; const path = `supabase/migrations/${file}`; const bytes = readPinned(path);
    if (!Buffer.isBuffer(bytes) || bytes.length !== size || digest(bytes) !== sha256) throw new Error(`Pinned source verification failed: ${file}`);
    return { version, name, file, size, sha256, sql: bytes.toString("utf8") };
  });
  const bytes = readCorrection();
  if (!Buffer.isBuffer(bytes) || bytes.length !== CORRECTION_SIZE || digest(bytes) !== CORRECTION_SHA256) {
    throw new Error("Recovery correction verification failed.");
  }
  sources.push({ version: "20260911160000", name: "comms_credit_recovery_guards", file: CORRECTION_FILE.split("/").at(-1), size: CORRECTION_SIZE, sha256: CORRECTION_SHA256, sql: bytes.toString("utf8") });
  return sources;
}

function preflightSql(sources) {
  const ledger = sources.map((m) => sqlLiteral(m.version)).join(",");
  const names = sources.map((m) => sqlLiteral(m.name)).join(",");
  const columns = NEW_COLUMNS.map(([t, c]) => `(${sqlLiteral(t)},${sqlLiteral(c)})`).join(",");
  const funcs = NEW_FUNCTIONS.map(sqlLiteral).join(",");
  return `set local lock_timeout='3s';\nset local statement_timeout='60s';\nlock table public.manager_automation_settings in share row exclusive mode;\ndo $comms_billing_preflight$\ndeclare manual_payments_ok boolean;\nbegin\n  if not pg_try_advisory_xact_lock(723081447304::bigint) then raise exception 'comms billing rollout is already locked'; end if;\n  if exists(select 1 from supabase_migrations.schema_migrations where version=any(array[${ledger},${sqlLiteral(BUNDLE_VERSION)}]::text[]) or name=any(array[${names},${sqlLiteral(BUNDLE_NAME)}]::text[])) then raise exception 'comms billing ledger is not cleanly absent'; end if;\n  if exists(select 1 from unnest(array['public.profiles','public.manager_comms_billing_accounts','public.manager_comms_usage_events','public.manager_automation_settings','public.sms_outbox','supabase_migrations.schema_migrations']::text[]) q where to_regclass(q) is null)\n     or to_regprocedure('public.spend_sms_segment_budget(integer)') is null\n     or to_regprocedure('public.account_recovery_write_guard()') is null\n     or to_regprocedure('public.account_recovery_capture_delete()') is null then raise exception 'comms billing prerequisites are missing'; end if;\n  select a.attname is null or (a.atttypid='jsonb'::regtype and a.attnotnull and pg_get_expr(d.adbin,d.adrelid) in ('''{}''::jsonb','jsonb_build_object()')) into manual_payments_ok from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid='public.manager_automation_settings'::regclass and a.attname='manual_payments' and not a.attisdropped;\n  if manual_payments_ok is distinct from true then raise exception 'manual_payments is incompatible'; end if;\n  if exists(select 1 from pg_class where relnamespace='public'::regnamespace and relname in ('comms_credit_policy','manager_comms_credit_purchases','manager_comms_credit_adjustments'))\n     or exists(select 1 from (values ${columns}) v(t,c) join information_schema.columns i on i.table_schema='public' and i.table_name=v.t and i.column_name=v.c)\n     or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any(array[${funcs}]::text[]))\n     or exists(select 1 from pg_class where relnamespace='public'::regnamespace and relname in ('comms_credit_purchases_owner_created','manager_billing_customer_unique'))\n     or exists(select 1 from pg_trigger where not tgisinternal and tgname in ('account_recovery_write_guard','account_recovery_capture_delete') and tgrelid in (to_regclass('public.manager_comms_credit_purchases'),to_regclass('public.manager_comms_credit_adjustments'))) then raise exception 'comms billing targets are partially present'; end if;\n  if exists(select 1 from public.manager_automation_settings where manual_payments='{}'::jsonb and jsonb_typeof(row_data->'manualPayments')='object') then raise exception 'payment preference backfill must be zero'; end if;\nend $comms_billing_preflight$;`;
}

function postcheckSql() {
  const rpc = [
    'comms_wallet_snapshot(uuid,integer,integer,boolean)', 'comms_wallet_snapshots(jsonb)', 'reserve_comms_credit(uuid,integer,integer,text,text,numeric,integer,jsonb,boolean)', 'finish_comms_credit(uuid,text,boolean)', 'fulfill_comms_credit_purchase(uuid,uuid,text,text,integer,text,text)', 'reverse_comms_credit_purchase(text,integer,text,text)', 'settle_comms_credit_quantity(uuid,text,numeric)', 'save_manager_payment_preferences(uuid,jsonb)', 'set_staff_payment_fee_override(uuid,text)', 'claim_comms_budget_alert(uuid)', 'spend_sms_outbox_segment_budget(uuid,text)'
  ];
  const rpcLiterals = rpc.map(sqlLiteral).join(',');
  return `\ndo $comms_billing_postcheck$\ndeclare n integer; bad text;\nbegin
  select count(*) into n from pg_class c join pg_namespace ns on ns.oid=c.relnamespace where ns.nspname='public' and c.relname in ('comms_credit_policy','manager_comms_credit_purchases','manager_comms_credit_adjustments') and c.relrowsecurity; if n<>3 then raise exception 'postcheck RLS'; end if;
  if exists(select 1 from unnest(array['comms_credit_policy','manager_comms_credit_purchases','manager_comms_credit_adjustments']) t where has_table_privilege('anon','public.'||t,'select') or has_table_privilege('anon','public.'||t,'insert') or has_table_privilege('anon','public.'||t,'update') or has_table_privilege('anon','public.'||t,'delete') or has_table_privilege('authenticated','public.'||t,'select') or has_table_privilege('authenticated','public.'||t,'insert') or has_table_privilege('authenticated','public.'||t,'update') or has_table_privilege('authenticated','public.'||t,'delete') or has_any_column_privilege('anon','public.'||t,'select,insert,update,references') or has_any_column_privilege('authenticated','public.'||t,'select,insert,update,references') or not has_table_privilege('service_role','public.'||t,'select') or not has_table_privilege('service_role','public.'||t,'insert') or not has_table_privilege('service_role','public.'||t,'update') or not has_table_privilege('service_role','public.'||t,'delete')) then raise exception 'postcheck table grants'; end if;
  if exists(select 1 from unnest(array[${rpcLiterals}]::text[]) f where to_regprocedure('public.'||f) is null or has_function_privilege('anon','public.'||f,'execute') or has_function_privilege('authenticated','public.'||f,'execute') or not has_function_privilege('service_role','public.'||f,'execute')) then raise exception 'postcheck RPC grants'; end if;
  select string_agg(f,',') into bad from unnest(array[${rpcLiterals}]::text[]) f join pg_proc p on p.oid=to_regprocedure('public.'||f) where not p.prosecdef or p.proconfig is null or (f='claim_comms_budget_alert(uuid)' and not ('search_path=public'=any(p.proconfig))) or (f<>'claim_comms_budget_alert(uuid)' and not ('search_path=public, pg_temp'=any(p.proconfig))); if bad is not null then raise exception 'postcheck RPC identity/proconfig: %',bad; end if;
  if not exists(select 1 from pg_attribute a join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid='public.manager_automation_settings'::regclass and a.attname='manual_payments' and a.atttypid='jsonb'::regtype and a.attnotnull and pg_get_expr(d.adbin,d.adrelid)='''{}''::jsonb') then raise exception 'postcheck manual payments'; end if;
  if (select count(*) from pg_attribute a join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid in ('public.manager_comms_billing_accounts'::regclass,'public.manager_comms_usage_events'::regclass) and a.attname in ('included_allowance_cents','included_remaining_cents','purchased_credit_cents','included_debit_cents','purchased_debit_cents','platform_absorbed_cents') and a.attnotnull and pg_get_expr(d.adbin,d.adrelid)='0')<>6 then raise exception 'postcheck credit defaults'; end if;
  if not exists(select 1 from pg_constraint where conrelid='public.manager_comms_usage_events'::regclass and conname='comms_usage_credit_state_check' and pg_get_constraintdef(oid) like '%legacy%reserved%settled%released%') or not exists(select 1 from pg_constraint where conrelid='public.manager_comms_usage_events'::regclass and conname='manager_comms_usage_events_quantity_check' and pg_get_constraintdef(oid) like '%quantity >%credit_state%released%') then raise exception 'postcheck usage constraints'; end if;
  if not exists(select 1 from pg_indexes where schemaname='public' and indexname='manager_billing_customer_unique' and indexdef like '%WHERE (stripe_customer_id IS NOT NULL)%') then raise exception 'postcheck customer index'; end if;
  if (select count(*) from public.comms_credit_policy where singleton)=1 and (select count(*) from public.comms_credit_policy)=1 then null; else raise exception 'postcheck singleton policy'; end if;
  if not exists(select 1 from pg_proc where oid='public.claim_comms_budget_alert(uuid)'::regprocedure and exists(select 1 from unnest(proconfig) setting where lower(setting)='timezone=utc')) or not exists(select 1 from pg_proc where oid='public.comms_wallet_snapshot(uuid,integer,integer,boolean)'::regprocedure and exists(select 1 from unnest(proconfig) setting where lower(setting)='timezone=utc')) then raise exception 'postcheck UTC alert'; end if;
  select count(*) into n from pg_trigger t join pg_proc p on p.oid=t.tgfoid where not t.tgisinternal and t.tgrelid in ('public.manager_comms_credit_purchases'::regclass,'public.manager_comms_credit_adjustments'::regclass) and ((t.tgname='account_recovery_write_guard' and t.tgtype=31 and p.oid='public.account_recovery_write_guard()'::regprocedure) or (t.tgname='account_recovery_capture_delete' and t.tgtype=9 and p.oid='public.account_recovery_capture_delete()'::regprocedure)); if n<>4 then raise exception 'postcheck recovery triggers'; end if;
  if exists(select 1 from public.manager_automation_settings where manual_payments='{}'::jsonb and jsonb_typeof(row_data->'manualPayments')='object') then raise exception 'postcheck backfill state'; end if;
end $comms_billing_postcheck$;`;
}

function assertExactSources(sources) {
  const expected = reviewedMigrationManifest();
  if (!Array.isArray(sources) || sources.length !== expected.length) throw new Error("Bundle requires exactly six verified sources.");
  for (let index = 0; index < expected.length; index += 1) {
    const actual = sources[index]; const verified = expected[index];
    if (!actual || actual.version !== verified.version || actual.name !== verified.name || actual.file !== verified.file || actual.size !== verified.size || actual.sha256 !== verified.sha256 || actual.sql !== verified.sql || Buffer.byteLength(actual.sql, "utf8") !== actual.size || digest(Buffer.from(actual.sql, "utf8")) !== actual.sha256) throw new Error(`Bundle source ${index + 1} is not the exact reviewed object.`);
  }
}

export function buildAtomicBundle(sources = reviewedMigrationManifest()) {
  assertExactSources(sources);
  const exact = sources.map((m) => `-- exact source: ${m.file} sha256:${m.sha256}\n${m.sql}`).join("\n");
  const ledger = sources.map((m) => `insert into supabase_migrations.schema_migrations(version,name,statements) values(${sqlLiteral(m.version)},${sqlLiteral(m.name)},array[${sqlLiteral(m.sql)}]);`).join("\n");
  return `begin;\n${preflightSql(sources)}\n${exact}\n${postcheckSql()}\n${ledger}\ncommit;\n`;
}

export function completeBundleLedgerRow(bundle = buildAtomicBundle()) { return { version: BUNDLE_VERSION, name: BUNDLE_NAME, statements: [bundle] }; }
export function preparationReport() { const sources = reviewedMigrationManifest(); const bundle = buildAtomicBundle(sources); return { preparationOnly: true, applySupported: false, migrationCount: 6, sources: sources.map((m) => ({ version: m.version, name: m.name, file: m.file, size: m.size, sha256: m.sha256 })), bundle: { version: BUNDLE_VERSION, name: BUNDLE_NAME, sha256: digest(Buffer.from(bundle)), bytes: Buffer.byteLength(bundle) } }; }
export function parsePreparationArgs(args) { if (args.length || args.includes("--apply")) throw new Error("This preparation command accepts no arguments; apply, database, URL, target, and SQL inputs are forbidden."); return {}; }
if (process.argv[1] === fileURLToPath(import.meta.url)) { parsePreparationArgs(process.argv.slice(2)); console.log(JSON.stringify(preparationReport(), null, 2)); }
