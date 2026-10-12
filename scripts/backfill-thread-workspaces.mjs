#!/usr/bin/env node
/**
 * Stamp a workspace on every manager conversation that has none, and report the
 * work-identity invariant (workspace comms isolation, Oct 12 2026).
 *
 *   npx tsx --env-file=.env.local scripts/backfill-thread-workspaces.mjs \
 *     --project-ref <ref> [--dry-run | --apply --backup-dir <dir>] [--allow-project <ref>]
 *
 * Stamps:
 *   * `portal_inbox_thread_records` rows with scope `axis_portal_inbox_manager_v1`
 *     where `workspace_id` and `test_workspace_id` are both null;
 *   * `sms_projection_conversations` rows where `workspace_id` is null.
 * The workspace is the one that holds the thread's house, else the one that owns
 * its work line, else the owner's default workspace. A stamp that would land on
 * an occupied (owner, workspace, scope, conversation_key) slot is skipped and
 * reported, never forced. Resident and vendor inboxes are not touched.
 *
 * Then prints the work-identity report (live numbers and active emails per
 * workspace, unplaced rows, any workspace holding more than one). It changes
 * nothing, ever.
 *
 * Safety (same pattern as repair-sms-contact-display-names.mjs):
 *   - DRY RUN is the default: prints the plan, writes nothing.
 *   - `--project-ref <ref>` is REQUIRED and must equal NEXT_PUBLIC_SUPABASE_URL's project.
 *   - `--apply` refuses any project but dev/test unless `--allow-project <ref>` repeats the ref.
 *   - `--apply` needs `--backup-dir`; every row it will stamp is dumped there before the first write.
 *   - Each write only sets `workspace_id` and only while it is still null (compare-and-set).
 */
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assistantEmailAddress, assistantMailboxAddress } from "../src/lib/manager-assistant-email/assistant-email-address.ts";
import {
  MANAGER_INBOX_SCOPE,
  existingConversationSlots,
  lineKey,
  planProjectionWorkspaceBackfill,
  planThreadWorkspaceBackfill,
  referencedHouseIds,
  workIdentityReport,
} from "./lib/thread-workspace-backfill.mjs";

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

/** Keyset-paged read of one table; `build(query)` adds the filters. */
async function loadAll(db, table, columns, build = (q) => q) {
  const rows = [];
  let lastId = "";
  for (;;) {
    const data = await withRetry(() => {
      let query = build(db.from(table).select(columns)).order("id", { ascending: true }).limit(PAGE);
      if (lastId) query = query.gt("id", lastId);
      return query;
    }, table);
    if (!data.length) break;
    rows.push(...data);
    lastId = data[data.length - 1].id;
    if (data.length < PAGE) break;
  }
  return rows;
}

async function loadHouseWorkspaces(db, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const data = await withRetry(() => db.from("manager_property_records").select("id, workspace_id").in("id", chunk), "manager_property_records");
    for (const row of data) out.set(String(row.id), row.workspace_id ?? null);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: backfill-thread-workspaces.mjs --project-ref <ref> [--dry-run | --apply --backup-dir <dir>] [--allow-project <ref>]");
    return 0;
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  const ref = assertProjectAllowed({ url, projectRef: args.projectRef, apply: args.apply, allowProject: args.allowProject });
  console.log(`thread workspace backfill - project ${ref} - ${args.apply ? "APPLY" : "DRY RUN (nothing is written)"}`);
  const db = createClient(url, key, { auth: { persistSession: false } });

  const [workspaces, numbers, emails] = await Promise.all([
    loadAll(db, "portal_workspaces", "id, owner_user_id, name, is_default"),
    loadAll(db, "manager_sms_numbers", "id, workspace_id, manager_user_id, phone_number, provision_state, released_at"),
    loadAll(db, "manager_assistant_emails", "id, workspace_id, manager_user_id, provision_state, inbox_token, mailbox_local"),
  ]);
  const defaultWorkspaceByOwner = new Map();
  for (const w of workspaces) if (w.is_default && !defaultWorkspaceByOwner.has(w.owner_user_id)) defaultWorkspaceByOwner.set(w.owner_user_id, w.id);

  const workspaceByLine = new Map();
  const claimLine = (line, workspaceId) => {
    const k = lineKey(line);
    if (k && workspaceId && !workspaceByLine.has(k)) workspaceByLine.set(k, workspaceId);
  };
  for (const n of numbers) if (n.phone_number && n.workspace_id) claimLine(n.phone_number, n.workspace_id);
  for (const e of emails) {
    if (e.provision_state !== "active" || !e.workspace_id) continue;
    if (e.mailbox_local) claimLine(assistantMailboxAddress(e.mailbox_local), e.workspace_id);
    if (e.inbox_token) claimLine(assistantEmailAddress(e.inbox_token), e.workspace_id);
  }

  // ---- manager inbox threads
  const columns = "id, scope, owner_user_id, conversation_key, workspace_id, test_workspace_id, row_data, updated_at";
  const candidates = await loadAll(db, "portal_inbox_thread_records", columns, (q) =>
    q.eq("scope", MANAGER_INBOX_SCOPE).is("workspace_id", null).is("test_workspace_id", null),
  );
  const stampedKeyed = await loadAll(db, "portal_inbox_thread_records", "id, scope, owner_user_id, conversation_key, workspace_id", (q) =>
    q.eq("scope", MANAGER_INBOX_SCOPE).not("workspace_id", "is", null).not("conversation_key", "is", null),
  );
  const houseWorkspaceById = await loadHouseWorkspaces(db, referencedHouseIds(candidates));
  const threadPlan = planThreadWorkspaceBackfill({
    threads: candidates,
    houseWorkspaceById,
    workspaceByLine,
    defaultWorkspaceByOwner,
    occupiedSlots: existingConversationSlots(stampedKeyed),
  });
  console.log(`\nmanager inbox threads without a workspace: ${candidates.length}`);
  console.log(`   to stamp: ${threadPlan.stamps.length} (house ${threadPlan.byVia.house}, work line ${threadPlan.byVia.line}, owner default ${threadPlan.byVia.default})`);
  console.log(`   skipped: ${threadPlan.skipped.length}`);
  for (const s of threadPlan.skipped) console.log(`   SKIP ${s.id}: ${s.reason}${s.workspaces ? ` ${s.workspaces.join(",")}` : ""}`);

  // ---- SMS projection conversations
  const projectionRows = await loadAll(db, "sms_projection_conversations", "id, owner_manager_user_id, work_line_id, workspace_id, updated_at", (q) =>
    q.is("workspace_id", null),
  );
  const numberWorkspaceById = new Map(numbers.map((n) => [String(n.id), n.workspace_id ?? null]));
  const projectionPlan = planProjectionWorkspaceBackfill({ rows: projectionRows, numberWorkspaceById, defaultWorkspaceByOwner });
  console.log(`\nsms projection conversations without a workspace: ${projectionRows.length}`);
  console.log(`   to stamp: ${projectionPlan.stamps.length} (work line ${projectionPlan.byVia.line}, owner default ${projectionPlan.byVia.default}); skipped: ${projectionPlan.skipped.length}`);
  for (const s of projectionPlan.skipped) console.log(`   SKIP ${s.id}: ${s.reason}`);

  // ---- work identity report (read-only)
  const report = workIdentityReport({ workspaces, numbers, emails });
  console.log(`\nwork identity (read-only): ${report.rows.length} workspace(s)`);
  for (const r of report.rows) {
    const flag = r.liveNumbers > 1 || r.activeEmails > 1 ? "  <-- MORE THAN ONE" : "";
    console.log(`   ${r.workspaceId} ${r.name ?? ""}: numbers ${r.liveNumbers}, emails ${r.activeEmails}${flag}`);
  }
  console.log(`   unplaced numbers: ${report.unplacedNumbers.length}${report.unplacedNumbers.length ? ` (${report.unplacedNumbers.join(", ")})` : ""}`);
  console.log(`   unplaced emails: ${report.unplacedEmails.length}${report.unplacedEmails.length ? ` (${report.unplacedEmails.join(", ")})` : ""}`);
  console.log(`   rows naming an unknown workspace: ${report.unknownWorkspaceRows.length}`);
  console.log(`   workspaces with more than one: ${report.multiple.length} (reported only, never changed)`);

  if (!args.apply) {
    console.log("\nDry run only: no row was changed. Re-run with --apply --backup-dir <dir> to write.");
    return 0;
  }
  if (threadPlan.stamps.length === 0 && projectionPlan.stamps.length === 0) {
    console.log("\nNothing to apply.");
    return 0;
  }

  mkdirSync(args.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(args.backupDir, `thread-workspaces-${ref}-${stamp}.json`);
  const threadById = new Map(candidates.map((row) => [row.id, row]));
  const projectionById = new Map(projectionRows.map((row) => [row.id, row]));
  writeFileSync(
    file,
    JSON.stringify(
      {
        projectRef: ref,
        createdAt: new Date().toISOString(),
        // Pre-write state: workspace_id is null on every one of these rows. Restore = set it back to null.
        threads: threadPlan.stamps.map((s) => ({ ...s, before: { id: s.id, workspace_id: null, updated_at: threadById.get(s.id)?.updated_at ?? null } })),
        projection: projectionPlan.stamps.map((s) => ({ ...s, before: { id: s.id, workspace_id: null, updated_at: projectionById.get(s.id)?.updated_at ?? null } })),
      },
      null,
      2,
    ),
  );
  console.log(`\nbackup: ${threadPlan.stamps.length} thread row(s) + ${projectionPlan.stamps.length} projection row(s) -> ${file}`);

  const write = async (table, plan) => {
    let done = 0;
    let raced = 0;
    let collided = 0;
    for (const s of plan.stamps) {
      // updated_at is left alone on purpose: stamping a workspace must not reorder a list.
      const { data, error } = await db.from(table).update({ workspace_id: s.workspaceId }).eq("id", s.id).is("workspace_id", null).select("id");
      if (error) {
        if (error.code === "23505") {
          collided += 1;
          console.log(`   COLLISION ${table} ${s.id} (slot taken; left unstamped)`);
          continue;
        }
        throw new Error(`update ${table} ${s.id}: ${error.message}`);
      }
      if (!data?.length) {
        raced += 1;
        console.log(`   RACED ${table} ${s.id} (changed mid-run; run again to pick it up)`);
      } else done += 1;
    }
    console.log(`${table}: stamped ${done} of ${plan.stamps.length}; raced ${raced}; collided ${collided}`);
  };
  await write("portal_inbox_thread_records", threadPlan);
  await write("sms_projection_conversations", projectionPlan);
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
