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
 *
 * With --owner-email <email> it also saves what move-houses-to-service.mjs touches for that one owner (W22):
 *   move.profile                the owner's id / email / name / manager_id / sms_from_number
 *   move.portal_workspaces      all of the owner's workspaces (full rows)
 *   move.manager_property_records   every house in them (full rows)
 *   move.account_link_invites   every membership of those workspaces, any status (full rows)
 *   move.manager_assistant_emails   the workspaces' work emails (full rows)
 *   move.owners.<table>         id + owner column + house column of every row the app's transfer re-keys for those houses
 * and records meta.move = { ownerEmail, workspaceIds }; a production move refuses a backup without it.
 */
import { join } from "node:path";
import { chunk, countRows, fetchAll } from "./lib/db.mjs";
import { BACKUP_DIR, timestamp, writeJsonFile } from "./lib/files.mjs";
import { bootstrap, isMain, runMain } from "./lib/runtime.mjs";
import { STAMP_TABLES } from "./lib/stamp-plan.mjs";
import { MOVED_ASSIGNED_TABLES, MOVED_PROPERTY_TABLES } from "./lib/move-plan.mjs";
import { BACKUP_KIND } from "./lib/target.mjs";

const SCRIPT = "backup";

export async function run(argv, deps = {}) {
  const { flags, resolved, db, log } = bootstrap(SCRIPT, argv, { strings: ["out", "owner-email"] }, { write: false, deps });
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

  let move = null;
  if (flags["owner-email"]) move = await moveSection(db, flags["owner-email"], tables, counts, missing);

  const meta = {
    kind: BACKUP_KIND,
    target: resolved.target,
    ref: resolved.ref,
    createdAt: startedAt.toISOString(),
    complete: true,
    counts,
    missingTables: [...new Set(missing)],
    ...(move ? { move } : {}),
  };
  const path = flags.out ?? join(BACKUP_DIR, `one-number-${resolved.target}-${timestamp(startedAt)}.json`);
  (deps.writeFile ?? writeJsonFile)(path, { meta, tables, unstamped });
  log(`${SCRIPT}: wrote ${path}`);
  for (const [name, n] of Object.entries(counts)) log(`${SCRIPT}:   ${name} = ${n}`);
  if (meta.missingTables.length) log(`${SCRIPT}: not migrated here (skipped): ${meta.missingTables.join(", ")}`);
  log(`${SCRIPT}: use it with --backup ${path}`);
  return 0;
}

/** The rows move-houses-to-service.mjs touches for one owner. Adds `tables.move_*` and returns meta.move. */
async function moveSection(db, ownerEmail, tables, counts, missing) {
  const wanted = String(ownerEmail).trim().toLowerCase();
  const found = await db.from("profiles").select("id, email, full_name, manager_id, sms_from_number").ilike("email", wanted);
  if (found.error) throw new Error(`profiles: ${found.error.message}`);
  const owners = (found.data ?? []).filter((r) => String(r.email ?? "").trim().toLowerCase() === wanted);
  if (owners.length !== 1) throw new Error(`--owner-email ${wanted}: expected exactly one account, found ${owners.length}`);
  const owner = owners[0];
  const keep = async (name, table, columns, opts) => {
    const { rows, missing: gone } = await fetchAll(db, table, columns, opts);
    if (gone) missing.push(table);
    tables[name] = rows;
    counts[name] = rows.length;
    return rows;
  };
  tables.move_profile = [owner];
  const workspaces = await keep("move_portal_workspaces", "portal_workspaces", "*", { filter: (q) => q.eq("owner_user_id", owner.id) });
  const ids = workspaces.map((w) => w.id);
  const houses = ids.length ? await keep("move_manager_property_records", "manager_property_records", "*", { filter: (q) => q.in("workspace_id", ids) }) : [];
  if (!ids.length) {
    tables.move_manager_property_records = [];
    counts.move_manager_property_records = 0;
  }
  tables.move_account_link_invites = [];
  tables.move_manager_assistant_emails = [];
  if (ids.length) {
    await keep("move_account_link_invites", "account_link_invites", "*", { filter: (q) => q.in("workspace_id", ids) });
    await keep("move_manager_assistant_emails", "manager_assistant_emails", "*", { filter: (q) => q.in("workspace_id", ids) });
  }
  const houseIds = houses.map((h) => h.id);
  tables.move_owners = {};
  const rekeyed = [
    ...MOVED_PROPERTY_TABLES.map((table) => [table, "property_id"]),
    ...MOVED_ASSIGNED_TABLES.map((table) => [table, "assigned_property_id"]),
  ];
  for (const [table, prop] of rekeyed) {
    const rows = [];
    for (const batch of chunk(houseIds, 50)) {
      const res = await fetchAll(db, table, `id, manager_user_id, ${prop}`, { key: prop, offsetPaging: true, filter: (q) => q.in(prop, batch) });
      if (res.missing) {
        missing.push(table);
        break;
      }
      rows.push(...res.rows);
    }
    tables.move_owners[`${table}#${prop}`] = rows;
    counts[`move_owners.${table}#${prop}`] = rows.length;
  }
  return { ownerEmail: owner.email, ownerUserId: owner.id, workspaceIds: ids };
}

async function fullSettings(db, missing) {
  const result = await fetchAll(db, "platform_service_settings", "*", { key: "owner_user_id" });
  if (result.missing) missing.push("platform_service_settings");
  return result.rows;
}

export { chunk };

if (isMain(import.meta.url)) await runMain(SCRIPT, () => run(process.argv.slice(2)));
