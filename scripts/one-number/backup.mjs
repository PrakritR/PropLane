#!/usr/bin/env node
/**
 * One-number migration step 1: back up what the later scripts mutate.
 *
 *   node --env-file=.env.local scripts/one-number/backup.mjs --target dev
 *   node scripts/one-number/backup.mjs --target production --env-file <prod env> --confirm-ref qahnczmilgptcedaqype
 *
 * READ-ONLY against the database; the only write is one timestamped JSON file under ~/.cockpit/backups/
 * (mode 0600: it contains phone numbers). A production `--apply` of backfill / cutover /
 * create-service-workspace requires a file from this script that is under two hours old.
 *
 * What it saves, and what rolls back from it:
 *   sms_runtime_config          full row (cutover --rollback restores line_mode from it)
 *   platform_service_settings   full rows
 *   portal_workspaces           the service owner's workspaces and every is_service workspace
 *   manager_sms_numbers, workspace_work_numbers   full rows (cutover never edits them; this is the number inventory)
 *   sms_phone_contacts, sms_projection_aliases    full rows (backfill inserts into them)
 *   sms_projection_conversations   ids and keys only (id, owner, role, work_line_id, identity_key, legacy key, workspace_id, line_kind)
 *   sms_consent                 full rows (global STOP / START ledger)
 *   sms_consent_events          ids only (backfill appends revoked events at the shared scope)
 *   unstamped.<table>           ids of rows whose workspace_id was NULL (stamping only ever fills NULLs)
 */
import { join } from "node:path";
import { chunk, countRows, fetchAll } from "./lib/db.mjs";
import { BACKUP_DIR, timestamp, writeJsonFile } from "./lib/files.mjs";
import { bootstrap, isMain, runMain } from "./lib/runtime.mjs";
import { STAMP_TABLES } from "./lib/stamp-plan.mjs";
import { BACKUP_KIND } from "./lib/target.mjs";

const SCRIPT = "backup";

export async function run(argv, deps = {}) {
  const { flags, resolved, db, log } = bootstrap(SCRIPT, argv, { strings: ["out"] }, { write: false, deps });
  const startedAt = new Date(deps.now ?? Date.now());
  const tables = {};
  const unstamped = {};
  const counts = {};
  const missing = [];

  const full = async (table, columns = "*", opts = {}) => {
    const { rows, missing: gone } = await fetchAll(db, table, columns, opts);
    if (gone) missing.push(table);
    tables[table] = rows;
    counts[table] = rows.length;
    return rows;
  };

  const config = await fetchAll(db, "sms_runtime_config", "*", { key: "singleton" });
  if (config.missing) missing.push("sms_runtime_config");
  tables.sms_runtime_config = config.rows;
  counts.sms_runtime_config = config.rows.length;

  const settings = await fullSettings(db, missing);
  tables.platform_service_settings = settings;
  counts.platform_service_settings = settings.length;

  const owner = settings[0]?.owner_user_id ?? null;
  const byId = new Map();
  const flagged = await fetchAll(db, "portal_workspaces", "*", { filter: (q) => q.eq("is_service", true) });
  for (const row of flagged.rows) byId.set(row.id, row);
  if (owner) {
    // Also the service owner's own workspaces (before the W15 migration there is no is_service column).
    const owned = await fetchAll(db, "portal_workspaces", "*", { filter: (q) => q.eq("owner_user_id", owner) });
    for (const row of owned.rows) byId.set(row.id, row);
  }
  tables.portal_workspaces_service = [...byId.values()];
  counts.portal_workspaces_service = tables.portal_workspaces_service.length;

  await full("manager_sms_numbers", "*", { key: "id" });
  await full("workspace_work_numbers", "*", { key: "number_id", offsetPaging: true });
  await full("sms_phone_contacts", "*", { key: "phone_e164" });
  await full("sms_projection_aliases", "*", { key: "id" });
  await full(
    "sms_projection_conversations",
    "id, owner_manager_user_id, counterparty_role, work_line_id, identity_key, legacy_conversation_key, workspace_id, line_kind, merged_into_id",
    { key: "id" },
  );
  await full("sms_consent", "*", { key: "phone" });
  const events = await fetchAll(db, "sms_consent_events", "id", { key: "id" });
  if (events.missing) missing.push("sms_consent_events");
  tables.sms_consent_event_ids = events.rows.map((r) => r.id);
  counts.sms_consent_events = events.rows.length;

  for (const spec of STAMP_TABLES) {
    const result = await fetchAll(db, spec.table, spec.key, { key: spec.key, filter: (q) => q.is("workspace_id", null) });
    if (result.missing) {
      missing.push(spec.table);
      unstamped[spec.table] = [];
    } else {
      unstamped[spec.table] = result.rows.map((r) => r[spec.key]);
    }
    const total = await countRows(db, spec.table);
    counts[spec.table] = total.count;
    counts[`${spec.table}.unstamped`] = unstamped[spec.table].length;
  }

  const meta = {
    kind: BACKUP_KIND,
    target: resolved.target,
    ref: resolved.ref,
    createdAt: startedAt.toISOString(),
    complete: true,
    counts,
    missingTables: [...new Set(missing)],
  };
  const path = flags.out ?? join(BACKUP_DIR, `one-number-${resolved.target}-${timestamp(startedAt)}.json`);
  (deps.writeFile ?? writeJsonFile)(path, { meta, tables, unstamped });
  log(`${SCRIPT}: wrote ${path}`);
  for (const [name, n] of Object.entries(counts)) log(`${SCRIPT}:   ${name} = ${n}`);
  if (meta.missingTables.length) log(`${SCRIPT}: not migrated here (skipped): ${meta.missingTables.join(", ")}`);
  log(`${SCRIPT}: use it with --backup ${path}`);
  return 0;
}

async function fullSettings(db, missing) {
  const result = await fetchAll(db, "platform_service_settings", "*", { key: "owner_user_id" });
  if (result.missing) missing.push("platform_service_settings");
  return result.rows;
}

export { chunk };

if (isMain(import.meta.url)) await runMain(SCRIPT, () => run(process.argv.slice(2)));
