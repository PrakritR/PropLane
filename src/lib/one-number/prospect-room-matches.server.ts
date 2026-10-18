import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { MockProperty } from "@/data/types";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { loadSharedLineConfig, workspaceOnSharedLine } from "@/lib/one-number/config.server";
import { buildOfferText, matchRooms, offerFromRow } from "@/lib/one-number/lead-match";
import { pacificToday, toGsm7, type LeadProfile } from "@/lib/one-number/lead-qualifying";
import { e164FromPhoneKey } from "@/lib/one-number/unassigned-leads.server";
import { sendSharedLineMessage } from "@/lib/one-number/send.server";
import type { SharedLineSendResult } from "@/lib/one-number/contracts";
import type { RoomListingRow } from "@/lib/room-listings-catalog";
import { quietHoursBlocks } from "@/lib/sms/number-registration-policy";
import { getCrawlPublicListings } from "@/lib/seo/public-catalog.server";

/**
 * A new room that fits a past prospect's saved criteria: text them once.
 *
 * "Past prospect" here is a lead a team already owns (`sms_unassigned_leads.status = 'assigned'`,
 * which keeps the qualifying answers on `profile`). The first sweep that meets a prospect only
 * REMEMBERS the rooms that fit today (`roomsSeen`); a later sweep that finds a fitting room it has
 * not seen texts them, once, and records `newRoomTexted` so it never texts again. Only the team's
 * own houses are searched, so a prospect of team A is never offered team B's room. A STOP, quiet
 * hours or an unbilled workspace simply leave the prospect for the next sweep.
 */

export const PROSPECT_MATCH_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

export type ProspectProfile = LeadProfile & {
  /** `${propertyId}::${roomId}` of every fitting room already known. */
  roomsSeen?: string[];
  /** ISO time the one new-room text went out. */
  newRoomTexted?: string;
};

type Row = Record<string, unknown>;

export type ProspectMatchSummary = {
  considered: number;
  remembered: number;
  texted: number;
  skipped?: "not_shared_mode" | "quiet_hours";
};

export type ProspectMatchDeps = {
  now?: () => Date;
  listings?: () => Promise<MockProperty[]>;
  origin?: () => string;
  send?: (db: SupabaseClient, input: { workspaceId: string; ownerUserId: string; toPhone: string; body: string; idempotencyKey: string }) => Promise<SharedLineSendResult>;
};

export const roomKey = (row: Pick<RoomListingRow, "propertyId" | "roomId">) => `${row.propertyId}::${row.roomId}`;

/** True when the prospect told us enough to match on. */
export function hasSavedCriteria(profile: LeadProfile): boolean {
  return profile.budgetMax !== undefined || Boolean(profile.area) || profile.moveInDate !== undefined;
}

/** Fitting rooms the prospect has not been told about. No baseline yet = nothing is new (it is recorded first). */
export function newFittingRooms(seen: readonly string[] | undefined, rows: readonly RoomListingRow[]): RoomListingRow[] {
  if (!seen) return [];
  const known = new Set(seen);
  return rows.filter((row) => !known.has(roomKey(row)));
}

export async function runProspectRoomMatches(db: SupabaseClient, depsIn: ProspectMatchDeps = {}): Promise<ProspectMatchSummary> {
  const now = depsIn.now ?? (() => new Date());
  const summary: ProspectMatchSummary = { considered: 0, remembered: 0, texted: 0 };
  const config = await loadSharedLineConfig(db);
  if (config.mode !== "shared") return { ...summary, skipped: "not_shared_mode" };
  if (quietHoursBlocks("automated", now())) return { ...summary, skipped: "quiet_hours" };

  const floor = new Date(now().getTime() - PROSPECT_MATCH_WINDOW_MS).toISOString();
  const { data, error } = await db
    .from("sms_unassigned_leads")
    .select("id, phone_key, profile, assigned_workspace_id, last_inbound_at, updated_at")
    .eq("status", "assigned")
    .not("assigned_workspace_id", "is", null)
    .gt("last_inbound_at", floor)
    .order("last_inbound_at", { ascending: false })
    .limit(200);
  if (error) return summary;
  const leads = ((data ?? []) as Row[]).filter((row) => {
    const profile = (row.profile && typeof row.profile === "object" ? row.profile : {}) as ProspectProfile;
    return !profile.newRoomTexted && hasSavedCriteria(profile) && workspaceOnSharedLine(config, String(row.assigned_workspace_id));
  });
  if (leads.length === 0) return summary;

  // Each workspace's own houses (and its owner), read once.
  const workspaceIds = [...new Set(leads.map((row) => String(row.assigned_workspace_id)))];
  const { data: houses } = await db.from("manager_property_records").select("id, workspace_id").in("workspace_id", workspaceIds);
  const housesByWorkspace = new Map<string, Set<string>>();
  for (const house of (houses ?? []) as Row[]) {
    const id = String(house.workspace_id);
    housesByWorkspace.set(id, (housesByWorkspace.get(id) ?? new Set()).add(String(house.id)));
  }
  const { data: workspaces } = await db.from("portal_workspaces").select("id, owner_user_id").in("id", workspaceIds);
  const ownerOf = new Map(((workspaces ?? []) as Row[]).map((w) => [String(w.id), String(w.owner_user_id)] as const));

  const catalog = await (depsIn.listings ?? getCrawlPublicListings)().catch(() => [] as MockProperty[]);
  const send = depsIn.send ?? sendSharedLineMessage;
  const today = pacificToday(now());

  for (const raw of leads) {
    summary.considered += 1;
    const id = String(raw.id);
    const workspaceId = String(raw.assigned_workspace_id);
    const ownerUserId = ownerOf.get(workspaceId);
    if (!ownerUserId) continue;
    const profile = (raw.profile && typeof raw.profile === "object" ? raw.profile : {}) as ProspectProfile;
    const own = housesByWorkspace.get(workspaceId) ?? new Set<string>();
    const rows = matchRooms(catalog.filter((p) => own.has(p.id)), profile, today, 50);
    const stamp = String(raw.updated_at);

    const claim = async (next: ProspectProfile) => {
      const { data: won } = await db
        .from("sms_unassigned_leads")
        .update({ profile: next, updated_at: now().toISOString() })
        .eq("id", id)
        .eq("status", "assigned")
        .eq("updated_at", stamp)
        .select("id");
      return Boolean(won?.length);
    };

    if (!profile.roomsSeen) {
      if (await claim({ ...profile, roomsSeen: rows.map(roomKey) })) summary.remembered += 1;
      continue;
    }
    const fresh = newFittingRooms(profile.roomsSeen, rows);
    if (fresh.length === 0) continue;

    // The flag goes down BEFORE the text, so two overlapping sweeps cannot both send.
    const offers = fresh.slice(0, 3).map((row, i) => offerFromRow(row, i + 1));
    const next: ProspectProfile = { ...profile, roomsSeen: rows.map(roomKey), newRoomTexted: now().toISOString() };
    if (!(await claim(next))) continue;
    const body = toGsm7(`A room that fits just opened.\n${buildOfferText(offers, (depsIn.origin ?? resolveEmailLinkBaseUrl)())}`);
    const result = await send(db, {
      workspaceId,
      ownerUserId,
      toPhone: e164FromPhoneKey(String(raw.phone_key)),
      body,
      idempotencyKey: `prospect-new-room:${id}`,
    });
    if (result.ok) summary.texted += 1;
    // Someone who said STOP is never retried: the flag stays. Any other failure (billing, provider) hands
    // the prospect back to a later sweep.
    else if (result.reason !== "opted_out") await db.from("sms_unassigned_leads").update({ profile, updated_at: stamp }).eq("id", id).eq("status", "assigned");
  }
  return summary;
}
