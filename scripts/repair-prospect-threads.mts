/**
 * One-off, idempotent repair of prospect text threads (design-1112 section 0). DRY RUN by default.
 *
 *   npx tsx --conditions=react-server --env-file=.env.local scripts/repair-prospect-threads.mts --project-ref <ref>
 *   npx tsx --conditions=react-server --env-file=.env.local scripts/repair-prospect-threads.mts --project-ref <ref> --apply
 *
 * What it does (rules: `src/lib/prospect-spine/repair-plan.ts`, tested):
 *   1. folds one owner's duplicate `sms_notice_*` threads for the same phone into one (the others stay as pointers, nothing deleted);
 *   2. stamps a PropLane-managed workspace owner's house-less prospect threads with the workspace + phone key so the staff who
 *      run the workspace can read them.
 *
 * Safety:
 *   - `--project-ref` is REQUIRED and must equal the project ref in NEXT_PUBLIC_SUPABASE_URL, or it refuses.
 *   - Writes only with `--apply`. Before ANY change a JSON backup of every row about to change (the whole row) is written to
 *     --backup-dir (default ./backups) and read back; if that fails nothing is changed.
 *   - Idempotent: a second run plans nothing. A row changed by someone else between read and write is skipped (compare-and-set on
 *     updated_at) and reported.
 *   - Prints counts and thread ids only: no phone numbers, no message bodies.
 */
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { planProspectRepair, type RepairRow, type RepairWorkspace } from "../src/lib/prospect-spine/repair-plan";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const ref = arg("--project-ref");
const apply = process.argv.includes("--apply");
const backupDir = path.resolve(arg("--backup-dir") ?? "backups");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!ref) throw new Error("--project-ref <ref> is required.");
if (!url.includes(`//${ref}.`)) throw new Error("--project-ref does not match NEXT_PUBLIC_SUPABASE_URL. Refusing.");
if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set.");
const db = createClient(url, key, { auth: { persistSession: false } });

async function loadRows(): Promise<RepairRow[]> {
  const out: RepairRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("portal_inbox_thread_records")
      .select("id, owner_user_id, workspace_id, conversation_key, scope, updated_at, row_data")
      .like("id", "sms_notice_%")
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(`read failed: ${error.code ?? "unknown"}`);
    out.push(...((data ?? []) as RepairRow[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

const { data: wsData, error: wsError } = await db.from("portal_workspaces").select("id, owner_user_id, is_service");
if (wsError) throw new Error("workspaces unreadable");
const rows = await loadRows();
const plan = planProspectRepair(rows, (wsData ?? []) as RepairWorkspace[]);
const folds = plan.actions.filter((a) => a.kind === "fold");
const stamps = plan.actions.filter((a) => a.kind === "stamp");
console.log(`project ${ref}: ${rows.length} sms notice threads; plan = ${folds.length} fold(s), ${stamps.length} stamp(s), ${plan.skipped.length} skipped`);
for (const a of plan.actions) {
  console.log(a.kind === "fold" ? `  fold  keep=${a.keepId} absorb=${a.absorbIds.join(",")} +${a.addedTurns} turn(s)` : `  stamp ${a.id} -> workspace ${a.workspaceId}`);
}
for (const s of plan.skipped) console.log(`  skipped ${s.id}: ${s.reason}`);
if (!apply) {
  console.log("Dry run: nothing written. Re-run with --apply to change rows (a JSON backup is written first).");
  process.exit(0);
}
if (plan.actions.length === 0) {
  console.log("Nothing to do.");
  process.exit(0);
}

// Backup first: every row that will change, whole, written and read back.
const touched = new Set<string>();
for (const a of plan.actions) {
  if (a.kind === "fold") [a.keepId, ...a.absorbIds].forEach((id) => touched.add(id));
  else touched.add(a.id);
}
const backup = rows.filter((r) => touched.has(r.id));
fs.mkdirSync(backupDir, { recursive: true });
const file = path.join(backupDir, `repair-prospect-threads-${ref}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(file, JSON.stringify({ project: ref, at: new Date().toISOString(), rows: backup }, null, 2));
const readBack = JSON.parse(fs.readFileSync(file, "utf8")) as { rows: unknown[] };
if (readBack.rows.length !== backup.length) throw new Error("Backup verification failed; nothing was changed.");
console.log(`backup written: ${file} (${backup.length} rows)`);

const byId = new Map(rows.map((r) => [r.id, r]));
async function patchRowData(id: string, mutate: (rd: Record<string, unknown>) => Record<string, unknown>): Promise<"ok" | "conflict"> {
  const row = byId.get(id)!;
  const next = mutate({ ...(row.row_data ?? {}) });
  let q = db.from("portal_inbox_thread_records").update({ row_data: next }).eq("id", id);
  q = row.updated_at ? q.eq("updated_at", row.updated_at) : q.is("updated_at", null);
  const { data, error } = await q.select("id");
  if (error) throw new Error(`update failed for ${id}: ${error.code ?? "unknown"}`);
  return (data ?? []).length > 0 ? "ok" : "conflict";
}

let changed = 0;
let conflicts = 0;
for (const a of plan.actions) {
  if (a.kind === "fold") {
    const keeper = await patchRowData(a.keepId, (rd) => ({ ...rd, messages: a.messages }));
    if (keeper === "conflict") { conflicts += 1; console.log(`  conflict (changed meanwhile): ${a.keepId}`); continue; }
    for (const id of a.absorbIds) {
      const r = await patchRowData(id, (rd) => ({ ...rd, mergedInto: a.keepId, folder: "trash" }));
      if (r === "conflict") conflicts += 1; else changed += 1;
    }
    changed += 1;
  } else {
    const { data, error } = await db.rpc("adopt_conversation", { p_thread_id: a.id, p_workspace: a.workspaceId, p_key: a.key });
    if (error) { console.log(`  stamp failed for ${a.id}: ${error.code ?? "unknown"}`); continue; }
    if ((data as { adopted?: unknown } | null)?.adopted === true) {
      await patchRowData(a.id, (rd) => ({ ...rd, workspaceId: a.workspaceId, conversationKey: a.key }));
      changed += 1;
    } else console.log(`  not adopted (key already held by another row): ${a.id}`);
  }
}
console.log(`done: ${changed} change(s), ${conflicts} conflict(s). Re-run to confirm the plan is empty.`);
