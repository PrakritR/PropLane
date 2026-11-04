#!/usr/bin/env node
/** Bounded vendor migration operation. Dev/test only; preflight is read-only. */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { credential, connect, backup } from "./sms-durability-release-migrations.mjs";

const DEV_PROJECT = "emstjswhotsnyksqhqyf";
const HASHES = {
  "20261004120000_vendor_coordination.sql": "99038e805a06e4efe906937068587cb9cc7ed9af2acc23f4306f0f885276fed6",
  "20261004121000_vendor_coordination_calendar_fence.sql": "0e53c91ec9accc523332099b355bcad14ea88a2f2a555647c490779411748ca6",
  "20261016120000_vendor_sourcing.sql": "87d44ba0619c4c6e4309d765f1a85339cc3796de4c785e818c5ec602a1fd7cc2",
  "20261016130000_vendor_sourcing_decline.sql": "577d94954e98d34c8fa87a89f224ffab15ac59ca5680cdfbe933cbd4e3ad0e0d",
  "20261016140000_vendor_sourcing_recovery.sql": "18cd56238c8224faa93027c638c09f5db240a5796f7c2e788c880ececa8dffd0",
  "20261016150000_vendor_sourcing_final_lifecycle.sql": "cd45f34000856781a3d2ef920ce65393180cbdb0e0800c2c5ef63f0e8052a090",
  "20261104110000_vendor_directory_link_serialization.sql": "4dea125df943ac2f678c489d207447ed892a22029f06438e62ce3c14f9920d55",
  "20261104111000_vendor_quote_contact.sql": "8e67f78686b0f2dd297b4546f280bce050fc40f3ea9ebc6d5bd709446740ec5e",
  "20261104112000_vendor_quote_inbox.sql": "ef3a83e6bb7223e87ac89d9897237df160e2bf8359ff8f58821ed448e31b708d",
  "20261104115000_vendor_coordination_current_main_compat.sql": "451410de5f9c76d331a91c06cb83282b1a4da0113ac53d73e1c8a47a380aeab7",
  "20261104121000_vendor_quote_inbox_current_main_compat.sql": "73b4e8a8c5d958da57f9686a625f854ff756cd485e73352b7f6ce8b7d545ec52",
  "20261104130000_vendor_quote_sender_authority.sql": "7d610035939ad210f9c4509767e15f6248ba64419035e2f6f21e0a4c75586531",
  "20261104140000_vendor_legacy_approval_coordination_fence.sql": "7857607f9701080f89639f3735014f09ab481942dda19537833b166e3ed19dcb",
  "20261104150000_vendor_quote_durable_ingress.sql": "98db7052a791c36aff50626fda662795e66a32d6b913cfc95d7538b97016eea8",
  "20261104160000_vendor_recovery_boundaries.sql": "17cbd84a6b59787611346f0329efb9da45132903c53b8b7cb56afb1eecd45cba"
};
const TABLES = ["sms_ingress_envelopes", "sms_platform_replies", "vendor_coordination_phone_bindings", "vendor_coordination_phone_challenges", "vendor_coordination_proposals", "vendor_coordination_operations", "vendor_coordination_reservations", "vendor_sourcing_jobs", "vendor_sourcing_candidates", "vendor_outreach_workspace_profiles", "vendor_quote_contact_capabilities", "vendor_quote_contact_sessions", "vendor_quote_email_permissions", "vendor_quote_email_outbox", "vendor_quote_email_delivery_events", "vendor_quote_responses", "vendor_quote_sms_consent_challenges", "vendor_quote_sms_consent_events"];
const FUNCTION_SIGNATURES = ["sms_ingress_claim(uuid,uuid,text,text)", "sms_ingress_prepare(uuid,uuid,text,jsonb)", "sms_ingress_checkpoint(uuid,uuid,text,text,text)", "sms_ingress_reconcile(text,text)", "sms_platform_reply_callback(uuid,text,text,text,text,text,text,integer)", "purge_sms_ingress_retention()", "sms_ingress_clear_quote_capsule(uuid,uuid,text,text)", "sms_ingress_purge_expired_quote_capsules(text,text)", "vendor_coordination_action(jsonb)", "link_vendor_directory_account(text,uuid,uuid)", "claim_vendor_sourcing(integer,text)", "read_vendor_quote_sender_authority_revision()", "vendor_quote_submit_response(text,integer,jsonb,jsonb)", "vendor_quote_capability_action(text,jsonb,jsonb)", "consume_vendor_quote_sms_challenge(uuid,text,text,text,text,text,jsonb)", "append_vendor_quote_inbox(uuid,text,text,text,text)"];
const INTERNAL_SIGNATURES = ["guard_vendor_coordination_appointment_evidence()", "vendor_coordination_canonical_visits(uuid,text,text)", "vendor_coordination_recovered_bid_proposal(public.work_order_bids)", "reattach_vendor_recovered_accepted_bid()", "sms_ingress_erase_terminal_quote_capsule()", "vendor_quote_submit_response(text,integer,jsonb)", "vendor_quote_capability_action(text,jsonb)", "consume_vendor_quote_sms_challenge(uuid,text,text,text,text,text)", "vendor_quote_sender_is_current(uuid)", "require_vendor_quote_sender_proof(jsonb,uuid,text)", "invalidate_vendor_quote_sender_authority()"];
const REQUIRED_COLUMNS = {
  portal_work_order_records: ["id", "manager_user_id", "vendor_user_id", "resident_user_id", "resident_email", "assigned_property_id", "property_id", "row_data", "updated_at"],
  work_order_bids: ["id", "work_order_id", "manager_user_id", "vendor_user_id", "vendor_directory_id", "amount_cents", "materials_cents", "proposed_time", "note", "status", "quote_mode", "bid_submitted_at", "updated_at"],
  manager_property_records: ["id", "manager_user_id", "workspace_id"],
  portal_inbox_thread_aliases: ["alias_id", "thread_id"],
  manager_vendor_records: ["id", "manager_user_id", "vendor_user_id", "row_data", "updated_at"],
  work_order_vendor_offers: ["id", "work_order_id", "manager_user_id", "vendor_user_id", "vendor_directory_id", "status", "expires_at", "updated_at"],
  profiles: ["id", "phone", "phone_verified_at", "email"],
  action_events: ["id", "event_key", "manager_user_id", "payload"],
  action_event_deliveries: ["event_id", "audience", "recipient_key", "recipient_user_id", "recipient_email", "rendered"],
  vendor_availability_rules: ["vendor_user_id", "kind", "weekday", "specific_date", "start_minute", "end_minute"],
  agent_sessions: ["id", "user_id", "landlord_id", "kind", "work_order_id", "vendor_directory_id", "vendor_user_id", "vendor_phone_e164", "status"],
  agent_messages: ["session_id", "role", "content", "channel"],
  manager_automation_settings: ["manager_user_id", "vendor_dispatch", "row_data"],
  portal_inbox_thread_records: ["id", "owner_user_id", "scope", "workspace_id", "row_data"],
  sms_consent_events: ["recipient_phone_key", "manager_user_id", "event_type", "purpose"],
};
const hash = (value) => createHash("sha256").update(value).digest("hex");

export function reviewedVendorMigrations() {
  return Object.entries(HASHES).map(([filename, expected]) => {
    const sql = readFileSync(new URL(`../supabase/migrations/${filename}`, import.meta.url), "utf8");
    if (hash(sql) !== expected) throw new Error(`Reviewed vendor migration changed: ${filename}`);
    const match = /^(\d{14})_(.+)\.sql$/.exec(filename);
    if (!match) throw new Error("Invalid reviewed vendor filename");
    return { version: match[1], name: match[2], hash: expected, sql };
  });
}

export function parseOptions(argv) {
  const options = { phase: "preflight" };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    if (seen.has(name)) throw new Error("Duplicate vendor migration option");
    seen.add(name);
    if (!["--target", "--phase", "--backup-file", "--expected-state"].includes(name) || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("Invalid vendor migration option");
    const key = { "--target": "target", "--phase": "phase", "--backup-file": "backupFile", "--expected-state": "expectedState" }[name];
    if (Object.hasOwn(options, key) && key !== "phase") throw new Error("Duplicate vendor migration option");
    options[key] = argv[++i];
  }
  if (options.target !== "dev" || !["preflight", "apply", "postflight"].includes(options.phase)) throw new Error("Only --target dev is authorized by this operation");
  if (options.phase === "apply") {
    if (!/^[a-f0-9]{64}$/.test(options.expectedState ?? "")) throw new Error("Apply requires the reviewed preflight --expected-state digest");
    if (!options.backupFile || !resolve(options.backupFile).startsWith("/private/tmp/") || !realpathSync(dirname(resolve(options.backupFile))).startsWith("/private/tmp")) throw new Error("Apply requires an exclusive private backup path under /private/tmp");
  } else if (options.backupFile || options.expectedState) throw new Error("Apply-only option in read-only phase");
  return options;
}

export function assertVendorLedger(rows, migrations, complete = false) {
  const seen = new Set();
  for (const row of rows) {
    const migration = migrations.find((item) => item.version === row.version && item.name === row.name);
    if (!migration || seen.has(row.version)) throw new Error("Vendor migration ledger name/version collision");
    seen.add(row.version);
  }
  if (complete && seen.size !== migrations.length) throw new Error("Vendor migration ledger incomplete");
  // Existing predecessor statements are captured by the state digest; no old migration is rewritten.
  return migrations.filter((item) => !seen.has(item.version));
}

async function snapshot(client, migrations) {
  // Durable SMS is installed by its independently reviewed writer, never this operation.
  const prerequisiteSql = readFileSync(new URL("../supabase/migrations/20261104120000_sms_durable_ingress.sql", import.meta.url), "utf8");
  if (hash(prerequisiteSql) !== "37ee641a1886840e79b615879686d8205e4714e72c37f50913e5dc342e18d113") throw new Error("Reviewed SMS prerequisite changed");
  const prerequisite = (await client.query("select version,name,statements from supabase_migrations.schema_migrations where version='20261104120000' or name='sms_durable_ingress' order by version,name")).rows;
  if (prerequisite.length !== 1 || prerequisite[0].version !== "20261104120000" || prerequisite[0].name !== "sms_durable_ingress" || JSON.stringify(prerequisite[0].statements) !== JSON.stringify([prerequisiteSql])) throw new Error("Install and verify exact durable SMS prerequisite with its separate writer first");
  const ledger = (await client.query("select version,name,statements from supabase_migrations.schema_migrations where version=any($1::text[]) or name=any($2::text[]) order by version,name", [migrations.map((m) => m.version), migrations.map((m) => m.name)])).rows;
  assertVendorLedger(ledger, migrations);
  const columns = (await client.query("select table_name,column_name,data_type,is_nullable from information_schema.columns where table_schema='public' and table_name=any($1::text[]) order by table_name,ordinal_position", [[...Object.keys(REQUIRED_COLUMNS), ...TABLES, "vendor_quote_sender_authority_revision"]])).rows;
  for (const [table, names] of Object.entries(REQUIRED_COLUMNS)) {
    if (names.some((column) => !columns.some((row) => row.table_name === table && row.column_name === column))) throw new Error(`Vendor prerequisite column missing: ${table}`);
  }
  const functions = (await client.query("select p.oid::regprocedure::text signature,pg_get_functiondef(p.oid) definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname like 'sms_ingress_%' or p.proname like 'sms_platform_reply_%' or p.proname='purge_sms_ingress_retention' or p.proname like '%vendor_coordination%' or p.proname like '%vendor_sourcing%' or p.proname like '%vendor_quote%' or p.proname in ('link_vendor_directory_account','guard_legacy_vendor_bid_coordination','reattach_vendor_recovered_accepted_bid','account_recovery_recreatable','account_recovery_restore_reference','account_recovery_write_guard','account_recovery_capture_delete','guard_vendor_calendar_against_coordination')) order by signature")).rows;
  const present = new Set(ledger.map((row) => row.name));
  for (const [name, table] of [["vendor_coordination", "vendor_coordination_proposals"], ["vendor_sourcing", "vendor_sourcing_jobs"], ["vendor_quote_contact", "vendor_quote_contact_capabilities"], ["vendor_quote_sender_authority", "vendor_quote_sender_authority_revision"]]) {
    const exists = columns.some((row) => row.table_name === table);
    if (exists !== present.has(name)) throw new Error(`Vendor schema/ledger mismatch: ${name}`);
  }
  let legacyOverlapCount = 0;
  if (columns.some((row) => row.table_name === "vendor_coordination_proposals")) {
    legacyOverlapCount = Number((await client.query("select count(*)::int n from public.work_order_bids b join public.vendor_coordination_proposals p on p.work_order_id=b.work_order_id where b.status='accepted' and p.status in ('collecting','ready','approved') and p.accepted_bid_id is distinct from b.id")).rows[0].n);
    if (legacyOverlapCount !== 0) throw new Error("Legacy accepted bid overlaps active coordination; reviewed reconciliation required");
  }
  const state = { ledger, prerequisite, columns, functions, legacyOverlapCount };
  return { ...state, digest: hash(JSON.stringify(state)) };
}

async function postflight(client, migrations) {
  const state = await snapshot(client, migrations);
  assertVendorLedger(state.ledger, migrations, true);
  for (const table of TABLES) {
    const result = await client.query("select c.relrowsecurity rls, has_table_privilege('anon',$1,'SELECT,INSERT,UPDATE,DELETE') anon_access, has_table_privilege('authenticated',$1,'SELECT,INSERT,UPDATE,DELETE') auth_access, has_table_privilege('service_role',$1,'SELECT') and has_table_privilege('service_role',$1,'INSERT') and has_table_privilege('service_role',$1,'UPDATE') and has_table_privilege('service_role',$1,'DELETE') service_access from pg_class c where c.oid=to_regclass($1)", [`public.${table}`]);
    const row = result.rows[0];
    if (!row || !row.rls || row.anon_access || row.auth_access || !row.service_access) throw new Error(`Vendor table ACL/RLS mismatch: ${table}`);
  }
  for (const signature of FUNCTION_SIGNATURES) {
    const result = await client.query("select has_function_privilege('anon',$1,'EXECUTE') anon_access, has_function_privilege('authenticated',$1,'EXECUTE') auth_access, has_function_privilege('service_role',$1,'EXECUTE') service_access", [`public.${signature}`]);
    const row = result.rows[0];
    if (!row || row.anon_access || row.auth_access || !row.service_access) throw new Error(`Vendor function ACL mismatch: ${signature}`);
  }
  for (const signature of INTERNAL_SIGNATURES) {
    const row = (await client.query("select has_function_privilege('anon',$1,'EXECUTE') anon_access,has_function_privilege('authenticated',$1,'EXECUTE') auth_access,has_function_privilege('service_role',$1,'EXECUTE') service_access", [`public.${signature}`])).rows[0];
    if (!row || row.anon_access || row.auth_access || row.service_access) throw new Error(`Unfenced sender authority executable: ${signature}`);
  }
  const revisionAcl = (await client.query("select c.relrowsecurity rls,has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') anon_access,has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') auth_access,has_table_privilege('service_role',c.oid,'SELECT') service_read,has_table_privilege('service_role',c.oid,'INSERT,UPDATE,DELETE') service_write from pg_class c where c.oid=to_regclass('public.vendor_quote_sender_authority_revision')")).rows[0];
  if (!revisionAcl || !revisionAcl.rls || revisionAcl.anon_access || revisionAcl.auth_access || !revisionAcl.service_read || revisionAcl.service_write) throw new Error("Sender authority singleton ACL mismatch");
  const revisionTriggers = (await client.query("select count(*)::int n from pg_trigger where not tgisinternal and tgenabled='O' and tgname='vendor_quote_sender_authority_changed'")).rows[0];
  if (revisionTriggers.n !== 14) throw new Error("Sender authority source fence incomplete");
  const fenceTriggers = (await client.query("select tgname from pg_trigger where not tgisinternal and tgenabled='O' and ((tgname='guard_legacy_vendor_bid_coordination' and tgrelid='public.work_order_bids'::regclass) or (tgname='guard_vendor_coordination_legacy_winner' and tgrelid='public.vendor_coordination_proposals'::regclass))")).rows;
  if (fenceTriggers.length !== 2) throw new Error("Legacy coordination approval fence missing");
  for (const migration of migrations.filter((item) => ["20261104150000", "20261104160000"].includes(item.version))) {
    const ledger = state.ledger.find((row) => row.version === migration.version);
    if (JSON.stringify(ledger?.statements) !== JSON.stringify([migration.sql])) throw new Error("Release migration ledger bytes differ from reviewed SQL");
  }
  for (const column of ["quote_capsule", "quote_capsule_expires_at"]) {
    if (!state.columns.some((row) => row.table_name === "sms_ingress_envelopes" && row.column_name === column)) throw new Error("Quote capsule column missing");
  }
  const capsuleFence = (await client.query("select c.convalidated validated from pg_constraint c where c.conrelid='public.sms_ingress_envelopes'::regclass and c.conname='sms_ingress_quote_capsule_shape'")).rows[0];
  const eraseTrigger = (await client.query("select count(*)::int n from pg_trigger where not tgisinternal and tgenabled='O' and tgrelid='public.sms_ingress_envelopes'::regclass and tgname='sms_ingress_erase_terminal_quote_capsule'")).rows[0];
  if (!capsuleFence?.validated || eraseTrigger.n !== 1) throw new Error("Quote capsule lifecycle fence missing");
  const claim = state.functions.find((row) => row.signature.endsWith("sms_ingress_claim(uuid,uuid,text,text)"))?.definition ?? "";
  if (!claim.includes("'quote_capsule'") || !claim.includes("'wire_from'") || !claim.includes("'wire_to'")) throw new Error("Quote claim context missing");
  const recoveryTables = TABLES.filter((table) => table.startsWith("vendor_"));
  const recoveryHooks = (await client.query("select c.relname table_name,t.tgname,t.tgtype,t.tgenabled,t.tgattr::text attributes,t.tgqual is null no_condition,t.tgconstraint=0 no_constraint,t.tgfoid=to_regprocedure('public.'||t.tgname||'()') exact_function,p.pronargs=0 and t.tgnargs=0 no_args,p.prorettype='trigger'::regtype trigger_return from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_proc p on p.oid=t.tgfoid where c.relnamespace='public'::regnamespace and c.relname=any($1::text[]) and not t.tgisinternal and t.tgname in ('account_recovery_write_guard','account_recovery_capture_delete')", [recoveryTables])).rows;
  for (const table of recoveryTables) {
    const hooks = recoveryHooks.filter((row) => row.table_name === table);
    if (hooks.length !== 2 || hooks.some((row) => row.tgtype !== (row.tgname === "account_recovery_write_guard" ? 31 : 9) || row.tgenabled !== "O" || row.attributes !== "" || !row.no_condition || !row.no_constraint || !row.exact_function || !row.no_args || !row.trigger_return)) throw new Error(`Exact vendor recovery hooks missing: ${table}`);
  }
  for (const [table, name, type] of [["manager_vendor_records", "guard_vendor_coordination_appointment_evidence", 23], ["work_order_bids", "reattach_vendor_recovered_accepted_bid", 5]]) {
    const row = (await client.query("select tgtype,tgenabled,tgattr::text attributes,tgqual is null no_condition,tgconstraint=0 no_constraint,tgnargs=0 no_args,tgfoid=to_regprocedure($3) exact_function from pg_trigger where tgrelid=to_regclass($1) and tgname=$2 and not tgisinternal", [`public.${table}`, name, `public.${name}()`])).rows[0];
    if (!row || row.tgtype !== type || row.tgenabled !== "O" || row.attributes !== "" || !row.no_condition || !row.no_constraint || !row.no_args || !row.exact_function) throw new Error(`Vendor recovery boundary trigger missing: ${name}`);
  }
  const enqueue = state.functions.find((row) => row.signature.endsWith("enqueue_vendor_sourcing()"))?.definition ?? "";
  if (!enqueue.includes("current_setting('proplane.account_recovery_internal',true)='on' then 'dormant'")) throw new Error("Recovered service may restart sourcing");
  const coordination = state.functions.find((row) => row.signature.endsWith("vendor_coordination_action(jsonb)"))?.definition ?? "";
  if (!coordination.includes("v_work.resident_user_id is null or v_actor is distinct from v_work.resident_user_id") || !coordination.includes("bid_submitted_at = now()")) throw new Error("Vendor current-main compatibility missing");
  return state;
}

async function readOnly(client, run) {
  await client.query("begin read only");
  try { await client.query("set local role postgres"); return await run(); }
  finally { await client.query("rollback"); }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const migrations = reviewedVendorMigrations();
  const config = credential(DEV_PROJECT);
  let client = await connect(config);
  try {
    const state = await readOnly(client, () => options.phase === "postflight" ? postflight(client, migrations) : snapshot(client, migrations));
    if (options.phase !== "apply") {
      console.log(JSON.stringify({ target: DEV_PROJECT, phase: options.phase, stateDigest: state.digest, existing: state.ledger.map(({ version, name, statements }) => ({ version, name, statementsSha256: hash(JSON.stringify(statements)) })), missing: assertVendorLedger(state.ledger, migrations).map(({ version, name, hash }) => ({ version, name, hash })) }));
      return;
    }
    if (state.digest !== options.expectedState) throw new Error("Vendor preflight state changed");
    backup(config, options.backupFile);
    if (statSync(options.backupFile).size === 0 || (statSync(options.backupFile).mode & 0o077) !== 0) throw new Error("Vendor backup is empty or permissions are unsafe");
    await client.query("begin");
    let commitAttempted = false;
    try {
      await client.query("set local role postgres");
      await client.query("set local lock_timeout='3s'");
      await client.query("set local statement_timeout='60s'");
      const lock = await client.query("select pg_try_advisory_xact_lock(20261104120000::bigint) acquired");
      if (!lock.rows[0].acquired) throw new Error("Vendor migration lock unavailable");
      const locked = await snapshot(client, migrations);
      if (locked.digest !== options.expectedState) throw new Error("Vendor locked preflight state changed");
      for (const migration of assertVendorLedger(locked.ledger, migrations)) {
        await client.query(migration.sql);
        await client.query("insert into supabase_migrations.schema_migrations(version,name,statements) values($1,$2,$3)", [migration.version, migration.name, [migration.sql]]);
      }
      await postflight(client, migrations);
      commitAttempted = true;
      await client.query("commit");
    } catch (error) {
      if (!commitAttempted) await client.query("rollback").catch(() => undefined);
      throw error;
    }
    await client.end();
    client = await connect(config);
    const verified = await readOnly(client, () => postflight(client, migrations));
    console.log(JSON.stringify({ target: DEV_PROJECT, phase: "apply", outcome: "committed_and_verified", backupFile: options.backupFile, stateDigest: verified.digest }));
  } finally { await client.end().catch(() => undefined); }
}
export { snapshot as snapshotVendorRelease, postflight as postflightVendorRelease, readOnly as readOnlyVendorRelease };

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`Vendor migration operation failed: ${error instanceof Error ? error.message : "unknown"}`); process.exitCode = 1; });
}
