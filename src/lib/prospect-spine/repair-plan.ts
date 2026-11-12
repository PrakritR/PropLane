/**
 * Pure planner behind `scripts/repair-prospect-threads.mts` (design-1112 section 0). Two repairs, nothing else:
 *
 *  1. FOLD: one owner holding several `sms_notice_*` threads for the SAME phone becomes one thread. The keeper (the row that
 *     already carries a conversation key, else the newest) gains every turn it does not hold; the others are left as pointers
 *     (`mergedInto`, folder `trash`). Nothing is deleted.
 *  2. STAMP: a keeper owned by the owner of a PropLane-managed (`is_service`) workspace, with no workspace or conversation key
 *     on the row, is stamped with that workspace and the phone key, so the staff who run the workspace can read it.
 *
 * Idempotent: a second plan over the result has nothing to do. Never touches a row owned by anyone but a managed workspace's
 * owner for stamping, and never folds across owners.
 */
import { parseInboxStampMs } from "@/lib/portal-inbox-storage";

export type RepairRow = {
  id: string;
  owner_user_id: string | null;
  workspace_id: string | null;
  conversation_key: string | null;
  scope?: string | null;
  updated_at: string | null;
  row_data: Record<string, unknown> | null;
};
export type RepairWorkspace = { id: string; owner_user_id: string; is_service: boolean };

export type FoldAction = { kind: "fold"; keepId: string; absorbIds: string[]; ownerUserId: string; phone: string; messages: Record<string, unknown>[]; addedTurns: number };
export type StampAction = { kind: "stamp"; id: string; ownerUserId: string; workspaceId: string; key: string };
export type RepairPlan = { actions: Array<FoldAction | StampAction>; skipped: Array<{ id: string; reason: string }> };

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

function turnsOf(rowData: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const rootId = str(rowData.rootMessageId);
  if (rootId) {
    out.push({
      id: rootId, from: rowData.from, body: rowData.body, at: str(rowData.rootAt) || str(rowData.time),
      outbound: rowData.rootOutbound === true, channel: str(rowData.rootChannel) || "sms",
      ...(str(rowData.rootHouseId) ? { houseId: str(rowData.rootHouseId) } : {}),
    });
  }
  for (const m of (Array.isArray(rowData.messages) ? rowData.messages : []) as Record<string, unknown>[]) if (str(m?.id)) out.push(m);
  return out;
}

export function planProspectRepair(rows: readonly RepairRow[], workspaces: readonly RepairWorkspace[]): RepairPlan {
  const actions: RepairPlan["actions"] = [];
  const skipped: RepairPlan["skipped"] = [];
  const live = rows.filter((r) => r.id.startsWith("sms_notice_") && str(r.owner_user_id) && str(r.row_data?.smsNoticePhone) && str(r.row_data?.folder) !== "trash" && !str(r.row_data?.mergedInto));

  const groups = new Map<string, RepairRow[]>();
  for (const row of live) {
    const key = `${str(row.owner_user_id)}|${str(row.row_data!.smsNoticePhone)}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  const keepers: RepairRow[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => {
      const keyed = Number(Boolean(b.conversation_key)) - Number(Boolean(a.conversation_key));
      return keyed || Date.parse(str(b.updated_at)) - Date.parse(str(a.updated_at));
    });
    const keeper = sorted[0]!;
    keepers.push(keeper);
    const others = sorted.slice(1);
    if (others.length === 0) continue;
    const held = new Set(turnsOf(keeper.row_data!).map((t) => str(t.id)));
    const fresh: Record<string, unknown>[] = [];
    for (const other of others) for (const turn of turnsOf(other.row_data!)) {
      if (!held.has(str(turn.id))) { held.add(str(turn.id)); fresh.push(turn); }
    }
    const rootId = str(keeper.row_data!.rootMessageId);
    const merged = [...turnsOf(keeper.row_data!), ...fresh]
      .filter((t) => str(t.id) !== rootId)
      .map((t, index) => ({ t, index, at: parseInboxStampMs(str(t.at)) }))
      .sort((a, b) => (a.at != null && b.at != null && a.at !== b.at ? a.at - b.at : a.index - b.index))
      .map((x) => x.t);
    actions.push({
      kind: "fold", keepId: keeper.id, absorbIds: others.map((o) => o.id), ownerUserId: str(keeper.owner_user_id),
      phone: str(keeper.row_data!.smsNoticePhone), messages: merged, addedTurns: fresh.length,
    });
  }

  const serviceByOwner = new Map<string, RepairWorkspace[]>();
  const allByOwner = new Map<string, RepairWorkspace[]>();
  for (const w of workspaces) {
    allByOwner.set(w.owner_user_id, [...(allByOwner.get(w.owner_user_id) ?? []), w]);
    if (w.is_service) serviceByOwner.set(w.owner_user_id, [...(serviceByOwner.get(w.owner_user_id) ?? []), w]);
  }
  for (const keeper of keepers) {
    const owner = str(keeper.owner_user_id);
    if (!serviceByOwner.has(owner)) continue;
    if (keeper.workspace_id && keeper.conversation_key) continue;
    const named = str(keeper.row_data!.workspaceId);
    const candidates = allByOwner.get(owner) ?? [];
    const target = (named && candidates.find((w) => w.id === named && w.is_service)) || (candidates.length === 1 && candidates[0]!.is_service ? candidates[0]! : null);
    if (!target) {
      skipped.push({ id: keeper.id, reason: "owner has several workspaces and the row names none" });
      continue;
    }
    actions.push({ kind: "stamp", id: keeper.id, ownerUserId: owner, workspaceId: target.id, key: `tel:${str(keeper.row_data!.smsNoticePhone)}` });
  }
  return { actions, skipped };
}
