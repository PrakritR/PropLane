#!/usr/bin/env node
/**
 * Merge the duplicate application DRAFTS one person left for one house.
 *
 * "One application per person per house" is enforced on write now (POST /api/manager-applications folds a
 * second draft into the open application). This cleans up what was written before that: for every
 * applicant + house with several OPEN applications it keeps the most complete one and archives the extra
 * drafts. Nothing is deleted.
 *
 *   - Only OPEN rows are considered (pending, not withdrawn, not already merged, not hand-added).
 *     Approved and declined rows are never touched.
 *   - The applicant is the row's `residentUserId` when it carries one, else its email (guest rows only):
 *     a guest row is never grouped with an account's, and two accounts sharing an email are two people.
 *   - A SUBMITTED application is never archived (two sent applications for two rooms are legitimate; the
 *     same room twice is refused by the server). It is the row a draft folds into. A legacy row carrying
 *     no stage at all is not provably unsent, so it counts as sent here and is never withdrawn.
 *   - Among drafts the kept one is: most wizard steps/answers, then newest.
 *   - An archived draft keeps its row and gets `withdrawnAt` (so it leaves every list), `mergedInto` (the
 *     kept row's id) and `mergedAt`. Nothing else in the row changes.
 *
 * Dry run by default: prints the groups and what would change. `--apply` writes, after saving a JSON
 * snapshot of every row it will touch (the kept row and the extras, exactly as stored).
 *
 *   node --env-file=.env.local scripts/merge-duplicate-application-drafts.mjs
 *   node --env-file=.env.local scripts/merge-duplicate-application-drafts.mjs --apply
 *
 * Environment: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY.
 * Target: the dev/test project by default. Production (qahnczmilgptcedaqype) is refused unless
 * `--confirm-production` is also passed; any other project is refused. Flags: --apply,
 * --confirm-production, --snapshot <file>, --property <propertyId>.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEV_PROJECT_REF = "emstjswhotsnyksqhqyf";
export const PRODUCTION_PROJECT_REF = "qahnczmilgptcedaqype";

const DRAFT_STAGES = new Set(["in progress", "incomplete", "draft", "started"]);

export function projectRefFromUrl(rawUrl) {
  try {
    const host = new URL(rawUrl).host;
    const hosted = /^([a-z0-9-]+)\.supabase\.(co|in|red)$/i.exec(host);
    return hosted ? hosted[1].toLowerCase() : host;
  } catch {
    return "";
  }
}

/** `{ ok, reason }`: dev always, production only with the explicit flag, everything else refused. */
export function checkTarget(ref, { confirmProduction = false } = {}) {
  if (!ref) return { ok: false, reason: "Could not read a project ref from the Supabase URL." };
  if (ref === DEV_PROJECT_REF) return { ok: true, reason: "dev/test project" };
  if (ref === PRODUCTION_PROJECT_REF) {
    return confirmProduction
      ? { ok: true, reason: "PRODUCTION (confirmed)" }
      : { ok: false, reason: "That is the production project. Pass --confirm-production to run against it." };
  }
  return { ok: false, reason: `Unknown project ${ref}: this script runs on dev (${DEV_PROJECT_REF}) or confirmed production only.` };
}

const clean = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * A PROVABLY UNSENT draft: pending with an explicit unsent stage. This is what gets archived, so it mirrors
 * the server's `isUnsubmittedDraftApplicationRow`, not the wider `isDraftShapedApplicationRow`: a legacy
 * stage-less row carrying wizard data is not provably unsent, so it is never withdrawn — it is treated as a
 * sent application the drafts fold into instead.
 */
export function isDraftRow(row) {
  if (!row || row.bucket !== "pending" || row.manuallyAdded === true) return false;
  return DRAFT_STAGES.has(clean(row.stage).toLowerCase());
}

/** Pending, not withdrawn, not already merged away, not a row a manager typed in. */
export function isOpenRow(row) {
  if (!row || row.bucket !== "pending") return false;
  if (clean(row.withdrawnAt)) return false;
  if (row.mergedInto) return false;
  if (row.manuallyAdded === true || row.bookingResidency === true || row.smsLead === true) return false;
  return true;
}

export function houseKey(record) {
  const row = record.row_data ?? {};
  return clean(record.property_id) || clean(row.propertyId) || clean(row.assignedPropertyId) || clean(row.application?.propertyId);
}

/**
 * Who the row belongs to. The Auth SUBJECT wins whenever the row carries one, exactly as the write
 * path's dedupe decides it (`selectOpenApplicationMatch`: "an email is never enough"): two accounts
 * that share an email are two people, and an account row is never the same applicant as a guest row
 * whose email was only typed. An email keys guest rows alone.
 */
export function applicantKey(record) {
  const row = record.row_data ?? {};
  const user = clean(row.residentUserId);
  if (user) return `user:${user}`;
  const email = clean(row.email || record.resident_email).toLowerCase();
  return email ? `guest:${email}` : "";
}

/** Answers filled in, and the furthest wizard step: how complete a draft is. */
export function completeness(record) {
  const app = record.row_data?.application ?? {};
  let filled = 0;
  for (const value of Object.values(app)) {
    if (value === undefined || value === null || value === "" || value === false) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    filled += 1;
  }
  const step = Math.max(Number(app.wizardMaxStepReached) || 0, Number(app.wizardStep) || 0);
  return { step, filled };
}

const updatedMs = (record) => Date.parse(record.updated_at ?? "") || 0;

/** Best draft first: furthest step, then most answers, then newest. */
export function compareDrafts(a, b) {
  const ca = completeness(a);
  const cb = completeness(b);
  return cb.step - ca.step || cb.filled - ca.filled || updatedMs(b) - updatedMs(a) || String(a.id).localeCompare(String(b.id));
}

const roomOf = (record) => clean(record.row_data?.application?.roomChoice1);

/**
 * Group the open rows by applicant + house and decide what to keep.
 * Returns one entry per group that needs work: `{ key, kept, archive, reason, siblings }`.
 * `siblings` lists approved/declined rows of the same applicant + house (reported, never touched).
 */
export function planMerges(records) {
  const groups = new Map();
  const decided = new Map();
  for (const record of records) {
    const person = applicantKey(record);
    const house = houseKey(record);
    if (!person || !house) continue;
    const key = `${person}|${house}`;
    const row = record.row_data ?? {};
    if (row.bucket === "approved" || row.bucket === "rejected") {
      decided.set(key, [...(decided.get(key) ?? []), record]);
      continue;
    }
    if (!isOpenRow(row)) continue;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }

  const plans = [];
  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    const submitted = members.filter((m) => !isDraftRow(m.row_data)).sort((a, b) => updatedMs(a) - updatedMs(b));
    const drafts = members.filter((m) => isDraftRow(m.row_data)).sort(compareDrafts);
    if (drafts.length === 0) continue;
    const siblings = (decided.get(key) ?? []).map((m) => ({ id: m.id, bucket: m.row_data?.bucket }));

    // A sent application for the same house (and the same room, or no room named) already covers the drafts.
    const coveringFor = (draft) =>
      submitted.find((sent) => !roomOf(draft) || !roomOf(sent) || roomOf(sent) === roomOf(draft));
    const toArchive = [];
    let keptDraft = null;
    for (const draft of drafts) {
      const cover = coveringFor(draft);
      if (cover) {
        toArchive.push({ record: draft, mergedInto: cover.id });
        continue;
      }
      if (!keptDraft) {
        keptDraft = draft;
        continue;
      }
      toArchive.push({ record: draft, mergedInto: keptDraft.id });
    }
    if (toArchive.length === 0) continue;
    plans.push({
      key,
      kept: submitted[0] ?? keptDraft,
      keptIsSubmitted: submitted.length > 0,
      archive: toArchive,
      siblings,
      reason: submitted.length > 0 ? "a sent application covers the drafts" : "most complete draft kept",
    });
  }
  return plans;
}

/** The row_data an archived draft is written with: the stored row plus the three merge fields, nothing else. */
export function archivedRowData(rowData, mergedInto, nowIso) {
  return { ...rowData, withdrawnAt: nowIso, mergedInto, mergedAt: nowIso };
}

function parseArgs(argv) {
  const args = { apply: false, confirmProduction: false, snapshot: "", property: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--confirm-production") args.confirmProduction = true;
    else if (arg === "--snapshot") args.snapshot = argv[++i] ?? "";
    else if (arg === "--property") args.property = argv[++i] ?? "";
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

async function loadOpenRecords(db, property) {
  const out = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    let query = db
      .from("manager_application_records")
      .select("id, row_data, resident_email, property_id, manager_user_id, updated_at")
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (property) query = query.eq("property_id", property);
    const { data, error } = await query;
    if (error) throw new Error(`Could not read applications: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "").trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key) {
    console.error("Set NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(2);
  }
  const ref = projectRefFromUrl(url);
  const target = checkTarget(ref, { confirmProduction: args.confirmProduction });
  if (!target.ok) {
    console.error(`Refusing to run: ${target.reason}`);
    process.exit(2);
  }
  console.log(`Target: ${ref} (${target.reason}). ${args.apply ? "APPLY" : "Dry run"}.`);

  const { createClient } = await import("@supabase/supabase-js");
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const records = await loadOpenRecords(db, clean(args.property));
  const plans = planMerges(records);

  const extras = plans.reduce((n, plan) => n + plan.archive.length, 0);
  console.log(`${records.length} applications read. ${plans.length} applicant+house groups with duplicate drafts, ${extras} extra drafts.`);
  for (const plan of plans) {
    console.log(`\n${plan.key}  (${plan.reason})`);
    console.log(`  keep     ${plan.kept.id}  ${plan.keptIsSubmitted ? "submitted" : "draft"}  ${JSON.stringify(completeness(plan.kept))}`);
    for (const item of plan.archive) {
      console.log(`  archive  ${item.record.id}  -> ${item.mergedInto}  ${JSON.stringify(completeness(item.record))}`);
    }
    for (const sibling of plan.siblings) console.log(`  note     ${sibling.id} is ${sibling.bucket} (not touched)`);
  }
  if (!args.apply) {
    console.log("\nDry run: nothing written. Re-run with --apply to archive the extras.");
    return;
  }
  if (extras === 0) {
    console.log("Nothing to do.");
    return;
  }

  const touched = new Map();
  for (const plan of plans) {
    touched.set(plan.kept.id, plan.kept);
    for (const item of plan.archive) touched.set(item.record.id, item.record);
  }
  const snapshotPath =
    args.snapshot || path.join(os.tmpdir(), `application-draft-merge-${ref}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.mkdirSync(path.dirname(path.resolve(snapshotPath)), { recursive: true });
  // Whole application rows: names, emails, phones, income. Owner-only, and chmod as well as `mode`
  // because `mode` is ignored when the file already exists.
  fs.writeFileSync(snapshotPath, JSON.stringify({ ref, takenAt: new Date().toISOString(), records: [...touched.values()] }, null, 2), { mode: 0o600 });
  fs.chmodSync(snapshotPath, 0o600);
  console.log(`\nSnapshot of ${touched.size} rows written to ${snapshotPath}`);

  const nowIso = new Date().toISOString();
  let archived = 0;
  let skipped = 0;
  for (const plan of plans) {
    for (const item of plan.archive) {
      const { record } = item;
      let query = db
        .from("manager_application_records")
        .update({ row_data: archivedRowData(record.row_data, item.mergedInto, nowIso), updated_at: nowIso })
        .eq("id", record.id);
      // Optimistic: an applicant who autosaved since the read changed the row, so it is left for the next run.
      query = record.updated_at ? query.eq("updated_at", record.updated_at) : query.is("updated_at", null);
      const { data, error } = await query.select("id");
      if (error) throw new Error(`Could not archive ${record.id}: ${error.message}`);
      if (data?.length) archived += 1;
      else {
        skipped += 1;
        console.log(`  skipped ${record.id}: changed since it was read`);
      }
    }
  }
  console.log(`Archived ${archived} draft(s); ${skipped} skipped. Restore any row from the snapshot if needed.`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
