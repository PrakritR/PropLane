import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { assertCatalogShape, applyReviewedMigrations, parseOptions, reviewedMigrations, runTransaction, NEW_TABLES, NEW_INDEXES, COLUMNS, POLICIES, INDEXES, FOREIGN_KEYS, NEW_TABLE_CONSTRAINTS, KEY_CHECK_DEFINITIONS, BID_LINK_BASELINE } from "../../scripts/sms-upstream-ten-gap-migrations.mjs";

const migrations = reviewedMigrations();

test("every supported phase parses, with duplicate flags refused", () => {
  const base = "/Users/akhilvemuri/.codex/release-backups/sms-20260926/upstream-ten-gap-staging-20260926T000000.dump";
  for (const phase of ["preflight", "postflight", "rehearsal"]) assert.equal(parseOptions(["--target", "staging", "--phase", phase]).phase, phase);
  assert.equal(parseOptions(["--target", "staging", "--phase", "apply", "--apply-authorized", "--backup-file", base]).backupFile, base);
  assert.equal(parseOptions(["--target", "production", "--phase", "postflight"]).phase, "postflight");
  assert.throws(() => parseOptions(["--target", "staging", "--phase", "preflight", "--phase", "postflight"]), /duplicate/);
});

test("invalid requests stop before credential bootstrap", () => {
  for (const argv of [[], ["--target", "dev"], ["--target", "staging", "--phase", "apply"],
    ["--target", "production", "--phase", "rehearsal"],
    ["--target", "staging", "--phase", "apply", "--apply-authorized", "--backup-file", "/private/tmp/upstream-ten-gap-staging-x.dump"],
    ["--target", "staging", "--phase", "apply", "--apply-authorized", "--backup-file", "/Users/akhilvemuri/.codex/release-backups/sms-20260926/upstream-ten-gap-production-x.dump"]]) {
    assert.throws(() => parseOptions(argv));
    const result = spawnSync(process.execPath, [new URL("../../scripts/sms-upstream-ten-gap-migrations.mjs", import.meta.url).pathname, ...argv], { encoding: "utf8", timeout: 3000 });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /Credential bootstrap/);
  }
});

function absentSnapshot() {
  const oldRoomSql = readFileSync(new URL("../../supabase/migrations/20260914120000_room_placement_name_fallback.sql", import.meta.url), "utf8");
  return {
    ledger: [],
    tables: Object.fromEntries([
      "vendor_business_profiles", "vendor_invoices", "portal_workspaces", "portal_work_order_records", "manager_vendor_records", "work_order_bids", "work_order_open_listings",
    ].map((name) => [name, { exists: true }])),
    columns: {}, indexes: {},
    functions: { "room_placement_room(jsonb,jsonb)": {
      body: oldRoomSql.match(/\bas \$\$([\s\S]*?)\$\$/i)[1], searchPath: 'search_path=""', securityDefiner: false,
    } },
    fks: Object.fromEntries(Object.keys(FOREIGN_KEYS).map((key) => [key, null])), constraints: {},
  };
}

function appliedSnapshot() {
  const state = absentSnapshot();
  state.ledger = migrations.map(({ version, name, sql }) => ({ version, name, statements: [sql] }));
  for (const name of NEW_TABLES) state.tables[name] = { exists: true, kind: "r", rls: true, policies: structuredClone(POLICIES[name]), anonAccess: false, authAccess: false, authSelect: name === "lease_document_library", authWrite: false, serviceAccess: true };
  for (const [table, cols] of Object.entries(COLUMNS)) for (const [name, [type, defaultSql, notNull]] of Object.entries(cols)) state.columns[`${table}.${name}`] = { type, default: defaultSql, notNull };
  for (const name of NEW_INDEXES) {
    const [table, unique, keys, predicate] = INDEXES[name];
    state.indexes[name] = { kind: "i", valid: true, ready: true, table, unique, keys, predicate, method: "btree" };
  }
  for (const [name, [table, keys, target, targetKeys, del]] of Object.entries(FOREIGN_KEYS)) state.fks[name] = { table, keys, target, targetKeys, delete: del, validated: true };
  for (const [table, names] of Object.entries(NEW_TABLE_CONSTRAINTS)) state.constraints[table] = names.map((name) => ({ name, validated: true,
    type: name.endsWith("_fkey") ? "f" : name.endsWith("_pkey") ? "p" : name.endsWith("_check") ? "c" : "u",
    keys: [name.replace(`${table}_`, "").replace(/_(fkey|pkey|check|key)$/, "")],
    definition: KEY_CHECK_DEFINITIONS[name],
    ...(name.endsWith("_fkey") ? {
      target: name.includes("work_order_id") ? "portal_work_order_records" : name.includes("account_id") ? "proplane_balance_accounts" : name.includes("related_entry_id") ? "proplane_balance_entries" : name.includes("vendor_id") ? "manager_vendor_records" : name.includes("workspace_id") ? "portal_workspaces" : name.includes("consented_by") ? "profiles" : "users",
      targetSchema: name.includes("user_id") ? "auth" : "public", targetKeys: ["id"], delete: name.includes("reviewer_user_id") || name.includes("related_entry_id") ? "n" : name.includes("consented_by") ? "a" : "c",
    } : {}),
  }));
  const sql = migrations.find((m) => m.name === "proplane_balance_ledger").sql;
  for (const [signature, [returnType, language, volatility]] of Object.entries({
    "proplane_balance_ensure_account(text,text,text)": ["uuid", "plpgsql", "v"],
    "proplane_balance_settle_due(uuid)": ["void", "plpgsql", "v"],
    "proplane_balance_available_cents(uuid)": ["bigint", "sql", "s"],
    "proplane_balance_pending_cents(uuid)": ["bigint", "sql", "s"],
    "proplane_balance_move(uuid,uuid,bigint,text,text,text)": ["record", "plpgsql", "v"],
  })) {
    const source = sql.match(new RegExp(`create or replace function public\\.${signature.split("(")[0]}\\([\\s\\S]*?\\$\\$[\\s\\S]*?\\$\\$`, "i"))[0];
    state.functions[signature] = { body: source.match(/\bas \$\$([\s\S]*?)\$\$/i)[1], securityDefiner: true, searchPath: "search_path=public, pg_temp", anonExecute: false, authExecute: false, serviceExecute: true, returnType, language, volatility };
  }
  state.functions["room_placement_room(jsonb,jsonb)"].body = migrations.find((m) => m.name === "room_placement_slot_suffix_fix").sql.match(/\bas \$\$([\s\S]*?)\$\$/i)[1];
  return state;
}

test("postflight refuses policy, index, FK and column drift", () => {
  const state = appliedSnapshot();
  assert.doesNotThrow(() => assertCatalogShape(state, migrations, true));
  for (const [mutate, error] of [
    [(s) => { s.tables.manager_vendor_preferences.policies[0].qual = "true"; }, /policy mismatch/],
    [(s) => { s.indexes.proplane_balance_withdrawal_claim_unique.unique = false; }, /index state/],
    [(s) => { s.fks.work_order_bids_open_listing_id_fkey.target = "wrong_table"; }, /foreign key differs/],
    [(s) => { s.columns["lease_document_library.fields"].default = null; }, /column differs/],
    [(s) => { s.constraints.proplane_balance_entries.find((c) => c.name === "proplane_balance_entries_idempotency_key_key").definition = "UNIQUE (amount_cents)"; }, /key\/check definition differs/],
    [(s) => { s.constraints.proplane_balance_accounts.find((c) => c.name === "proplane_balance_accounts_pkey").definition = "PRIMARY KEY (owner_kind)"; }, /key\/check definition differs/],
    [(s) => { s.constraints.proplane_balance_entries.find((c) => c.name === "proplane_balance_entries_amount_cents_check").definition = "CHECK (true)"; }, /key\/check definition differs/],
  ]) {
    const drifted = structuredClone(state);
    mutate(drifted);
    assert.throws(() => assertCatalogShape(drifted, migrations, true), error);
  }
});

test("preflight requires exact earlier ledger provenance for an existing bid link", () => {
  const state = absentSnapshot();
  state.columns["work_order_bids.open_listing_id"] = { type: "uuid", default: null, notNull: false };
  state.indexes.work_order_bids_open_listing_idx = { kind: "i", valid: true, ready: true, table: "work_order_bids", unique: false, keys: ["open_listing_id"], predicate: null, method: "btree" };
  state.fks.work_order_bids_open_listing_id_fkey = { table: "work_order_bids", keys: ["open_listing_id"], target: "work_order_open_listings", targetKeys: ["id"], delete: "n", validated: true };
  assert.throws(() => assertCatalogShape(state, migrations, false), /column already exists/);
  state.ledger = [{ version: BID_LINK_BASELINE.version, name: BID_LINK_BASELINE.name, statements: ["forged statement"] }];
  assert.throws(() => assertCatalogShape(state, migrations, false), /ledger identity differs/);
  state.ledger = [];
  delete state.indexes.work_order_bids_open_listing_idx;
  assert.throws(() => assertCatalogShape(state, migrations, false), /column already exists/);
});

test("preflight refuses partial ledger and partial catalog", () => {
  const state = absentSnapshot();
  assert.doesNotThrow(() => assertCatalogShape(state, migrations, false));
  state.ledger.push({ version: migrations[0].version, name: migrations[0].name, statements: [migrations[0].sql] });
  assert.throws(() => assertCatalogShape(state, migrations, false), /ledger partly/);
  state.ledger = [];
  state.tables.vendor_reviews = { exists: true };
  assert.throws(() => assertCatalogShape(state, migrations, false), /table state/);
  state.tables.vendor_reviews = { exists: false };
  state.columns["portal_workspaces.payout_mode"] = { type: "text" };
  assert.throws(() => assertCatalogShape(state, migrations, false), /column already exists/);
});

test("a failed SQL statement prevents its ledger insert and all later migrations", async () => {
  const calls = [];
  const client = { async query(sql) { calls.push(sql); if (sql === migrations[1].sql) throw new Error("statement failed"); } };
  await assert.rejects(applyReviewedMigrations(client, migrations), /statement failed/);
  assert.deepEqual(calls, [migrations[0].sql, "insert into supabase_migrations.schema_migrations(version,name,statements) values($1,$2,$3)", migrations[1].sql]);
});

test("transaction refuses an unavailable migration lock and rolls back", async () => {
  const calls = [];
  const client = { async query(sql) { calls.push(sql); return sql.includes("pg_try_advisory_xact_lock") ? { rows: [{ acquired: false }] } : { rows: [] }; } };
  await assert.rejects(runTransaction(client, migrations, true), /lock unavailable/);
  assert.equal(calls.at(-1), "rollback");
  assert.ok(!calls.includes("commit"));
});
