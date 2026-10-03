#!/usr/bin/env node
/**
 * One conversation per person per workspace - fold the duplicates that already
 * exist (comms-safety-0929, Part B).
 *
 *   npx tsx --conditions=react-server --env-file=.env.local \
 *     scripts/merge-conversations-backfill.mjs [--dry-run | --apply --cursor-file <file>]
 *
 * DRY RUN IS THE DEFAULT and prints every merge it would make (keys are
 * redacted to their shape - no email, phone or account id is printed whole).
 * `--apply` writes, and needs a local --cursor-file so a long run resumes at the
 * owner it stopped on (the file holds counters and an owner id, never messages).
 *
 * How it decides (the SAME resolver the live writers use, so a backfilled
 * conversation and a freshly written one can never disagree):
 *   account -> verified phone -> email, in the workspace the conversation lives
 *   in. An unverified phone never links a person to an account; two accounts
 *   that verified one phone are flagged and NOT merged; an identity that cannot
 *   be resolved is left exactly as it is.
 *
 * What it does to the data, per merge group (all inside one owner at a time):
 *   1. every absorbed thread id is recorded in portal_inbox_thread_aliases, so a
 *      tour link / deep link / archive state keeps resolving;
 *   2. the surviving row (the one already holding the key, else the newest) is
 *      rewritten with the folded history, compare-and-set on updated_at;
 *   3. only then are the absorbed rows deleted, each compare-and-set on its own
 *      updated_at - a row that changed mid-run is left for the next pass.
 *
 * Passes: with --apply the script re-plans after writing and requires an EMPTY
 * plan twice in a row ("two clean passes") before it exits 0.
 *
 * Environment guard: --apply refuses any project but dev/test unless
 * --allow-project <ref> names the project it is being run against (staging /
 * production run at the captain's promote, same pattern as the SMS cutover).
 */
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  resolveConversationRef,
  resolveSmsConversationRef,
} from "../src/lib/communication/conversation-key.server.ts";
import { redactKey } from "../src/lib/communication/conversation-backfill.ts";
import {
  describePlan,
  planConversationMerges,
} from "../src/lib/communication/conversation-backfill.ts";

const DEV_PROJECT_REF = "emstjswhotsnyksqhqyf";
const PAGE = 100;
const READ_ATTEMPTS = 8;
const EXCLUDED_TYPES = ["agent_notice", "team", "vendor_agent", "resident_agent"];

export function parseArgs(argv) {
  const args = { apply: false, cursorFile: null, allowProject: null, limitOwners: Infinity, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--dry-run") args.apply = false;
    else if (arg === "--cursor-file") args.cursorFile = argv[++i];
    else if (arg === "--allow-project") args.allowProject = argv[++i];
    else if (arg === "--limit-owners") args.limitOwners = Number(argv[++i]);
    else if (arg === "--help") args.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (args.apply && !args.cursorFile) throw new Error("--apply requires --cursor-file for resumable progress");
  if (!(args.limitOwners > 0)) throw new Error("--limit-owners must be a positive number");
  return args;
}

function projectRef(url) {
  const match = /^https:\/\/([a-z0-9]+)\.supabase\.co/i.exec(String(url ?? "").trim());
  return match ? match[1] : "";
}

function ownerKey(row) {
  return row.owner_user_id ?? `p:${String(row.participant_email ?? "").toLowerCase()}`;
}

async function loadAllRows(db) {
  const rows = [];
  let lastId = "";
  for (;;) {
    let query = db
      .from("portal_inbox_thread_records")
      .select("id, scope, owner_user_id, participant_email, thread_type, row_data, updated_at, conversation_key, workspace_id")
      .order("id", { ascending: true })
      .limit(PAGE);
    if (lastId) query = query.gt("id", lastId);
    // The database may be slow or briefly down; a page is retried, never skipped.
    let data = null;
    let error = null;
    for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt += 1) {
      ({ data, error } = await query);
      if (!error) break;
      await new Promise((resolve) => setTimeout(resolve, 2500 * attempt));
    }
    if (error) throw new Error(`Could not read threads: ${error.message}`);
    if (!data?.length) break;
    rows.push(...data);
    lastId = data[data.length - 1].id;
    if (data.length < PAGE) break;
  }
  return rows.filter((row) => !EXCLUDED_TYPES.includes(String(row.thread_type ?? "")));
}

function sideOf(row) {
  const data = row.row_data ?? {};
  return {
    scope: row.scope,
    ownerUserId: row.owner_user_id,
    participantEmail: row.participant_email,
    otherPartyEmail: String(data.email ?? "").trim().toLowerCase(),
  };
}

function hintsOf(row) {
  const data = row.row_data ?? {};
  return {
    propertyId: String(data.rootHouseId ?? data.propertyId ?? "").trim() || null,
    otherPartyPhone: String(data.smsNoticePhone ?? "").trim() || null,
    managerUserId: String(data.managerUserId ?? "").trim() || null,
  };
}

async function planOwner(db, rows) {
  const inputs = [];
  for (const row of rows) {
    const ref = await resolveConversationRef(db, sideOf(row), hintsOf(row));
    inputs.push({ row, ref });
  }
  return planConversationMerges(inputs);
}

async function applyAction(db, action, rowsById) {
  if (action.kind === "merge") {
    const keep = rowsById.get(action.keepId);
    const absorbed = action.absorbIds.map((id) => rowsById.get(id));
    const aliasIds = action.rowData.aliasIds ?? [];
    if (aliasIds.length) {
      const { error } = await db
        .from("portal_inbox_thread_aliases")
        .upsert(aliasIds.map((alias) => ({ alias_id: alias, thread_id: action.keepId })), { onConflict: "alias_id" });
      if (error) throw new Error(`alias write failed: ${error.message}`);
    }
    const { data, error } = await db
      .from("portal_inbox_thread_records")
      .update({
        row_data: action.rowData,
        thread_type: action.threadType,
        conversation_key: action.key,
        workspace_id: action.workspaceId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", action.keepId)
      .eq("updated_at", keep.updated_at)
      .select("id");
    if (error) throw new Error(`merge write failed: ${error.message}`);
    if (!data?.length) return { status: "raced", id: action.keepId };
    for (const row of absorbed) {
      const { data: gone, error: delError } = await db
        .from("portal_inbox_thread_records")
        .delete()
        .eq("id", row.id)
        .eq("updated_at", row.updated_at)
        .select("id");
      if (delError) throw new Error(`absorb delete failed: ${delError.message}`);
      if (!gone?.length) return { status: "raced", id: row.id };
    }
    return { status: "merged", id: action.keepId };
  }
  if (action.kind === "stamp") {
    const { error } = await db
      .from("portal_inbox_thread_records")
      .update({ conversation_key: action.key, workspace_id: action.workspaceId })
      .eq("id", action.id);
    if (error) throw new Error(`stamp failed: ${error.message}`);
    return { status: "stamped", id: action.id };
  }
  // stamp-row-data: the row stays as is; only its key is recorded for the list to join on.
  const row = rowsById.get(action.id);
  const { data, error } = await db
    .from("portal_inbox_thread_records")
    .update({
      row_data: {
        ...(row.row_data ?? {}),
        conversationKey: action.key,
        workspaceId: action.workspaceId,
        ...(action.flagged ? { identityFlag: action.flagged } : {}),
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", action.id)
    .eq("updated_at", row.updated_at)
    .select("id");
  if (error) throw new Error(`notice stamp failed: ${error.message}`);
  return { status: data?.length ? "stamped" : "raced", id: action.id };
}

function readCursor(file) {
  if (!file || !existsSync(file)) return { lastOwner: "", counts: {} };
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { lastOwner: "", counts: {} };
  }
}

function writeCursor(file, cursor) {
  if (!file) return;
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(cursor));
  renameSync(tmp, file);
}

async function runPass(db, args, label, { resume }) {
  const rows = await loadAllRows(db);
  const byOwner = new Map();
  for (const row of rows) {
    const key = ownerKey(row);
    if (!byOwner.has(key)) byOwner.set(key, []);
    byOwner.get(key).push(row);
  }
  const owners = [...byOwner.keys()].sort();
  const cursor = resume ? readCursor(args.cursorFile) : { lastOwner: "", counts: {} };
  const counts = { owners: 0, merges: 0, stamps: 0, notices: 0, skipped: 0, raced: 0, absorbed: 0, ...cursor.counts };
  let planned = 0;
  let processed = 0;
  console.log(`\n== ${label}: ${rows.length} threads, ${owners.length} owners${cursor.lastOwner ? ` (resuming after ${String(cursor.lastOwner).slice(0, 8)})` : ""}`);
  for (const owner of owners) {
    if (cursor.lastOwner && owner <= cursor.lastOwner) continue;
    if (processed >= args.limitOwners) break;
    processed += 1;
    const ownerRows = byOwner.get(owner);
    const plan = await planOwner(db, ownerRows);
    counts.owners += 1;
    counts.skipped += plan.skipped.length;
    if (plan.actions.length || plan.skipped.length) {
      console.log(`-- owner ${String(owner).slice(0, 8)}`);
      for (const line of describePlan(plan)) console.log(`   ${line}`);
    }
    planned += plan.actions.length;
    const rowsById = new Map(ownerRows.map((row) => [row.id, row]));
    for (const action of plan.actions) {
      if (action.kind === "merge") {
        counts.merges += 1;
        counts.absorbed += action.absorbIds.length;
      } else if (action.kind === "stamp") counts.stamps += 1;
      else counts.notices += 1;
      if (!args.apply) continue;
      const result = await applyAction(db, action, rowsById);
      if (result.status === "raced") {
        counts.raced += 1;
        console.log(`   RACED ${result.id} (changed mid-run; the next pass picks it up)`);
      }
    }
    if (args.apply) writeCursor(args.cursorFile, { ...readCursor(args.cursorFile), lastOwner: owner, counts });
  }
  console.log(
    `== ${label}: ${planned} action(s) - merges ${counts.merges} (absorbing ${counts.absorbed} threads), stamps ${counts.stamps}, notices ${counts.notices}, skipped ${counts.skipped}, raced ${counts.raced}`,
  );
  return { planned, counts, complete: processed < args.limitOwners };
}

/**
 * Text conversations carry the same key: stamp every sms_projection_conversations
 * summary whose key is missing or out of date. Idempotent; resumable by id.
 */
async function runProjectionPass(db, args, label, { resume }) {
  const cursor = resume ? readCursor(args.cursorFile) : {};
  let lastId = cursor.projectionLastId ?? "";
  let scanned = 0;
  let planned = 0;
  let unresolved = 0;
  console.log(`\n== ${label}: text conversations${lastId ? ` (resuming after ${String(lastId).slice(0, 8)})` : ""}`);
  for (;;) {
    let query = db
      .from("sms_projection_conversations")
      .select("id, owner_manager_user_id, work_line_id, counterparty_user_id, counterparty_phone, conversation_key, workspace_id")
      .order("id", { ascending: true })
      .limit(PAGE);
    if (lastId) query = query.gt("id", lastId);
    let data = null;
    let error = null;
    for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt += 1) {
      ({ data, error } = await query);
      if (!error) break;
      await new Promise((resolve) => setTimeout(resolve, 2500 * attempt));
    }
    if (error) throw new Error(`Could not read text conversations: ${error.message}`);
    if (!data?.length) break;
    for (const row of data) {
      scanned += 1;
      const ref = await resolveSmsConversationRef(db, {
        ownerManagerUserId: row.owner_manager_user_id,
        workLineId: row.work_line_id,
        counterpartyUserId: row.counterparty_user_id,
        counterpartyPhone: row.counterparty_phone,
      });
      if (!ref) {
        unresolved += 1;
        continue;
      }
      if (row.conversation_key === ref.key && row.workspace_id === ref.workspaceId) continue;
      planned += 1;
      console.log(`   TEXTKEY ${row.id}  ws=${ref.workspaceId.slice(0, 8)} key=${redactKey(ref.key)}${ref.flagged ? `  FLAGGED:${ref.flagged.reason}` : ""}`);
      if (args.apply) {
        const { error: stampError } = await db.rpc("stamp_sms_projection_conversation", {
          p_conversation_id: row.id,
          p_workspace: ref.workspaceId,
          p_key: ref.key,
        });
        if (stampError) throw new Error(`text key stamp failed: ${stampError.message}`);
      }
    }
    lastId = data[data.length - 1].id;
    if (args.apply) writeCursor(args.cursorFile, { ...readCursor(args.cursorFile), projectionLastId: lastId });
    if (data.length < PAGE) break;
  }
  console.log(`== ${label}: ${scanned} text conversations, ${planned} to stamp, ${unresolved} unresolved (left as is)`);
  return { planned, scanned, unresolved };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: merge-conversations-backfill.mjs [--dry-run | --apply --cursor-file <file>] [--allow-project <ref>] [--limit-owners n]");
    return 0;
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  const ref = projectRef(url);
  if (args.apply && ref !== DEV_PROJECT_REF && args.allowProject !== ref) {
    throw new Error(`Refusing --apply on project ${ref || "(unknown)"}; pass --allow-project ${ref} only at the captain's promote.`);
  }
  console.log(`conversation backfill - project ${ref} - ${args.apply ? "APPLY" : "DRY RUN (nothing is written)"}`);
  const db = createClient(url, key, { auth: { persistSession: false } });

  const first = await runPass(db, args, args.apply ? "pass 1 (apply)" : "dry run", { resume: args.apply });
  await runProjectionPass(db, args, args.apply ? "pass 1 (apply)" : "dry run", { resume: args.apply });
  if (!args.apply) {
    console.log("\nDry run only: no row was changed. Re-run with --apply --cursor-file <file> to write.");
    return 0;
  }
  if (!first.complete) {
    console.log("\nStopped at --limit-owners; run again to continue from the cursor.");
    return 0;
  }
  // Two clean passes: re-plan from a fresh read, twice. Both must plan nothing.
  let clean = 0;
  for (let n = 1; n <= 4 && clean < 2; n += 1) {
    const verify = await runPass(db, args, `verify pass ${n}`, { resume: false });
    const texts = await runProjectionPass(db, args, `verify pass ${n}`, { resume: false });
    clean = verify.planned === 0 && texts.planned === 0 ? clean + 1 : 0;
  }
  if (clean < 2) {
    console.error("\nNOT CLEAN: the plan was not empty on two consecutive passes. Investigate before promoting.");
    return 1;
  }
  console.log("\nCLEAN: two consecutive passes planned nothing.");
  // The run is complete: a stale cursor must not make a later run skip new owners.
  writeCursor(args.cursorFile, { lastOwner: "", projectionLastId: "", counts: {}, completedAt: new Date().toISOString() });
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
