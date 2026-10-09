#!/usr/bin/env node
/**
 * One Assistant per person per workspace; one conversation per resident - fold
 * the duplicates that already exist (work-number-messaging-1009, Build item 5).
 *
 *   npx tsx --conditions=react-server --env-file=.env.local \
 *     scripts/merge-assistant-team-threads.mjs --project-ref <ref> \
 *     [--dry-run | --apply --backup-dir <dir>] [--allow-project <ref>] [--team]
 *
 * DRY RUN IS THE DEFAULT and prints every fold it would make. `--apply` writes.
 *
 * What it folds:
 *   (a) duplicate `agent_notice_*` rows per (user, workspace): the suffixed id
 *       of the user's DEFAULT workspace folds into the unsuffixed
 *       `agent_notice_<uid>` (messages unioned by id, sorted by time);
 *   (b) per-payment `msg_*` "· Payment update" person threads fold into the
 *       resident's one keyed conversation (same planner and resolver the live
 *       writers and merge-conversations-backfill use). Absorbed ids are written
 *       to `portal_inbox_thread_aliases` when that table exists;
 *   (c) `--team` is a STAGE 2 hook (one Team thread per workspace) and plans
 *       nothing yet (`planTeamThreadFold`).
 *
 * Safety:
 *   - `--project-ref <ref>` is REQUIRED and must equal the project in
 *     NEXT_PUBLIC_SUPABASE_URL, so an env file pointing somewhere unexpected
 *     refuses instead of running.
 *   - `--apply` refuses any project but dev/test unless `--allow-project <ref>`
 *     repeats the ref (staging / production run at the captain's promote).
 *   - `--apply` needs `--backup-dir`; every row the plan touches is dumped to a
 *     JSON file there BEFORE the first write.
 *   - Every write is compare-and-set on `updated_at`; a row that changed
 *     mid-run is left for the next run.
 */
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveConversationRef } from "../src/lib/communication/conversation-key.server.ts";
import {
  describeAssistantTeamPlan,
  isAssistantNoticeRow,
  isPaymentUpdateRow,
  planAssistantNoticeFold,
  planPaymentUpdateFold,
  planTeamThreadFold,
  touchedIds,
} from "../src/lib/communication/assistant-team-merge.ts";

const DEV_PROJECT_REF = "emstjswhotsnyksqhqyf";
const PAGE = 200;
const COLUMNS = "id, scope, owner_user_id, participant_email, thread_type, row_data, updated_at, conversation_key, workspace_id";

export function parseArgs(argv) {
  const args = { apply: false, projectRef: null, backupDir: null, allowProject: null, team: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--dry-run") args.apply = false;
    else if (arg === "--project-ref") args.projectRef = argv[++i];
    else if (arg === "--backup-dir") args.backupDir = argv[++i];
    else if (arg === "--allow-project") args.allowProject = argv[++i];
    else if (arg === "--team") args.team = true;
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

async function loadPaged(db, build, label) {
  const rows = [];
  let lastId = "";
  for (;;) {
    const data = await withRetry(() => {
      let query = build(db.from("portal_inbox_thread_records").select(COLUMNS)).order("id", { ascending: true }).limit(PAGE);
      if (lastId) query = query.gt("id", lastId);
      return query;
    }, label);
    if (!data.length) break;
    rows.push(...data);
    lastId = data[data.length - 1].id;
    if (data.length < PAGE) break;
  }
  return rows;
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

function ownerKey(row) {
  return row.owner_user_id ?? `p:${String(row.participant_email ?? "").toLowerCase()}`;
}

async function loadDefaultWorkspaces(db) {
  const data = await withRetry(
    () => db.from("portal_workspaces").select("id, owner_user_id").eq("is_default", true),
    "default workspaces",
  );
  return new Map(data.map((row) => [String(row.owner_user_id), String(row.id)]));
}

async function aliasesAvailable(db) {
  const { error } = await db.from("portal_inbox_thread_aliases").select("alias_id").limit(1);
  return !error;
}

async function writeAliases(db, aliasIds, threadId) {
  if (!aliasIds.length) return;
  const { error } = await db
    .from("portal_inbox_thread_aliases")
    .upsert(aliasIds.map((alias) => ({ alias_id: alias, thread_id: threadId })), { onConflict: "alias_id" });
  if (error) throw new Error(`alias write failed: ${error.message}`);
}

async function deleteAbsorbed(db, ids, rowsById) {
  for (const id of ids) {
    const row = rowsById.get(id);
    if (!row) continue;
    let query = db.from("portal_inbox_thread_records").delete().eq("id", id);
    query = row.updated_at ? query.eq("updated_at", row.updated_at) : query;
    const { data, error } = await query.select("id");
    if (error) throw new Error(`absorb delete failed: ${error.message}`);
    if (!data?.length) return { status: "raced", id };
  }
  return { status: "ok" };
}

async function applyAction(db, action, rowsById, aliases) {
  if (action.kind === "assistant-fold") {
    const base = rowsById.get(action.baseId);
    const nowIso = new Date().toISOString();
    if (action.createCanonical) {
      const { error } = await db.from("portal_inbox_thread_records").insert({
        id: action.canonicalId,
        scope: base.scope,
        owner_user_id: base.owner_user_id,
        participant_email: null,
        thread_type: "agent_notice",
        row_data: action.rowData,
        updated_at: nowIso,
      });
      if (error) {
        if (String(error.code) === "23505") return { status: "raced", id: action.canonicalId };
        throw new Error(`assistant create failed: ${error.message}`);
      }
    } else {
      let update = db
        .from("portal_inbox_thread_records")
        .update({ row_data: action.rowData, updated_at: nowIso })
        .eq("id", action.canonicalId);
      update = base.updated_at ? update.eq("updated_at", base.updated_at) : update;
      const { data, error } = await update.select("id");
      if (error) throw new Error(`assistant fold write failed: ${error.message}`);
      if (!data?.length) return { status: "raced", id: action.canonicalId };
    }
    if (aliases) await writeAliases(db, action.absorbIds, action.canonicalId);
    const gone = await deleteAbsorbed(db, action.absorbIds, rowsById);
    return gone.status === "ok" ? { status: "merged", id: action.canonicalId } : gone;
  }
  if (action.kind === "merge") {
    const keep = rowsById.get(action.keepId);
    if (aliases) await writeAliases(db, action.rowData.aliasIds ?? action.absorbIds, action.keepId);
    let update = db
      .from("portal_inbox_thread_records")
      .update({
        row_data: action.rowData,
        thread_type: action.threadType,
        conversation_key: action.key,
        workspace_id: action.workspaceId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", action.keepId);
    update = keep.updated_at ? update.eq("updated_at", keep.updated_at) : update;
    const { data, error } = await update.select("id");
    if (error) throw new Error(`merge write failed: ${error.message}`);
    if (!data?.length) return { status: "raced", id: action.keepId };
    const gone = await deleteAbsorbed(db, action.absorbIds, rowsById);
    return gone.status === "ok" ? { status: "merged", id: action.keepId } : gone;
  }
  if (action.kind === "stamp") {
    const { error } = await db
      .from("portal_inbox_thread_records")
      .update({ conversation_key: action.key, workspace_id: action.workspaceId })
      .eq("id", action.id);
    if (error) throw new Error(`stamp failed: ${error.message}`);
    return { status: "stamped", id: action.id };
  }
  const row = rowsById.get(action.id);
  let update = db
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
    .eq("id", action.id);
  update = row.updated_at ? update.eq("updated_at", row.updated_at) : update;
  const { data, error } = await update.select("id");
  if (error) throw new Error(`notice stamp failed: ${error.message}`);
  return { status: data?.length ? "stamped" : "raced", id: action.id };
}

/** Plan everything from a fresh read. Pure given the database's contents. */
async function buildPlan(db, args) {
  const defaults = await loadDefaultWorkspaces(db);
  const assistantRows = await loadPaged(
    db,
    (q) => q.or("thread_type.eq.agent_notice,id.like.agent_notice_%"),
    "assistant rows",
  );
  const assistantPlan = planAssistantNoticeFold(assistantRows.filter(isAssistantNoticeRow), defaults);

  const paymentSeeds = await loadPaged(
    db,
    (q) => q.like("id", "msg_%").like("row_data->>subject", "%Payment update"),
    "payment-update rows",
  );
  const seeds = paymentSeeds.filter(isPaymentUpdateRow);
  const ownerIds = [...new Set(seeds.map((row) => row.owner_user_id).filter(Boolean))];
  const mirrorEmails = [
    ...new Set(seeds.filter((row) => !row.owner_user_id).map((row) => String(row.participant_email ?? "").toLowerCase()).filter(Boolean)),
  ];
  const personRows = [];
  for (let i = 0; i < ownerIds.length; i += 50) {
    const chunk = ownerIds.slice(i, i + 50);
    personRows.push(...(await loadPaged(db, (q) => q.eq("thread_type", "portal_message").in("owner_user_id", chunk), "owner threads")));
  }
  for (let i = 0; i < mirrorEmails.length; i += 50) {
    const chunk = mirrorEmails.slice(i, i + 50);
    personRows.push(
      ...(await loadPaged(db, (q) => q.eq("thread_type", "portal_message").is("owner_user_id", null).in("participant_email", chunk), "mirror threads")),
    );
  }
  const byOwner = new Map();
  for (const row of personRows) {
    const key = ownerKey(row);
    if (!byOwner.has(key)) byOwner.set(key, []);
    byOwner.get(key).push(row);
  }
  const paymentPlans = [];
  for (const [owner, rows] of byOwner) {
    const inputs = [];
    for (const row of rows) inputs.push({ row, ref: await resolveConversationRef(db, sideOf(row), hintsOf(row)) });
    paymentPlans.push({ owner, plan: planPaymentUpdateFold(inputs) });
  }
  const teamPlan = args.team ? planTeamThreadFold([]) : { actions: [], skipped: [] };

  const rowsById = new Map();
  for (const row of [...assistantRows, ...personRows]) rowsById.set(row.id, row);
  return { assistantPlan, paymentPlans, teamPlan, rowsById };
}

function ownerOfAction(action) {
  if (action.kind === "assistant-fold") return action.userId;
  if (action.kind === "merge") return action.ownerUserId ?? `p:${action.participantEmail ?? ""}`;
  return null;
}

function summarize(plan) {
  const perOwner = new Map();
  const bump = (owner, field, n = 1) => {
    const key = String(owner ?? "-").slice(0, 8);
    const entry = perOwner.get(key) ?? { assistantFolds: 0, assistantAbsorbed: 0, paymentMerges: 0, paymentAbsorbed: 0, stamps: 0 };
    entry[field] += n;
    perOwner.set(key, entry);
  };
  for (const action of plan.assistantPlan.actions) {
    bump(ownerOfAction(action), "assistantFolds");
    bump(ownerOfAction(action), "assistantAbsorbed", action.absorbIds.length);
  }
  for (const { owner, plan: p } of plan.paymentPlans) {
    for (const action of p.actions) {
      if (action.kind === "merge") {
        bump(ownerOfAction(action) ?? owner, "paymentMerges");
        bump(ownerOfAction(action) ?? owner, "paymentAbsorbed", action.absorbIds.length);
      } else {
        bump(owner, "stamps");
      }
    }
  }
  return perOwner;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: merge-assistant-team-threads.mjs --project-ref <ref> [--dry-run | --apply --backup-dir <dir>] [--allow-project <ref>] [--team]");
    return 0;
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  const ref = assertProjectAllowed({ url, projectRef: args.projectRef, apply: args.apply, allowProject: args.allowProject });
  console.log(`assistant/team thread merge - project ${ref} - ${args.apply ? "APPLY" : "DRY RUN (nothing is written)"}`);
  const db = createClient(url, key, { auth: { persistSession: false } });

  const plan = await buildPlan(db, args);
  const allActions = [
    ...plan.assistantPlan.actions,
    ...plan.paymentPlans.flatMap(({ plan: p }) => p.actions),
    ...plan.teamPlan.actions,
  ];

  console.log("\n== (a) duplicate Assistant rows");
  for (const line of describeAssistantTeamPlan(plan.assistantPlan)) console.log(`   ${line}`);
  console.log("\n== (b) per-payment threads -> the resident's one conversation");
  for (const { owner, plan: p } of plan.paymentPlans) {
    const lines = describeAssistantTeamPlan(p);
    if (!lines.length) continue;
    console.log(`-- owner ${String(owner).slice(0, 8)}`);
    for (const line of lines) console.log(`   ${line}`);
  }
  if (args.team) console.log("\n== (c) team threads: stage 2 (planTeamThreadFold) - nothing planned yet");

  console.log("\n== summary per owner");
  const summary = summarize(plan);
  if (summary.size === 0) console.log("   nothing to fold");
  for (const [owner, s] of summary) {
    console.log(
      `   owner ${owner}: assistant folds ${s.assistantFolds} (absorbing ${s.assistantAbsorbed}), payment-update merges ${s.paymentMerges} (absorbing ${s.paymentAbsorbed}), stamps ${s.stamps}`,
    );
  }
  console.log(`   total actions: ${allActions.length}`);

  if (!args.apply) {
    console.log("\nDry run only: no row was changed. Re-run with --apply --backup-dir <dir> to write.");
    return 0;
  }
  if (allActions.length === 0) {
    console.log("\nNothing to apply.");
    return 0;
  }

  // Back up EVERY row the plan touches before the first write.
  const touched = new Set(allActions.flatMap(touchedIds));
  const backupRows = [...touched].map((id) => plan.rowsById.get(id)).filter(Boolean);
  mkdirSync(args.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(args.backupDir, `merge-assistant-team-${ref}-${stamp}.json`);
  writeFileSync(file, JSON.stringify({ projectRef: ref, createdAt: new Date().toISOString(), rows: backupRows }, null, 2));
  console.log(`\nbackup: ${backupRows.length} row(s) -> ${file}`);

  const aliases = await aliasesAvailable(db);
  if (!aliases) console.log("portal_inbox_thread_aliases is not available here: folded ids will not be aliased");
  let raced = 0;
  for (const action of allActions) {
    const result = await applyAction(db, action, plan.rowsById, aliases);
    if (result.status === "raced") {
      raced += 1;
      console.log(`   RACED ${result.id} (changed mid-run; run again to pick it up)`);
    }
  }
  console.log(`\napplied ${allActions.length - raced} of ${allActions.length} action(s); raced ${raced}`);
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
