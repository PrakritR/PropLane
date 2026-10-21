import "server-only";

import { createHash } from "node:crypto";
import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { pacificDayKey } from "@/lib/house-groups/time";
import type { OccupancyStayLike } from "@/lib/house-groups/stay-members";
import { workspaceOwner } from "@/lib/house-groups/store.server";
import { propertyLabel } from "@/lib/one-number/router-lookups.server";
import { MANAGER_INBOX_STORAGE_KEY, RESIDENT_INBOX_STORAGE_KEY } from "@/lib/portal-inbox-storage";
import { accountKey, emailKey, workspaceKey } from "@/lib/communication/conversation-key";
import { HOUSE_THREAD_TYPE } from "@/lib/house-thread-id";
import { loadOwnerStays } from "./access.server";
import {
  diffHouseResidents,
  houseResidentsFromStays,
  planMoveOutArchives,
  readHouseChatState,
  type HouseResident,
  type MoveOutPlan,
} from "./model";
import { appendHouseLine, ensureHouseThread, loadHouseThread, saveHouseRoster } from "./store.server";
import { houseThreadId } from "@/lib/house-thread-id";

/**
 * Keeps the in-app house chats and the move-out archive in step with the Bookings occupancy snapshot.
 * Idempotent end to end: a run that finds nothing to change writes nothing. Runs on lease signing and on
 * an early move-out (`syncHouseChatForPropertyId`) and daily (`/api/cron/house-group-sync`).
 *
 * Reads who SHOULD be in each house chat from the occupancy snapshot, compares it to the stored roster,
 * posts a "Welcome <first name>" line for joiners, and drops leavers silently (no announcement). Access
 * itself never depends on the roster (`access.server.ts` re-derives it), so a missed run only delays a
 * welcome line, never admits or keeps a person.
 */

type Db = SupabaseClient;
type Row = Record<string, unknown>;

/** Thread types that are never a one-on-one conversation with a resident. */
const NOT_ONE_ON_ONE = new Set(["team", HOUSE_THREAD_TYPE, "agent_notice", "resident_agent", "vendor_agent"]);

export type HouseSyncResult = {
  propertyId: string;
  outcome: "no_house" | "no_owner" | "no_residents" | "unchanged" | "created" | "updated" | "error";
  joined: number;
  left: number;
};

export type SyncDeps = {
  now?: () => Date;
  /** Stays of every house of the workspace, when the caller already read them. */
  stays?: readonly OccupancyStayLike[];
  houseIds?: readonly string[];
};

async function workspaceHouses(db: Db, workspaceId: string): Promise<{ id: string; label: string }[]> {
  try {
    const { data } = await db.from("manager_property_records").select("id, row_data").eq("workspace_id", workspaceId).limit(500);
    return ((data ?? []) as Row[])
      .map((row) => ({ id: String(row.id ?? "").trim(), label: propertyLabel(row.row_data) || "your house" }))
      .filter((house) => house.id);
  } catch {
    return [];
  }
}

function welcomeText(joined: readonly HouseResident[]): string {
  const names = joined.map((resident) => resident.firstName);
  if (names.length === 1) return `Welcome ${names[0]}`;
  return `Welcome ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Make one house's chat match its residents. A house with no current long-term resident gets no new chat
 * (an existing one is kept, its roster emptied). Needs `workspaceId`, `propertyId` and the house's label.
 */
export async function syncHouseChat(
  db: Db,
  input: { workspaceId: string; ownerUserId: string; propertyId: string; houseLabel: string },
  deps: SyncDeps = {},
): Promise<HouseSyncResult> {
  const base: HouseSyncResult = { propertyId: input.propertyId, outcome: "unchanged", joined: 0, left: 0 };
  const now = (deps.now ?? (() => new Date()))();
  const today = pacificDayKey(now);
  try {
    const stays = deps.stays ?? (await loadOwnerStays(db, input.ownerUserId, [input.propertyId]));
    const residents = houseResidentsFromStays(stays, { propertyId: input.propertyId, today });
    const threadId = houseThreadId(input.ownerUserId, input.workspaceId, input.propertyId);
    const existing = await loadHouseThread(db, threadId);
    if (residents.length === 0) {
      if (!existing) return { ...base, outcome: "no_residents" };
      const stored = readHouseChatState(existing.rowData).residents;
      if (stored.length === 0) return { ...base, outcome: "no_residents" };
      await saveHouseRoster(db, threadId, []);
      return { ...base, outcome: "updated", left: stored.length };
    }
    const ensured = await ensureHouseThread(db, {
      ownerUserId: input.ownerUserId,
      workspaceId: input.workspaceId,
      propertyId: input.propertyId,
      houseLabel: input.houseLabel,
    });
    if (!ensured) return { ...base, outcome: "error" };
    const current = existing ?? (await loadHouseThread(db, ensured));
    const storedResidents = current ? readHouseChatState(current.rowData).residents : [];
    const diff = diffHouseResidents(storedResidents, residents);
    if (diff.same) return { ...base, outcome: existing ? "unchanged" : "created" };
    const joinedAtByEmail = new Map(storedResidents.map((r) => [r.email, r.joinedAt] as const));
    const nowIso = now.toISOString();
    await saveHouseRoster(
      db,
      ensured,
      residents.map((resident) => ({ ...resident, joinedAt: joinedAtByEmail.get(resident.email) ?? nowIso })),
    );
    if (diff.joined.length > 0) {
      const digest = createHash("sha256")
        .update(diff.joined.map((r) => `${r.email}:${r.moveIn}`).sort().join("|"))
        .digest("hex")
        .slice(0, 24);
      await appendHouseLine(db, ensured, {
        id: `welcome:${digest}`,
        from: "PropLane",
        body: welcomeText(diff.joined),
        system: true,
      });
    }
    return { ...base, outcome: existing ? "updated" : "created", joined: diff.joined.length, left: diff.leftEmails.length };
  } catch {
    return { ...base, outcome: "error" };
  }
}

// ---- move-out -> archive ----

export type ArchiveResult = { residents: number; archived: number; errors: number };

type ThreadRow = { id: string; scope: string; thread_type: string | null; row_data: Record<string, unknown> | null };

async function profilesByEmail(db: Db, emails: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (emails.length === 0) return out;
  try {
    const { data } = await db.from("profiles").select("id, email").in("email", [...emails]);
    for (const row of (data ?? []) as Row[]) {
      const email = String(row.email ?? "").trim().toLowerCase();
      const id = String(row.id ?? "").trim();
      if (email && id) out.set(email, id);
    }
  } catch {
    /* no account found: only the email-keyed rows are reachable */
  }
  return out;
}

function isOneOnOne(row: ThreadRow): boolean {
  const type = String(row.thread_type ?? "");
  if (NOT_ONE_ON_ONE.has(type)) return false;
  const id = String(row.id);
  return !/^(team-thread:|house-thread:|agent_notice_|resident-agent-|vendor_agent_)/.test(id);
}

/** Conversations of one ended resident that still sit in Active and have not been auto-archived for this move-out. */
async function activeConversationsOf(
  db: Db,
  input: { workspaceId: string; ownerUserId: string; plan: MoveOutPlan; userId: string | null },
): Promise<{ manager: ThreadRow[]; resident: ThreadRow[] }> {
  const columns = "id, scope, thread_type, row_data";
  const managerKeys = [emailKey(input.plan.email), ...(input.userId ? [accountKey(input.userId)] : [])];
  const manager = await db
    .from("portal_inbox_thread_records")
    .select(columns)
    .eq("scope", MANAGER_INBOX_STORAGE_KEY)
    .eq("owner_user_id", input.ownerUserId)
    .eq("workspace_id", input.workspaceId)
    .in("conversation_key", managerKeys)
    .limit(20);
  const resident = input.userId
    ? await db
        .from("portal_inbox_thread_records")
        .select(columns)
        .eq("scope", RESIDENT_INBOX_STORAGE_KEY)
        .eq("owner_user_id", input.userId)
        .eq("workspace_id", input.workspaceId)
        .eq("conversation_key", workspaceKey(input.workspaceId))
        .limit(20)
    : { data: [] as Row[] };
  const keep = (rows: unknown): ThreadRow[] =>
    ((rows ?? []) as ThreadRow[]).filter((row) => {
      if (!isOneOnOne(row)) return false;
      const data = row.row_data ?? {};
      if (String(data.folder ?? "") === "trash") return false;
      // Archived once for this move-out already (and restored since): leave the manager's choice alone.
      const marked = String(data.autoArchivedEndedOn ?? "");
      return !(marked && marked >= input.plan.endedOn);
    });
  return { manager: keep(manager.data), resident: keep(resident.data) };
}

async function archiveRows(db: Db, rows: readonly ThreadRow[], scope: string, endedOn: string): Promise<number> {
  if (rows.length === 0) return 0;
  const ids = rows.map((row) => row.id);
  // The one archive mechanism: Archived is the `trash` folder, set by this function for every portal.
  const { data, error } = await db.rpc("change_portal_inbox_thread_folders", { p_ids: ids, p_scope: scope, p_action: "archive" });
  if (error || data !== "ok") return 0;
  for (const id of ids) {
    // Bookkeeping only: which move-out archived it, so a conversation the manager restores stays restored.
    await db
      .from("portal_inbox_thread_records")
      .select("row_data, updated_at")
      .eq("id", id)
      .maybeSingle()
      .then(async ({ data: stored }) => {
        const row = stored as { row_data?: Record<string, unknown>; updated_at?: string } | null;
        if (!row?.row_data) return;
        await db
          .from("portal_inbox_thread_records")
          .update({ row_data: { ...row.row_data, autoArchivedEndedOn: endedOn } })
          .eq("id", id)
          .eq("updated_at", row.updated_at ?? "");
      });
  }
  return ids.length;
}

/**
 * Residents whose residency in this workspace has ended: archive their one-on-one conversation(s) with
 * the workspace on BOTH sides (the manager's Archived tab and the resident's). A resident with another
 * current, open-ended or upcoming long-term stay anywhere in the workspace is never touched. If they
 * message again the existing unarchive-on-new-message rule moves the conversation back to Active
 * (`deliverPortalMessageThreadSide`, `reopens`).
 */
export async function archiveMovedOutConversations(
  db: Db,
  input: { workspaceId: string; ownerUserId: string; stays: readonly OccupancyStayLike[]; today: string },
): Promise<ArchiveResult> {
  const result: ArchiveResult = { residents: 0, archived: 0, errors: 0 };
  const plans = planMoveOutArchives(input.stays, { today: input.today });
  result.residents = plans.length;
  if (plans.length === 0) return result;
  const userIds = await profilesByEmail(db, plans.map((p) => p.email));
  for (const plan of plans) {
    try {
      const userId = userIds.get(plan.email) ?? null;
      const found = await activeConversationsOf(db, { workspaceId: input.workspaceId, ownerUserId: input.ownerUserId, plan, userId });
      result.archived += await archiveRows(db, found.manager, MANAGER_INBOX_STORAGE_KEY, plan.endedOn);
      result.archived += await archiveRows(db, found.resident, RESIDENT_INBOX_STORAGE_KEY, plan.endedOn);
    } catch {
      result.errors += 1;
    }
  }
  return result;
}

// ---- batch entry points ----

export type WorkspaceSyncSummary = { houses: number; created: number; updated: number; errors: number; archived: number; outcomes?: HouseSyncResult[] };

/** One workspace: every house's chat, then the move-out archive, from one read of the workspace's stays. */
export async function syncWorkspaceHouseChats(db: Db, workspaceId: string, deps: SyncDeps & { ownerUserId?: string } = {}): Promise<WorkspaceSyncSummary> {
  const summary: WorkspaceSyncSummary = { houses: 0, created: 0, updated: 0, errors: 0, archived: 0 };
  const ownerUserId = deps.ownerUserId ?? (await workspaceOwner(db, workspaceId));
  if (!ownerUserId) return summary;
  const houses = await workspaceHouses(db, workspaceId);
  if (houses.length === 0) return summary;
  let stays: readonly OccupancyStayLike[];
  try {
    stays = deps.stays ?? (await loadOwnerStays(db, ownerUserId, houses.map((h) => h.id)));
  } catch {
    summary.errors += 1;
    return summary;
  }
  const now = deps.now ?? (() => new Date());
  summary.outcomes = [];
  for (const house of houses) {
    summary.houses += 1;
    const r = await syncHouseChat(db, { workspaceId, ownerUserId, propertyId: house.id, houseLabel: house.label }, { stays, now });
    summary.outcomes.push(r);
    if (r.outcome === "created") summary.created += 1;
    else if (r.outcome === "updated") summary.updated += 1;
    else if (r.outcome === "error") summary.errors += 1;
  }
  const archived = await archiveMovedOutConversations(db, { workspaceId, ownerUserId, stays, today: pacificDayKey(now()) });
  summary.archived = archived.archived;
  summary.errors += archived.errors;
  return summary;
}

/** The daily batch: every workspace. A failing workspace never stops the others. */
export async function syncAllHouseChats(db: Db, deps: { now?: () => Date } = {}): Promise<WorkspaceSyncSummary & { workspaces: number }> {
  const total = { workspaces: 0, houses: 0, created: 0, updated: 0, errors: 0, archived: 0 };
  let workspaces: Row[] = [];
  try {
    const { data } = await db.from("portal_workspaces").select("id, owner_user_id").limit(1000);
    workspaces = (data ?? []) as Row[];
  } catch {
    return total;
  }
  for (const w of workspaces) {
    const workspaceId = String(w.id ?? "").trim();
    const ownerUserId = String(w.owner_user_id ?? "").trim();
    if (!workspaceId || !ownerUserId) continue;
    try {
      const s = await syncWorkspaceHouseChats(db, workspaceId, { ownerUserId, now: deps.now });
      if (s.houses === 0) continue;
      total.workspaces += 1;
      total.houses += s.houses;
      total.created += s.created;
      total.updated += s.updated;
      total.errors += s.errors;
      total.archived += s.archived;
    } catch {
      total.errors += 1;
    }
  }
  return total;
}

/**
 * After a lease is signed or a move-out date moves: re-sync that house's workspace now instead of waiting
 * for the daily run. Never throws; safe to fire and forget.
 */
export async function syncHouseChatForPropertyId(db: Db, propertyId: string): Promise<WorkspaceSyncSummary | null> {
  try {
    const { data } = await db.from("manager_property_records").select("workspace_id").eq("id", propertyId).maybeSingle();
    const workspaceId = String((data as Row | null)?.workspace_id ?? "").trim();
    if (!workspaceId) return null;
    return await syncWorkspaceHouseChats(db, workspaceId);
  } catch {
    return null;
  }
}

/** Fire-and-forget form of `syncHouseChatForPropertyId` for a request handler: runs after the response. */
export function queueHouseChatSyncForProperty(db: Db, propertyId: string | null | undefined): void {
  const id = String(propertyId ?? "").trim();
  if (!id) return;
  const task = () => syncHouseChatForPropertyId(db, id).then(() => undefined);
  try {
    after(task);
  } catch {
    void task();
  }
}
