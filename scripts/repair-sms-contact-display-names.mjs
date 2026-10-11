#!/usr/bin/env node
/**
 * Clear the junk names an old text-name guess stored, in both places it landed
 * (sms-contact-names-1011):
 *
 *   * `manager_sms_contacts.display_name` - the Communication list title;
 *   * an SMS lead's own `row_data.name` on `manager_application_records`
 *     (Residents > Potential), which is reset to the formatted phone number
 *     because that row must carry some name.
 *
 *   npx tsx --conditions=react-server --env-file=.env.local \
 *     scripts/repair-sms-contact-display-names.mjs --project-ref <ref> \
 *     [--dry-run | --apply --backup-dir <dir>] [--allow-project <ref>]
 *
 * "Hi I'm looking for a room" saved the phrase "looking for" as a prospect's
 * name, and a first text from an unknown number saved its own formatted phone
 * as a name. A name now comes only from an explicit self-introduction or a real
 * record; this clears a stored name that is a bare phone number, a generated
 * "<trade> · <number>" label, or nothing but stop-words
 * (`contactNameRepairVerdict`). The list then shows the formatted number until
 * the person (or a record) supplies a name.
 *
 * Deliberately narrow, because it DELETES manager-visible data: anything a
 * manager could plausibly have typed is kept ("Maya West", "Joe's Plumbing
 * 24/7", "Unit 4"), as is a blank and a name that matches an active row on the
 * same manager's Vendors list.
 *
 * Safety (same pattern as merge-assistant-team-threads.mjs):
 *   - DRY RUN is the default: prints every row it would clear, writes nothing.
 *   - `--project-ref <ref>` is REQUIRED and must equal NEXT_PUBLIC_SUPABASE_URL's project.
 *   - `--apply` refuses any project but dev/test unless `--allow-project <ref>`
 *     repeats the ref (staging / production run at the captain's promote).
 *   - `--apply` needs `--backup-dir`; every row it clears is dumped there first.
 *   - Each write is compare-and-set on `updated_at` and only touches display_name.
 */
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contactNameRepairVerdict } from "../src/lib/sms/contact-name.ts";
import { formatSmsPhoneLabel } from "../src/lib/phone-e164.ts";

const DEV_PROJECT_REF = "emstjswhotsnyksqhqyf";
const PAGE = 500;

export function parseArgs(argv) {
  const args = { apply: false, projectRef: null, backupDir: null, allowProject: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--dry-run") args.apply = false;
    else if (arg === "--project-ref") args.projectRef = argv[++i];
    else if (arg === "--backup-dir") args.backupDir = argv[++i];
    else if (arg === "--allow-project") args.allowProject = argv[++i];
    else if (arg === "--help") args.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!args.help && !args.projectRef) throw new Error("--project-ref <ref> is required");
  if (args.apply && !args.backupDir) throw new Error("--apply requires --backup-dir so every touched row is dumped first");
  return args;
}

export function projectRefFromUrl(url) {
  const match = /^https:\/\/([a-z0-9]+)\.supabase\.co/i.exec(String(url ?? "").trim());
  return match ? match[1] : "";
}

/** Throws unless the env's project is the one named, and (for --apply) dev/test or explicitly allowed. */
export function assertProjectAllowed({ url, projectRef, apply, allowProject }) {
  const actual = projectRefFromUrl(url);
  if (!actual) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not a Supabase project URL");
  if (actual !== projectRef) {
    throw new Error(`Refusing: --project-ref ${projectRef} does not match the environment's project ${actual}.`);
  }
  if (apply && actual !== DEV_PROJECT_REF && allowProject !== actual) {
    throw new Error(`Refusing --apply on project ${actual}; pass --allow-project ${actual} only at the captain's promote.`);
  }
  return actual;
}

/**
 * Pure planner: which contact rows lose their display_name.
 * `vendorNamesByManager`: Map<managerUserId, Set<lowercased active vendor name>>.
 */
export function planDisplayNameRepair(rows, vendorNamesByManager = new Map()) {
  const clear = [];
  let kept = 0;
  let blank = 0;
  for (const row of rows) {
    const name = String(row.display_name ?? "").trim();
    if (!name) {
      blank += 1;
      continue;
    }
    const verdict = contactNameRepairVerdict(name);
    if (verdict.keep) {
      kept += 1;
      continue;
    }
    if (vendorNamesByManager.get(String(row.manager_user_id))?.has(name.toLowerCase())) {
      kept += 1;
      continue;
    }
    clear.push({ row, reason: verdict.reason });
  }
  return { clear, kept, blank };
}

/**
 * Pure planner: which SMS-lead rows lose their guessed `row_data.name`.
 *
 * A Potential-resident row has to carry a name, so the guess is replaced with the formatted phone
 * number - exactly what a lead created today is named. A row with no usable phone is left alone
 * rather than given a blank name.
 */
export function planLeadNameRepair(rows) {
  const rename = [];
  let kept = 0;
  let skipped = 0;
  for (const row of rows) {
    const data = row.row_data && typeof row.row_data === "object" ? row.row_data : null;
    const name = String(data?.name ?? "").trim();
    if (!name) {
      kept += 1;
      continue;
    }
    const verdict = contactNameRepairVerdict(name);
    if (verdict.keep) {
      kept += 1;
      continue;
    }
    const phone = String(data?.phone ?? "").trim();
    const replacement = (phone && (formatSmsPhoneLabel(phone) || phone)) || "";
    if (!replacement || replacement === name) {
      skipped += 1;
      continue;
    }
    rename.push({ row, name, replacement, reason: verdict.reason });
  }
  return { rename, kept, skipped };
}

async function withRetry(run, label) {
  let last = null;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const { data, error } = await run();
    if (!error) return data ?? [];
    last = error;
    await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
  }
  throw new Error(`${label}: ${last?.message ?? "read failed"}`);
}

async function loadContacts(db) {
  const rows = [];
  let lastId = "";
  for (;;) {
    const data = await withRetry(() => {
      let query = db
        .from("manager_sms_contacts")
        .select("id, manager_user_id, phone_e164, counterparty_role, display_name, updated_at")
        .not("display_name", "is", null)
        .order("id", { ascending: true })
        .limit(PAGE);
      if (lastId) query = query.gt("id", lastId);
      return query;
    }, "manager_sms_contacts");
    if (!data.length) break;
    rows.push(...data);
    lastId = data[data.length - 1].id;
    if (data.length < PAGE) break;
  }
  return rows;
}

/** Every SMS-lead application row (`row_data.smsLead === true`), the Potential-resident plumbing row. */
async function loadSmsLeadRows(db) {
  const rows = [];
  let lastId = "";
  for (;;) {
    const data = await withRetry(() => {
      let query = db
        .from("manager_application_records")
        .select("id, manager_user_id, row_data, updated_at")
        .eq("row_data->>smsLead", "true")
        .order("id", { ascending: true })
        .limit(PAGE);
      if (lastId) query = query.gt("id", lastId);
      return query;
    }, "manager_application_records");
    if (!data.length) break;
    rows.push(...data);
    lastId = data[data.length - 1].id;
    if (data.length < PAGE) break;
  }
  return rows;
}

async function loadVendorNames(db, managerIds) {
  const out = new Map();
  for (const managerId of managerIds) {
    const data = await withRetry(
      () => db.from("manager_vendor_records").select("row_data").eq("manager_user_id", managerId).limit(2000),
      "manager_vendor_records",
    );
    const names = new Set();
    for (const record of data) {
      const row = record.row_data ?? {};
      const name = String(row.name ?? "").trim().toLowerCase();
      if (name && row.active !== false) names.add(name);
    }
    out.set(managerId, names);
  }
  return out;
}

const mask = (phone) => String(phone).replace(/^(\+\d{1,3})\d{4,}(\d{2})$/, "$1******$2");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: repair-sms-contact-display-names.mjs --project-ref <ref> [--dry-run | --apply --backup-dir <dir>] [--allow-project <ref>]");
    return 0;
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  const ref = assertProjectAllowed({ url, projectRef: args.projectRef, apply: args.apply, allowProject: args.allowProject });
  console.log(`sms contact display-name repair - project ${ref} - ${args.apply ? "APPLY" : "DRY RUN (nothing is written)"}`);
  const db = createClient(url, key, { auth: { persistSession: false } });

  const rows = await loadContacts(db);
  const failing = rows.filter((row) => !contactNameRepairVerdict(row.display_name).keep);
  const vendorNames = await loadVendorNames(db, [...new Set(failing.map((row) => String(row.manager_user_id)))]);
  const plan = planDisplayNameRepair(rows, vendorNames);

  console.log(`named contacts scanned: ${rows.length}; kept: ${plan.kept}; to clear: ${plan.clear.length}`);
  const byReason = new Map();
  for (const { row, reason } of plan.clear) {
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
    console.log(`   clear ${String(row.manager_user_id).slice(0, 8)} ${mask(row.phone_e164)} ${row.counterparty_role}: ${JSON.stringify(row.display_name)} (${reason})`);
  }
  for (const [reason, count] of byReason) console.log(`   ${count} x ${reason}`);

  const leadRows = await loadSmsLeadRows(db);
  const leadPlan = planLeadNameRepair(leadRows);
  console.log(`\nsms lead rows scanned: ${leadRows.length}; kept: ${leadPlan.kept}; no phone to fall back to: ${leadPlan.skipped}; to rename: ${leadPlan.rename.length}`);
  for (const { row, name, replacement, reason } of leadPlan.rename) {
    console.log(`   rename ${String(row.manager_user_id).slice(0, 8)} ${row.id}: ${JSON.stringify(name)} -> ${JSON.stringify(replacement)} (${reason})`);
  }

  if (!args.apply) {
    console.log("\nDry run only: no row was changed. Re-run with --apply --backup-dir <dir> to write.");
    return 0;
  }
  if (plan.clear.length === 0 && leadPlan.rename.length === 0) {
    console.log("\nNothing to apply.");
    return 0;
  }
  mkdirSync(args.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(args.backupDir, `sms-contact-display-names-${ref}-${stamp}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        projectRef: ref,
        createdAt: new Date().toISOString(),
        rows: plan.clear.map((entry) => entry.row),
        // Only the one field each lead row loses, never its sealed row_data.
        leadRows: leadPlan.rename.map(({ row, name, replacement }) => ({
          id: row.id,
          managerUserId: row.manager_user_id,
          name,
          replacement,
          updatedAt: row.updated_at,
        })),
      },
      null,
      2,
    ),
  );
  console.log(`\nbackup: ${plan.clear.length} contact row(s) + ${leadPlan.rename.length} lead row(s) -> ${file}`);

  let raced = 0;
  for (const { row } of plan.clear) {
    const { data, error } = await db
      .from("manager_sms_contacts")
      .update({ display_name: null, updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("updated_at", row.updated_at)
      .select("id");
    if (error) throw new Error(`update ${row.id}: ${error.message}`);
    if (!data?.length) {
      raced += 1;
      console.log(`   RACED ${row.id} (changed mid-run; run again to pick it up)`);
    }
  }
  console.log(`\ncleared ${plan.clear.length - raced} of ${plan.clear.length} contact row(s); raced ${raced}`);

  let leadRaced = 0;
  for (const { row, replacement } of leadPlan.rename) {
    // Only `name` moves: the rest of row_data (including the sealed applicant identity) is written back as read.
    const { data, error } = await db
      .from("manager_application_records")
      .update({ row_data: { ...row.row_data, name: replacement }, updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("updated_at", row.updated_at)
      .select("id");
    if (error) throw new Error(`update lead ${row.id}: ${error.message}`);
    if (!data?.length) {
      leadRaced += 1;
      console.log(`   RACED lead ${row.id} (changed mid-run; run again to pick it up)`);
    }
  }
  console.log(`renamed ${leadPlan.rename.length - leadRaced} of ${leadPlan.rename.length} lead row(s); raced ${leadRaced}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
