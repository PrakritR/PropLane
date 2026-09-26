#!/usr/bin/env node
/** One bounded operation for the ten inherited September 25 schema gaps. */
import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { backup, connect, credential } from "./sms-durability-release-migrations.mjs";
import { SMS_RELEASE_TARGETS, sha256 } from "./sms-durability-release-manifest.mjs";

const BACKUP_DIR = "/Users/akhilvemuri/.codex/release-backups/sms-20260926";
const ENTRIES = Object.freeze([
  ["20260925000000", "vendor_reviews", "0b3e5465002e55176c780a8b0cb631cbe487ef95a7c15d41f3f7c115fb8cebbc"],
  ["20260925010000", "vendor_self_signup_onboarding", "600d75d9d434b13590d7df313df9cd077764364c4d8874a41956409fb3816bdc"],
  ["20260925020000", "vendor_reviews_no_client_select", "6ec6e60b3c66a6a345f76c0de2b5a2684c69ea68b70c683d162dd32081f80adc"],
  ["20260925030000", "room_placement_slot_suffix_fix", "f50a37b0c4f142cc17722a0e1d0c4d2e5e5ce3e1e76e95ea842aa4577292f08b"],
  ["20260925073005", "proplane_balance_ledger", "d03062456b0d73f89ed8a2e5ed909dcb8985b39eb5887cc1636581bcfb398200"],
  ["20260925190000", "proplane_balance_related_entry_set_null", "1f2a42c01295119da599d5d31e58531a109c04ed414dc317287a0a93117709c9"],
  ["20260925193000", "lease_document_library", "18059710595b8b636f9932f33e4a1a10a754e3692eceabd770e8b25d53e05ee2"],
  ["20260925200000", "manager_vendor_preferences", "fab937c545e1b302ce41796e6fbb89f44dd3b71185ed951958dd6180de51042b"],
  ["20260925220000", "workspace_stripe_connect", "f8c9a86650b45120929f70fa07ea6999835358a5cd07e50fdcf740a17e0b69f8"],
  ["20260925231000", "work_order_bids_open_listing_link", "e31fbb59e2927a4e157e39e6cef8eb4a097cc0ce691cb9ec7254513e2eaae711"],
]);
export const BID_LINK_BASELINE = Object.freeze({
  version: "20260926070144", name: "work_order_open_listings",
  statementHash: "2a8e04b1dea9d892b92ce3a5c84a4e4cb7b7f4a3a41fda427c1c8c891ea111e9",
});
export const NEW_TABLES = ["vendor_reviews", "proplane_balance_accounts", "proplane_balance_entries", "lease_document_library", "manager_vendor_preferences", "workspace_debit_consents"];
const PREREQUISITES = ["vendor_business_profiles", "vendor_invoices", "portal_workspaces", "portal_work_order_records", "manager_vendor_records", "work_order_bids", "work_order_open_listings"];
export const NEW_INDEXES = ["vendor_reviews_vendor_user_id_idx", "vendor_reviews_manager_user_id_idx", "vendor_reviews_reviewer_user_id_idx", "vendor_business_profiles_directory_listed_idx", "proplane_balance_entries_account_status_idx", "proplane_balance_entries_pending_available_on_idx", "proplane_balance_withdrawal_claim_unique", "lease_document_library_default_per_workspace", "lease_document_library_workspace_idx", "manager_vendor_preferences_lookup_idx", "portal_workspaces_stripe_connect_account_unique", "work_order_bids_open_listing_idx"];
const BALANCE_FUNCTIONS = ["proplane_balance_ensure_account(text,text,text)", "proplane_balance_settle_due(uuid)", "proplane_balance_available_cents(uuid)", "proplane_balance_pending_cents(uuid)", "proplane_balance_move(uuid,uuid,bigint,text,text,text)"];
const FUNCTION_META = {
  "proplane_balance_ensure_account(text,text,text)": ["uuid", "plpgsql", "v"],
  "proplane_balance_settle_due(uuid)": ["void", "plpgsql", "v"],
  "proplane_balance_available_cents(uuid)": ["bigint", "sql", "s"],
  "proplane_balance_pending_cents(uuid)": ["bigint", "sql", "s"],
  "proplane_balance_move(uuid,uuid,bigint,text,text,text)": ["record", "plpgsql", "v"],
};
const ROOM_FUNCTION = "room_placement_room(jsonb,jsonb)";
export const COLUMNS = {
  vendor_reviews: {
    id: ["uuid", "gen_random_uuid()", true], manager_user_id: ["uuid", null, true], reviewer_user_id: ["uuid", null, false],
    vendor_user_id: ["uuid", null, true], work_order_id: ["text", null, true], stars: ["smallint", null, true],
    body: ["text", "''::text", true], vendor_reply: ["text", null, false], vendor_replied_at: ["timestamp with time zone", null, false],
    created_at: ["timestamp with time zone", "now()", true], updated_at: ["timestamp with time zone", "now()", true],
  },
  proplane_balance_accounts: {
    id: ["uuid", "gen_random_uuid()", true], owner_kind: ["text", null, true], owner_key: ["text", null, true],
    currency: ["text", "'usd'::text", true], created_at: ["timestamp with time zone", "now()", true],
  },
  proplane_balance_entries: {
    id: ["uuid", "gen_random_uuid()", true], account_id: ["uuid", null, true], amount_cents: ["bigint", null, true],
    kind: ["text", null, true], status: ["text", "'available'::text", true], available_on: ["timestamp with time zone", null, false],
    stripe_object_id: ["text", null, false], idempotency_key: ["text", null, false], related_entry_id: ["uuid", null, false],
    created_at: ["timestamp with time zone", "now()", true],
  },
  lease_document_library: {
    id: ["uuid", "gen_random_uuid()", true], workspace_id: ["uuid", null, true], manager_user_id: ["uuid", null, true],
    name: ["text", null, true], storage_path: ["text", null, true], file_name: ["text", null, true],
    is_default: ["boolean", "false", true], fields: ["jsonb", "'[]'::jsonb", true],
    created_at: ["timestamp with time zone", "now()", true], updated_at: ["timestamp with time zone", "now()", true],
  },
  manager_vendor_preferences: {
    id: ["uuid", "gen_random_uuid()", true], manager_user_id: ["uuid", null, true], property_id: ["text", null, true],
    trade: ["text", null, true], vendor_id: ["text", null, true], priority: ["integer", "0", true],
    created_at: ["timestamp with time zone", "now()", true], updated_at: ["timestamp with time zone", "now()", true],
  },
  workspace_debit_consents: {
    workspace_id: ["uuid", null, true], consented_by: ["uuid", null, true],
    consented_at: ["timestamp with time zone", "now()", true], terms_version: ["text", null, true],
  },
  vendor_business_profiles: {
    trades: ["text[]", "'{}'::text[]", true], service_area_zips: ["text[]", "'{}'::text[]", true], service_radius_miles: ["integer", null, false],
    license_number: ["text", "''::text", true], license_doc_path: ["text", null, false], insurance_provider: ["text", "''::text", true],
    insurance_policy_number: ["text", "''::text", true], insurance_expires_at: ["date", null, false], insurance_doc_path: ["text", null, false],
    directory_listed: ["boolean", "false", true], onboarding_completed_at: ["timestamp with time zone", null, false],
  },
  vendor_invoices: { paid_from: ["text", null, false] },
  portal_workspaces: {
    stripe_connect_account_id: ["text", null, false], stripe_connect_charges_enabled: ["boolean", "false", true],
    stripe_connect_payouts_enabled: ["boolean", "false", true], payout_mode: ["text", "'manual'::text", true],
    auto_payout_switch_confirmed_at: ["timestamp with time zone", null, false],
  },
  work_order_bids: { open_listing_id: ["uuid", null, false] },
};
export const POLICIES = {
  vendor_reviews: [], proplane_balance_accounts: [], proplane_balance_entries: [], workspace_debit_consents: [],
  lease_document_library: [{ name: "lease_document_library_owner_read", command: "SELECT", roles: ["authenticated"], permissive: "PERMISSIVE", qual: "(EXISTS ( SELECT 1\n   FROM portal_workspaces w\n  WHERE ((w.id = lease_document_library.workspace_id) AND (w.owner_user_id = auth.uid()))))", check: null }],
  manager_vendor_preferences: [{ name: "manager_vendor_preferences_owner_read", command: "SELECT", roles: ["public"], permissive: "PERMISSIVE", qual: "(manager_user_id = auth.uid())", check: null }],
};
export const INDEXES = {
  vendor_reviews_vendor_user_id_idx: ["vendor_reviews", false, ["vendor_user_id"], null],
  vendor_reviews_manager_user_id_idx: ["vendor_reviews", false, ["manager_user_id"], null],
  vendor_reviews_reviewer_user_id_idx: ["vendor_reviews", false, ["reviewer_user_id"], null],
  vendor_business_profiles_directory_listed_idx: ["vendor_business_profiles", false, ["directory_listed"], "(directory_listed = true)"],
  proplane_balance_entries_account_status_idx: ["proplane_balance_entries", false, ["account_id", "status"], null],
  proplane_balance_entries_pending_available_on_idx: ["proplane_balance_entries", false, ["account_id", "available_on"], "(status = 'pending'::text)"],
  proplane_balance_withdrawal_claim_unique: ["proplane_balance_entries", true, ["account_id"], "((kind = 'withdrawal'::text) AND (stripe_object_id IS NULL))"],
  lease_document_library_default_per_workspace: ["lease_document_library", true, ["workspace_id"], "is_default"],
  lease_document_library_workspace_idx: ["lease_document_library", false, ["workspace_id"], null],
  manager_vendor_preferences_lookup_idx: ["manager_vendor_preferences", false, ["manager_user_id", "property_id", "trade", "priority"], null],
  portal_workspaces_stripe_connect_account_unique: ["portal_workspaces", true, ["stripe_connect_account_id"], "(stripe_connect_account_id IS NOT NULL)"],
  work_order_bids_open_listing_idx: ["work_order_bids", false, ["open_listing_id"], null],
};
export const FOREIGN_KEYS = {
  "proplane_balance_entries_related_entry_id_fkey": ["proplane_balance_entries", ["related_entry_id"], "proplane_balance_entries", ["id"], "n"],
  "work_order_bids_open_listing_id_fkey": ["work_order_bids", ["open_listing_id"], "work_order_open_listings", ["id"], "n"],
};
export const NEW_TABLE_CONSTRAINTS = {
  vendor_reviews: ["vendor_reviews_pkey", "vendor_reviews_manager_user_id_fkey", "vendor_reviews_reviewer_user_id_fkey", "vendor_reviews_vendor_user_id_fkey", "vendor_reviews_work_order_id_fkey", "vendor_reviews_stars_check", "vendor_reviews_body_check", "vendor_reviews_vendor_reply_check", "vendor_reviews_work_order_id_key"],
  proplane_balance_accounts: ["proplane_balance_accounts_pkey", "proplane_balance_accounts_owner_kind_check", "proplane_balance_accounts_owner_key_check", "proplane_balance_accounts_currency_check", "proplane_balance_accounts_owner_kind_owner_key_currency_key"],
  proplane_balance_entries: ["proplane_balance_entries_pkey", "proplane_balance_entries_account_id_fkey", "proplane_balance_entries_amount_cents_check", "proplane_balance_entries_kind_check", "proplane_balance_entries_status_check", "proplane_balance_entries_idempotency_key_key", "proplane_balance_entries_related_entry_id_fkey"],
  lease_document_library: ["lease_document_library_pkey", "lease_document_library_workspace_id_fkey", "lease_document_library_manager_user_id_fkey", "lease_document_library_name_check", "lease_document_library_storage_path_key"],
  manager_vendor_preferences: ["manager_vendor_preferences_pkey", "manager_vendor_preferences_manager_user_id_fkey", "manager_vendor_preferences_vendor_id_fkey", "manager_vendor_preferences_manager_user_id_property_id_trad_key"],
  workspace_debit_consents: ["workspace_debit_consents_pkey", "workspace_debit_consents_workspace_id_fkey", "workspace_debit_consents_consented_by_fkey"],
};
// Exact pg_get_constraintdef output from the September 26 staging rollback
// rehearsal of the pinned SQL. Ordered keys and full CHECK expressions matter.
export const KEY_CHECK_DEFINITIONS = {
  vendor_reviews_pkey: "PRIMARY KEY (id)",
  vendor_reviews_stars_check: "CHECK (((stars >= 1) AND (stars <= 5)))",
  vendor_reviews_body_check: "CHECK ((char_length(body) <= 2000))",
  vendor_reviews_vendor_reply_check: "CHECK (((vendor_reply IS NULL) OR (char_length(vendor_reply) <= 2000)))",
  vendor_reviews_work_order_id_key: "UNIQUE (work_order_id)",
  proplane_balance_accounts_pkey: "PRIMARY KEY (id)",
  proplane_balance_accounts_owner_kind_check: "CHECK ((owner_kind = ANY (ARRAY['workspace'::text, 'vendor'::text])))",
  proplane_balance_accounts_owner_key_check: "CHECK ((char_length(TRIM(BOTH FROM owner_key)) > 0))",
  proplane_balance_accounts_currency_check: "CHECK ((char_length(currency) = 3))",
  proplane_balance_accounts_owner_kind_owner_key_currency_key: "UNIQUE (owner_kind, owner_key, currency)",
  proplane_balance_entries_pkey: "PRIMARY KEY (id)",
  proplane_balance_entries_amount_cents_check: "CHECK ((amount_cents <> 0))",
  proplane_balance_entries_kind_check: "CHECK ((kind = ANY (ARRAY['resident_payment'::text, 'vendor_payment_out'::text, 'vendor_payment_in'::text, 'withdrawal'::text, 'withdrawal_reversal'::text, 'fee'::text, 'adjustment'::text])))",
  proplane_balance_entries_status_check: "CHECK ((status = ANY (ARRAY['pending'::text, 'available'::text])))",
  proplane_balance_entries_idempotency_key_key: "UNIQUE (idempotency_key)",
  lease_document_library_pkey: "PRIMARY KEY (id)",
  lease_document_library_name_check: "CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 120)))",
  lease_document_library_storage_path_key: "UNIQUE (storage_path)",
  manager_vendor_preferences_pkey: "PRIMARY KEY (id)",
  manager_vendor_preferences_manager_user_id_property_id_trad_key: "UNIQUE (manager_user_id, property_id, trade, vendor_id)",
  workspace_debit_consents_pkey: "PRIMARY KEY (workspace_id)",
};
const TABLE_FOREIGN_KEYS = {
  vendor_reviews: { manager_user_id: ["users", "auth", "id", "c"], reviewer_user_id: ["users", "auth", "id", "n"], vendor_user_id: ["users", "auth", "id", "c"], work_order_id: ["portal_work_order_records", "public", "id", "c"] },
  proplane_balance_entries: { account_id: ["proplane_balance_accounts", "public", "id", "c"], related_entry_id: ["proplane_balance_entries", "public", "id", "n"] },
  lease_document_library: { workspace_id: ["portal_workspaces", "public", "id", "c"], manager_user_id: ["users", "auth", "id", "c"] },
  manager_vendor_preferences: { manager_user_id: ["users", "auth", "id", "c"], vendor_id: ["manager_vendor_records", "public", "id", "c"] },
  workspace_debit_consents: { workspace_id: ["portal_workspaces", "public", "id", "c"], consented_by: ["profiles", "public", "id", "a"] },
};

export function parseOptions(argv) {
  const out = { phase: "preflight" };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (["--target", "--phase", "--backup-file"].includes(flag)) {
      if (!argv[i + 1] || argv[i + 1].startsWith("--") || seen.has(flag)) throw new Error(`Invalid or duplicate option: ${flag}`);
      seen.add(flag);
      out[flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
    } else if (flag === "--apply-authorized" && !out.applyAuthorized) out.applyAuthorized = true;
    else throw new Error(`Unknown or duplicate option: ${flag}`);
  }
  if (!Object.hasOwn(SMS_RELEASE_TARGETS, out.target) || !["preflight", "apply", "postflight", "rehearsal"].includes(out.phase)) throw new Error("Exact --target staging|production and valid --phase required");
  if (out.phase === "apply") {
    if (!out.applyAuthorized || !out.backupFile) throw new Error("Apply requires --apply-authorized and a fresh --backup-file");
    const file = resolve(out.backupFile);
    if (dirname(file) !== BACKUP_DIR || !basename(file).startsWith(`upstream-ten-gap-${out.target}-`) || !file.endsWith(".dump")) throw new Error("Backup path must be target-named under the private release-backups directory");
    out.backupFile = file;
  } else if (out.applyAuthorized || out.backupFile) throw new Error("Apply flags are invalid for read-only or rollback rehearsal phases");
  if (out.phase === "rehearsal" && out.target !== "staging") throw new Error("Rollback rehearsal is staging-only");
  return out;
}

export function reviewedMigrations() {
  return ENTRIES.map(([version, name, hash]) => {
    const sql = readFileSync(new URL(`../supabase/migrations/${version}_${name}.sql`, import.meta.url), "utf8");
    if (sha256(sql) !== hash) throw new Error(`Reviewed source changed: ${version}_${name}`);
    return { version, name, hash, sql };
  });
}

function expectedBody(sql) {
  const match = sql.match(/\bas \$\$([\s\S]*?)\$\$/i);
  if (!match) throw new Error("Reviewed function body missing");
  return match[1];
}

function assertLedgerRows(rows, migrations, applied) {
  const baselineRows = rows.filter((row) => row.version === BID_LINK_BASELINE.version || row.name === BID_LINK_BASELINE.name);
  if (baselineRows.length && (baselineRows.length !== 1 || baselineRows[0].version !== BID_LINK_BASELINE.version || baselineRows[0].name !== BID_LINK_BASELINE.name || !Array.isArray(baselineRows[0].statements) || baselineRows[0].statements.length !== 1 || sha256(baselineRows[0].statements[0]) !== BID_LINK_BASELINE.statementHash)) throw new Error("Earlier bid-link ledger identity differs from reviewed statement");
  const tenRows = rows.filter((row) => !baselineRows.includes(row));
  if (!applied && tenRows.length) throw new Error("Ten-gap ledger partly or fully present");
  if (applied && (tenRows.length !== migrations.length || migrations.some((m) => {
    const matches = tenRows.filter((row) => row.version === m.version && row.name === m.name);
    return matches.length !== 1 || !Array.isArray(matches[0].statements) || matches[0].statements.length !== 1 || sha256(matches[0].statements[0]) !== m.hash;
  }))) throw new Error("Ten-gap ledger differs from ten exact reviewed statements");
  return baselineRows.length === 1;
}

export function assertCatalogShape(snapshot, migrations, applied) {
  const earlierBidLink = assertLedgerRows(snapshot.ledger, migrations, applied);
  for (const name of PREREQUISITES) if (!snapshot.tables[name]?.exists) throw new Error(`Prerequisite table missing: ${name}`);
  for (const name of NEW_TABLES) {
    const table = snapshot.tables[name];
    if (Boolean(table?.exists) !== applied) throw new Error(`Ten-gap table state differs: ${name}`);
    if (!applied) continue;
    if (table.kind !== "r" || !table.rls) throw new Error(`Table RLS/type mismatch: ${name}`);
    const policies = (table.policies ?? []).map((p) => ({ ...p, roles: [...p.roles].sort() })).sort((a, b) => a.name.localeCompare(b.name));
    if (JSON.stringify(policies) !== JSON.stringify(POLICIES[name])) throw new Error(`Table policy mismatch: ${name}`);
    if (["proplane_balance_accounts", "proplane_balance_entries", "workspace_debit_consents"].includes(name) && (table.anonAccess || table.authAccess || !table.serviceAccess)) throw new Error(`Table ACL mismatch: ${name}`);
    if (name === "lease_document_library" && (table.anonAccess || !table.authSelect || table.authWrite || !table.serviceAccess)) throw new Error("Lease library ACL mismatch");
  }
  for (const [table, columns] of Object.entries(COLUMNS)) for (const [name, [type, defaultSql, required]] of Object.entries(columns)) {
    const column = snapshot.columns[`${table}.${name}`];
    if (!applied && column && !(earlierBidLink && table === "work_order_bids" && name === "open_listing_id" && column.type === type && column.default === defaultSql && column.notNull === required)) throw new Error(`Ten-gap column already exists or differs: ${table}.${name}`);
    if (!applied && earlierBidLink && table === "work_order_bids" && name === "open_listing_id" && !column) throw new Error("Earlier bid-link column missing");
    if (applied && (!column || column.type !== type || column.default !== defaultSql || column.notNull !== required)) throw new Error(`Ten-gap column differs: ${table}.${name}`);
  }
  if (applied) for (const table of NEW_TABLES) {
    const actual = Object.keys(snapshot.columns).filter((key) => key.startsWith(`${table}.`)).map((key) => key.slice(table.length + 1)).sort();
    if (JSON.stringify(actual) !== JSON.stringify(Object.keys(COLUMNS[table]).sort())) throw new Error(`Ten-gap table column roster differs: ${table}`);
    const constraints = snapshot.constraints[table] ?? [];
    if (JSON.stringify(constraints.map((c) => c.name).sort()) !== JSON.stringify([...NEW_TABLE_CONSTRAINTS[table]].sort()) || constraints.some((c) => !c.validated)) throw new Error(`Ten-gap constraint roster differs: ${table}`);
    for (const constraint of constraints) {
      if (constraint.type === "f") {
        const key = constraint.keys?.[0], expected = TABLE_FOREIGN_KEYS[table]?.[key];
        if (!expected || constraint.keys.length !== 1 || JSON.stringify([constraint.target, constraint.targetSchema, constraint.targetKeys?.[0], constraint.delete]) !== JSON.stringify(expected) || constraint.targetKeys.length !== 1) throw new Error(`Ten-gap table foreign key differs: ${table}.${key}`);
      } else {
        const expectedDefinition = KEY_CHECK_DEFINITIONS[constraint.name];
        const expectedType = constraint.name.endsWith("_pkey") ? "p" : constraint.name.endsWith("_key") ? "u" : "c";
        if (!expectedDefinition || constraint.type !== expectedType || constraint.definition !== expectedDefinition) throw new Error(`Ten-gap key/check definition differs: ${constraint.name}`);
      }
    }
  }
  for (const name of NEW_INDEXES) {
    const index = snapshot.indexes[name];
    const [table, unique, keys, predicate] = INDEXES[name];
    const expectedPresent = applied || (earlierBidLink && name === "work_order_bids_open_listing_idx");
    if (Boolean(index) !== expectedPresent || (expectedPresent && (index.kind !== "i" || !index.valid || !index.ready || index.table !== table || index.unique !== unique || index.method !== "btree" || JSON.stringify(index.keys) !== JSON.stringify(keys) || index.predicate !== predicate))) throw new Error(`Ten-gap index state differs: ${name}`);
  }
  const room = snapshot.functions[ROOM_FUNCTION];
  const oldRoom = expectedBody(readFileSync(new URL("../supabase/migrations/20260914120000_room_placement_name_fallback.sql", import.meta.url), "utf8"));
  const newRoom = expectedBody(migrations.find((m) => m.name === "room_placement_slot_suffix_fix").sql);
  if (!room || room.body !== (applied ? newRoom : oldRoom) || room.searchPath !== "search_path=\"\"" || room.securityDefiner || (room.returnType && room.returnType !== "text") || (room.language && room.language !== "plpgsql") || (room.volatility && room.volatility !== "i")) throw new Error("Room helper definition differs");
  for (const signature of BALANCE_FUNCTIONS) {
    const fn = snapshot.functions[signature];
    if (Boolean(fn) !== applied) throw new Error(`Balance function state differs: ${signature}`);
    if (applied && (!fn.securityDefiner || fn.searchPath !== "search_path=public, pg_temp" || fn.anonExecute || fn.authExecute || !fn.serviceExecute || JSON.stringify([fn.returnType, fn.language, fn.volatility]) !== JSON.stringify(FUNCTION_META[signature]) || fn.body !== expectedBody(migrations.find((m) => m.name === "proplane_balance_ledger").sql.match(new RegExp(`create or replace function public\\.${signature.split("(")[0]}\\([\\s\\S]*?\\$\\$[\\s\\S]*?\\$\\$`, "i"))?.[0] ?? ""))) throw new Error(`Balance function body/ACL mismatch: ${signature}`);
  }
  for (const signature of Object.keys(snapshot.functions)) if (signature !== ROOM_FUNCTION && !BALANCE_FUNCTIONS.includes(signature)) throw new Error(`Unexpected balance function overload: ${signature}`);
  if (applied) {
    for (const [name, expected] of Object.entries(FOREIGN_KEYS)) if (JSON.stringify(snapshot.fks[name]) !== JSON.stringify({ table: expected[0], keys: expected[1], target: expected[2], targetKeys: expected[3], delete: expected[4], validated: true })) throw new Error(`Ten-gap foreign key differs: ${name}`);
  } else {
    for (const [name, value] of Object.entries(snapshot.fks)) {
      const expected = FOREIGN_KEYS[name];
      const permitted = earlierBidLink && name === "work_order_bids_open_listing_id_fkey";
      if (Boolean(value) !== Boolean(permitted) || (permitted && JSON.stringify(value) !== JSON.stringify({ table: expected[0], keys: expected[1], target: expected[2], targetKeys: expected[3], delete: expected[4], validated: true }))) throw new Error(`Ten-gap foreign key already exists or differs: ${name}`);
    }
  }
  if (!applied && Object.values(snapshot.constraints ?? {}).some((rows) => rows.length)) throw new Error("Ten-gap table constraint already exists");
}

async function snapshot(client, migrations) {
  const versions = [...migrations.map((m) => m.version), BID_LINK_BASELINE.version], names = [...migrations.map((m) => m.name), BID_LINK_BASELINE.name];
  const ledger = (await client.query("select version,name,statements from supabase_migrations.schema_migrations where version=any($1::text[]) or name=any($2::text[]) order by version", [versions, names])).rows;
  const tableNames = [...new Set([...PREREQUISITES, ...NEW_TABLES])];
  const tables = Object.fromEntries(tableNames.map((name) => [name, { exists: false }]));
  const tableRows = (await client.query(`select c.relname name,c.relkind kind,c.relrowsecurity rls,
    has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') "anonAccess",
    has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') "authAccess",
    has_table_privilege('authenticated',c.oid,'SELECT') "authSelect",
    (has_table_privilege('authenticated',c.oid,'INSERT') or has_table_privilege('authenticated',c.oid,'UPDATE') or has_table_privilege('authenticated',c.oid,'DELETE')) "authWrite",
    (has_table_privilege('service_role',c.oid,'SELECT') and has_table_privilege('service_role',c.oid,'INSERT') and has_table_privilege('service_role',c.oid,'UPDATE') and has_table_privilege('service_role',c.oid,'DELETE')) "serviceAccess"
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any($1::text[])`, [tableNames])).rows;
  for (const row of tableRows) tables[row.name] = { ...row, exists: true, policies: [] };
  for (const row of (await client.query("select tablename,policyname name,cmd command,roles::text[] roles,permissive,qual,with_check \"check\" from pg_policies where schemaname='public' and tablename=any($1::text[])", [NEW_TABLES])).rows) tables[row.tablename].policies.push({ name: row.name, command: row.command, roles: row.roles, permissive: row.permissive, qual: row.qual, check: row.check });
  const columns = {};
  for (const row of (await client.query(`select c.relname table_name,a.attname name,format_type(a.atttypid,a.atttypmod) type,
    pg_get_expr(d.adbin,d.adrelid) default,a.attnotnull "notNull" from pg_attribute a
    join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
    left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
    where n.nspname='public' and c.relname=any($1::text[]) and a.attnum>0 and not a.attisdropped`, [Object.keys(COLUMNS)])).rows) columns[`${row.table_name}.${row.name}`] = row;
  const indexes = {};
  for (const row of (await client.query(`select c.relname name,c.relkind kind,i.indisvalid valid,i.indisready ready,
    t.relname "table",i.indisunique "unique",am.amname method,pg_get_expr(i.indpred,i.indrelid) predicate,
    array(select a.attname::text from unnest(i.indkey::int2[]) with ordinality k(attnum,ord) join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum order by k.ord) keys
    from pg_class c left join pg_index i on i.indexrelid=c.oid left join pg_class t on t.oid=i.indrelid
    left join pg_am am on am.oid=c.relam join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname=any($1::text[])`, [NEW_INDEXES])).rows) indexes[row.name] = row;
  const functions = {};
  for (const row of (await client.query(`select p.oid::regprocedure::text signature,p.prosrc body,p.prorettype::regtype::text "returnType",l.lanname language,p.provolatile volatility,
    p.prosecdef "securityDefiner",p.proconfig[1] "searchPath",
    has_function_privilege('anon',p.oid,'EXECUTE') "anonExecute",has_function_privilege('authenticated',p.oid,'EXECUTE') "authExecute",
    has_function_privilege('service_role',p.oid,'EXECUTE') "serviceExecute"
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang where n.nspname='public'
    and p.proname=any($1::text[])`, [[ROOM_FUNCTION, ...BALANCE_FUNCTIONS].map((name) => name.split("(")[0])])).rows) {
    const signature = row.signature.replace(/^public\./, "").replace(/, /g, ",");
    if (functions[signature]) throw new Error(`Function overload collision: ${signature}`);
    functions[signature] = row;
  }
  const fks = Object.fromEntries(Object.keys(FOREIGN_KEYS).map((name) => [name, null]));
  for (const row of (await client.query(`select con.conname,src.relname "table",dst.relname target,con.confdeltype "delete",con.convalidated validated,
    array(select a.attname::text from unnest(con.conkey) with ordinality k(attnum,ord) join pg_attribute a on a.attrelid=con.conrelid and a.attnum=k.attnum order by k.ord) keys,
    array(select a.attname::text from unnest(con.confkey) with ordinality k(attnum,ord) join pg_attribute a on a.attrelid=con.confrelid and a.attnum=k.attnum order by k.ord) "targetKeys"
    from pg_constraint con join pg_class src on src.oid=con.conrelid join pg_namespace sn on sn.oid=src.relnamespace
    join pg_class dst on dst.oid=con.confrelid join pg_namespace dn on dn.oid=dst.relnamespace
    where con.contype='f' and sn.nspname='public' and dn.nspname='public' and con.conname=any($1::text[])`, [Object.keys(FOREIGN_KEYS)])).rows) {
    if (fks[row.conname]) throw new Error(`Duplicate foreign key: ${row.conname}`);
    fks[row.conname] = { table: row.table, keys: row.keys, target: row.target, targetKeys: row.targetKeys, delete: row.delete, validated: row.validated };
  }
  const constraints = Object.fromEntries(NEW_TABLES.map((name) => [name, []]));
  for (const row of (await client.query(`select c.relname table_name,con.conname name,con.convalidated validated,con.contype type,pg_get_constraintdef(con.oid) definition,
    dst.relname target,dn.nspname "targetSchema",con.confdeltype "delete",
    array(select a.attname::text from unnest(con.conkey) with ordinality k(attnum,ord) join pg_attribute a on a.attrelid=con.conrelid and a.attnum=k.attnum order by k.ord) keys,
    array(select a.attname::text from unnest(con.confkey) with ordinality k(attnum,ord) join pg_attribute a on a.attrelid=con.confrelid and a.attnum=k.attnum order by k.ord) "targetKeys"
    from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace
    left join pg_class dst on dst.oid=con.confrelid left join pg_namespace dn on dn.oid=dst.relnamespace
    where n.nspname='public' and c.relname=any($1::text[])`, [NEW_TABLES])).rows) constraints[row.table_name].push(row);
  return { ledger, tables, columns, indexes, functions, fks, constraints };
}

export async function checkCatalog(client, migrations, applied) {
  const state = await snapshot(client, migrations);
  assertCatalogShape(state, migrations, applied);
  return sha256(JSON.stringify(state));
}

async function readOnly(client, migrations, applied) {
  await client.query("begin read only");
  try { await client.query("set local role postgres"); return await checkCatalog(client, migrations, applied); }
  finally { await client.query("rollback").catch(() => undefined); }
}

async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function applyReviewedMigrations(client, migrations) {
  for (const m of migrations) {
    await client.query(m.sql);
    await client.query("insert into supabase_migrations.schema_migrations(version,name,statements) values($1,$2,$3)", [m.version, m.name, [m.sql]]);
  }
}

export async function runTransaction(client, migrations, commit, expectedBeforeFingerprint) {
  await client.query("begin");
  let commitAttempted = false;
  try {
    await client.query("set local role postgres");
    await client.query("set local lock_timeout='5s'");
    await client.query("set local statement_timeout='30s'");
    const lock = (await client.query("select pg_try_advisory_xact_lock(20260925000000::bigint) acquired")).rows[0];
    if (!lock?.acquired) throw new Error("Ten-gap migration lock unavailable");
    const beforeFingerprint = await checkCatalog(client, migrations, false);
    if (expectedBeforeFingerprint && beforeFingerprint !== expectedBeforeFingerprint) throw new Error("Target catalog changed between preflight and locked operation");
    await applyReviewedMigrations(client, migrations);
    await checkCatalog(client, migrations, true);
    if (commit) { commitAttempted = true; await client.query("commit"); }
    else await client.query("rollback");
    return beforeFingerprint;
  } catch (error) {
    if (!commitAttempted) await client.query("rollback").catch(() => undefined);
    throw error;
  }
}

async function main() {
  const args = parseOptions(process.argv.slice(2));
  const migrations = reviewedMigrations();
  if (args.phase === "apply") {
    const parent = lstatSync(BACKUP_DIR);
    if (!parent.isDirectory() || (parent.mode & 0o777) !== 0o700) throw new Error("Private backup parent must exist with mode 0700");
  }
  const targetRef = SMS_RELEASE_TARGETS[args.target];
  const config = credential(targetRef);
  let client = await connect(config);
  try {
    if (args.phase === "postflight") {
      const catalogFingerprint = await readOnly(client, migrations, true);
      console.log(JSON.stringify({ target: args.target, targetRef, phase: args.phase, catalogFingerprint, verified: true }));
      return;
    }
    const beforeFingerprint = await readOnly(client, migrations, false);
    if (args.phase === "preflight") {
      console.log(JSON.stringify({ target: args.target, targetRef, phase: args.phase, beforeFingerprint, migrations: migrations.map(({ version, hash }) => ({ version, hash })), ready: true }));
      return;
    }
    let backupHash;
    if (args.phase === "apply") {
      backup(config, args.backupFile);
      if ((statSync(args.backupFile).mode & 0o777) !== 0o600) throw new Error("Backup permissions differ from 0600");
      backupHash = await hashFile(args.backupFile);
    }
    await runTransaction(client, migrations, args.phase === "apply", beforeFingerprint);
    if (args.phase === "rehearsal") {
      await readOnly(client, migrations, false);
      console.log(JSON.stringify({ target: args.target, targetRef, phase: args.phase, beforeFingerprint, rolledBack: true }));
      return;
    }
    await client.end();
    client = await connect(config);
    const catalogFingerprint = await readOnly(client, migrations, true);
    console.log(JSON.stringify({ target: args.target, targetRef, phase: args.phase, beforeFingerprint, backupFile: args.backupFile, backupHash, catalogFingerprint, outcome: "committed_and_verified" }));
  } finally { await client.end().catch(() => undefined); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`Ten-gap operation failed: ${error.message}. Inspect exact target read-only before retry if commit was attempted.`); process.exitCode = 1; });
}
