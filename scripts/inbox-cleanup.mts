/**
 * One-off inbox cleanup: removes automated noise (never a person's message) from the PropLane admin and managed-workspace
 * inboxes. Dry run by default.
 *
 *   npx tsx --conditions=react-server --env-file=.env.local scripts/inbox-cleanup.mts            # dry run (writes nothing to the database)
 *   npx tsx --conditions=react-server --env-file=.env.local scripts/inbox-cleanup.mts --apply    # changes rows (after a JSON backup)
 *
 * Categories (rules in `src/lib/communication/inbox-cleanup.ts`, tested):
 *   a  Assistant notices (`agent_notice` threads of the admin and of PropLane-managed workspaces): automated notices older than
 *      24 hours are removed from the thread; the thread row and every message a person typed stay.
 *   b  Team chat (`team-thread:…`): PropLane's automated lines are removed; human messages stay.
 *   c  A managed workspace's owner's in-app thread that holds ONLY system notices (`isSystemOnlyOwnerThread`): deleted.
 *   d  206-line lead threads whose only outbound text is the automated "PropLane here. Reply anytime … Reply STOP to opt out."
 *      nudge: just those nudge turns are deleted; the lead's own turns stay.
 *
 * Never touched: resident, applicant, vendor or any human conversation, payments, leases, the ledger.
 *
 * Safety:
 *   - The target project comes from the environment (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).
 *   - PRODUCTION (qahnczmilgptcedaqype) is refused for any write unless ALLOW_PRODUCTION_INBOX_CLEANUP=1 AND --apply. A
 *     production dry run only reads. Staging and unknown projects need the same flag for --apply.
 *   - Before ANY change a full JSON backup of every row about to change (the whole row, plus what is removed) is written and
 *     read back; if that fails nothing is changed. Backups go to --backup-dir (default ~/inbox-cleanup-backups).
 *   - Idempotent: a second run finds nothing left to do. A thread edited by someone else between read and write is skipped
 *     (compare-and-set on updated_at) and reported, never overwritten.
 *   - `--source-file <json>` plans from a read-only export instead of the database (dry run only), so the plan can be
 *     computed where no service key exists.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertInboxCleanupWriteAllowed,
  INBOX_CLEANUP_PRODUCTION_REF,
  isDeletableOwnerThread,
  planAssistantNoticeCleanup,
  planLeadNudgeCleanup,
  planTeamThreadCleanup,
  type LeadTurn,
  type ThreadRow,
} from "../src/lib/communication/inbox-cleanup";
import type { ManagedOwnerIdentity } from "../src/lib/communication/managed-owner-thread";

const PRODUCTION_REF = INBOX_CLEANUP_PRODUCTION_REF;

type Scope = {
  serviceOwnerId: string | null;
  workspaces: Array<{ id: string; name: string; owner_user_id: string }>;
  adminUserIds: string[];
  owners: Array<ManagedOwnerIdentity>;
};

interface Store {
  readonly label: string;
  loadScope(): Promise<Scope>;
  loadThreads(kind: "agent_notice" | "team" | "owner", scope: Scope): Promise<ThreadRow[]>;
  loadLeadTurns(): Promise<LeadTurn[]>;
  updateThreadMessages(thread: ThreadRow, messages: unknown[]): Promise<"ok" | "conflict">;
  deleteThread(thread: ThreadRow): Promise<"ok" | "conflict">;
  deleteLeadTurns(ids: string[]): Promise<number>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Arguments and target
// ---------------------------------------------------------------------------------------------------------------------

function parseArgs(argv: string[]) {
  const flag = (name: string) => argv.includes(name);
  const value = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (flag("--apply") && flag("--dry-run")) throw new Error("Pass --dry-run or --apply, not both.");
  return {
    apply: flag("--apply"),
    sourceFile: value("--source-file"),
    backupDir: value("--backup-dir") || process.env.INBOX_CLEANUP_BACKUP_DIR || path.join(os.homedir(), "inbox-cleanup-backups"),
    now: value("--now") ? new Date(value("--now")!) : new Date(),
  };
}

function projectRefOf(url: string): string {
  return /^https?:\/\/([a-z0-9]+)\.supabase\.co/i.exec(url)?.[1]?.toLowerCase() ?? "unknown";
}

// ---------------------------------------------------------------------------------------------------------------------
// Supabase store
// ---------------------------------------------------------------------------------------------------------------------

const PAGE = 500;
const NON_PERSON_TYPES = ["agent_notice", "team", "vendor_agent", "resident_agent"];
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

async function pages<T>(read: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await read(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

const THREAD_COLUMNS = "id, thread_type, owner_user_id, participant_email, row_data, updated_at";

function supabaseStore(db: SupabaseClient, label: string): Store {
  return {
    label,
    async loadScope() {
      const settings = await db.from("platform_service_settings").select("owner_user_id").eq("singleton", true).maybeSingle();
      const serviceOwnerId = str((settings.data as { owner_user_id?: unknown } | null)?.owner_user_id) || null;
      const ws = await db.from("portal_workspaces").select("id, name, owner_user_id").eq("is_service", true).limit(1000);
      if (ws.error) throw new Error(ws.error.message);
      const workspaces = ((ws.data ?? []) as Array<{ id: string; name: string; owner_user_id: string }>).map((w) => ({ id: str(w.id), name: str(w.name), owner_user_id: str(w.owner_user_id) }));
      const roles = await db.from("profile_roles").select("user_id").eq("role", "admin").limit(1000);
      if (roles.error) throw new Error(roles.error.message);
      const adminUserIds = ((roles.data ?? []) as Array<{ user_id?: unknown }>).map((r) => str(r.user_id)).filter(Boolean);
      const ownerIds = [...new Set(workspaces.map((w) => w.owner_user_id).filter((id) => id && id !== serviceOwnerId))];
      const owners: ManagedOwnerIdentity[] = [];
      if (ownerIds.length) {
        const profiles = await db.from("profiles").select("id, email, phone").in("id", ownerIds);
        if (profiles.error) throw new Error(profiles.error.message);
        for (const p of (profiles.data ?? []) as Array<{ id: string; email?: string | null; phone?: string | null }>) {
          owners.push({ ownerUserId: str(p.id), email: str(p.email).toLowerCase() || null, phoneE164: str(p.phone) || null });
        }
      }
      return { serviceOwnerId, workspaces, adminUserIds, owners };
    },
    async loadThreads(kind, scope) {
      const wsIds = new Set(scope.workspaces.map((w) => w.id));
      const people = new Set([...scope.adminUserIds, ...scope.workspaces.map((w) => w.owner_user_id), ...(scope.serviceOwnerId ? [scope.serviceOwnerId] : [])]);
      if (kind === "owner") {
        const rows: ThreadRow[] = [];
        for (const owner of scope.owners) {
          const byOwner = await pages<ThreadRow>((a, b) => db.from("portal_inbox_thread_records").select(THREAD_COLUMNS).eq("owner_user_id", owner.ownerUserId).not("thread_type", "in", `(${NON_PERSON_TYPES.join(",")})`).range(a, b) as never);
          rows.push(...byOwner);
          if (owner.email) {
            const byEmail = await pages<ThreadRow>((a, b) => db.from("portal_inbox_thread_records").select(THREAD_COLUMNS).eq("participant_email", owner.email!).not("thread_type", "in", `(${NON_PERSON_TYPES.join(",")})`).range(a, b) as never);
            rows.push(...byEmail);
          }
        }
        return [...new Map(rows.map((r) => [r.id, r])).values()];
      }
      const all = await pages<ThreadRow>((a, b) =>
        (kind === "agent_notice"
          ? db.from("portal_inbox_thread_records").select(THREAD_COLUMNS).eq("thread_type", "agent_notice")
          : db.from("portal_inbox_thread_records").select(THREAD_COLUMNS).like("id", "team-thread:%")
        ).order("id").range(a, b) as never,
      );
      return all.filter((t) => {
        const suffix = t.id.includes("__") ? t.id.split("__")[1] : t.id.includes(":ws:") ? t.id.split(":ws:")[1] : "";
        return wsIds.has(str(suffix)) || people.has(str(t.owner_user_id));
      });
    },
    async loadLeadTurns() {
      return pages<LeadTurn>((a, b) => db.from("sms_unassigned_lead_turns").select("id, lead_id, direction, body").order("id").range(a, b) as never);
    },
    async updateThreadMessages(thread, messages) {
      const row = { ...((thread.row_data as Record<string, unknown>) ?? {}), messages };
      let q = db.from("portal_inbox_thread_records").update({ row_data: row }).eq("id", thread.id);
      if (thread.updated_at) q = q.eq("updated_at", thread.updated_at);
      const { data, error } = await q.select("id");
      if (error) throw new Error(error.message);
      return (data ?? []).length ? "ok" : "conflict";
    },
    async deleteThread(thread) {
      let q = db.from("portal_inbox_thread_records").delete().eq("id", thread.id);
      if (thread.updated_at) q = q.eq("updated_at", thread.updated_at);
      const { data, error } = await q.select("id");
      if (error) throw new Error(error.message);
      return (data ?? []).length ? "ok" : "conflict";
    },
    async deleteLeadTurns(ids) {
      let n = 0;
      for (let i = 0; i < ids.length; i += 200) {
        const { data, error } = await db.from("sms_unassigned_lead_turns").delete().in("id", ids.slice(i, i + 200)).select("id");
        if (error) throw new Error(error.message);
        n += (data ?? []).length;
      }
      return n;
    },
  };
}

/** A read-only export (see the header): `{ scope, agent_notice: [], team: [], owner: [], leadTurns: [] }`. Dry run only. */
function fileStore(file: string): Store {
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as { scope: Scope; agent_notice?: ThreadRow[]; team?: ThreadRow[]; owner?: ThreadRow[]; leadTurns?: LeadTurn[] };
  const refuse = async (): Promise<never> => {
    throw new Error("A --source-file export is read-only.");
  };
  return {
    label: `file:${path.basename(file)}`,
    loadScope: async () => data.scope,
    loadThreads: async (kind) => data[kind] ?? [],
    loadLeadTurns: async () => data.leadTurns ?? [],
    updateThreadMessages: refuse,
    deleteThread: refuse,
    deleteLeadTurns: refuse,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------------------------------------------------

type ThreadUpdate = { category: "a" | "b"; thread: ThreadRow; keep: unknown[]; removed: unknown[] };
type Plan = {
  updates: ThreadUpdate[];
  deletes: Array<{ category: "c"; thread: ThreadRow }>;
  leadTurnDeletes: LeadTurn[];
  counts: Record<string, number>;
};

async function buildPlan(store: Store, now: Date): Promise<Plan> {
  const scope = await store.loadScope();
  const updates: ThreadUpdate[] = [];
  const counts: Record<string, number> = {};

  const notices = await store.loadThreads("agent_notice", scope);
  let a = 0;
  let aThreads = 0;
  for (const thread of notices) {
    const plan = planAssistantNoticeCleanup(thread, now);
    if (plan.remove.length === 0) continue;
    updates.push({ category: "a", thread, keep: plan.keep, removed: plan.remove });
    a += plan.remove.length;
    aThreads += 1;
  }
  counts["a_assistant_notices_scanned_threads"] = notices.length;
  counts["a_assistant_notice_threads_changed"] = aThreads;
  counts["a_assistant_notice_messages_removed"] = a;

  const teams = await store.loadThreads("team", scope);
  let b = 0;
  let bThreads = 0;
  for (const thread of teams) {
    const plan = planTeamThreadCleanup(thread);
    if (plan.remove.length === 0) continue;
    updates.push({ category: "b", thread, keep: plan.keep, removed: plan.remove });
    b += plan.remove.length;
    bThreads += 1;
  }
  counts["b_team_threads_scanned"] = teams.length;
  counts["b_team_threads_changed"] = bThreads;
  counts["b_team_automated_lines_removed"] = b;

  const deletes: Plan["deletes"] = [];
  const ownerThreads = await store.loadThreads("owner", scope);
  for (const thread of ownerThreads) {
    const owner = scope.owners.find((o) => o.ownerUserId === str(thread.owner_user_id) || (o.email && o.email === str(thread.participant_email).toLowerCase()));
    if (owner && isDeletableOwnerThread(thread, owner)) deletes.push({ category: "c", thread });
  }
  counts["c_owner_threads_scanned"] = ownerThreads.length;
  counts["c_owner_system_only_threads_deleted"] = deletes.length;

  const turns = await store.loadLeadTurns();
  const nudges = planLeadNudgeCleanup(turns);
  counts["d_lead_turns_scanned"] = turns.length;
  counts["d_leads_with_only_the_nudge"] = nudges.leads;
  counts["d_nudge_turns_removed"] = nudges.remove.length;

  return { updates, deletes, leadTurnDeletes: nudges.remove, counts };
}

// ---------------------------------------------------------------------------------------------------------------------
// Backup and apply
// ---------------------------------------------------------------------------------------------------------------------

function writeBackup(dir: string, ref: string, mode: "dry-run" | "apply", plan: Plan, now: Date): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `inbox-cleanup-${ref}-${mode}-${now.toISOString().replace(/[:.]/g, "-")}.json`);
  const payload = {
    meta: { project: ref, mode, createdAt: now.toISOString(), counts: plan.counts },
    thread_updates: plan.updates.map((u) => ({ category: u.category, row_before: u.thread, removed_messages: u.removed })),
    thread_deletes: plan.deletes.map((d) => ({ category: d.category, row_before: d.thread })),
    lead_turn_deletes: plan.leadTurnDeletes,
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), { flag: "wx" });
  const back = JSON.parse(fs.readFileSync(file, "utf8")) as typeof payload;
  if (back.thread_updates.length !== payload.thread_updates.length || back.thread_deletes.length !== payload.thread_deletes.length || back.lead_turn_deletes.length !== payload.lead_turn_deletes.length) {
    throw new Error(`Backup ${file} did not read back intact; nothing was changed.`);
  }
  return file;
}

async function applyPlan(store: Store, plan: Plan): Promise<Record<string, number>> {
  const done: Record<string, number> = { threads_updated: 0, threads_deleted: 0, lead_turns_deleted: 0, skipped_changed_meanwhile: 0 };
  for (const u of plan.updates) {
    if ((await store.updateThreadMessages(u.thread, u.keep)) === "ok") done.threads_updated += 1;
    else done.skipped_changed_meanwhile += 1;
  }
  for (const d of plan.deletes) {
    if ((await store.deleteThread(d.thread)) === "ok") done.threads_deleted += 1;
    else done.skipped_changed_meanwhile += 1;
  }
  done.lead_turns_deleted = await store.deleteLeadTurns(plan.leadTurnDeletes.map((t) => t.id));
  return done;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let store: Store;
  let ref = "file";
  if (args.sourceFile) {
    if (args.apply) throw new Error("--source-file is a read-only export: use it without --apply.");
    store = fileStore(args.sourceFile);
  } else {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || process.env.SUPABASE_URL?.trim() || "";
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
    if (!url || !key) throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (e.g. --env-file=.env.local).");
    ref = projectRefOf(url);
    assertInboxCleanupWriteAllowed(ref, args.apply);
    store = supabaseStore(createClient(url, key, { auth: { persistSession: false } }), ref);
  }
  console.log(`inbox-cleanup  project=${ref}  mode=${args.apply ? "APPLY" : "dry-run"}${ref === PRODUCTION_REF && !args.apply ? "  (production: read-only)" : ""}`);

  const plan = await buildPlan(store, args.now);
  console.log("\nPer-category counts");
  for (const [k, v] of Object.entries(plan.counts)) console.log(`  ${k.padEnd(42)} ${v}`);

  const nothing = plan.updates.length === 0 && plan.deletes.length === 0 && plan.leadTurnDeletes.length === 0;
  if (nothing) {
    console.log("\nNothing to do (already clean).");
    return;
  }
  // Every row that would change is saved first, in dry run too, so the plan can be reviewed and is the restore file.
  const backup = writeBackup(args.backupDir, ref, args.apply ? "apply" : "dry-run", plan, args.now);
  console.log(`\n${args.apply ? "Backup (written before any change)" : "Plan / would-be backup"}: ${backup}`);
  if (!args.apply) {
    console.log("Dry run: nothing was changed. Re-run with --apply to make these changes.");
    return;
  }
  const done = await applyPlan(store, plan);
  console.log("\nApplied");
  for (const [k, v] of Object.entries(done)) console.log(`  ${k.padEnd(28)} ${v}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
