import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { propertyLabel } from "@/lib/one-number/router-lookups.server";
import { postToHouseGroup, type PostDeps } from "./post.server";
import { loadGroupsWithStatus, loadMembers, loadSettings } from "./store.server";
import type { HouseGroupPostResult } from "./types";

export const ANNOUNCE_MAX_CHARS = 320;

export type ChatHouse = { propertyId: string; label: string; members: number };

export type AnnounceOutcome = { propertyId: string; label: string; result: HouseGroupPostResult };

/**
 * The houses in a workspace that have a live group chat, optionally narrowed to the ids a caller may
 * touch (`allowedPropertyIds`, null = every house of the workspace). Labels are house names only.
 */
export async function listChatHouses(
  db: SupabaseClient,
  input: { workspaceId: string; allowedPropertyIds?: readonly string[] | null },
): Promise<ChatHouse[]> {
  const settings = await loadSettings(db, input.workspaceId);
  if (!settings.enabled) return [];
  const groups = (await loadGroupsWithStatus(db, ["active"], input.workspaceId)).filter(
    (g) => !input.allowedPropertyIds || input.allowedPropertyIds.includes(g.propertyId),
  );
  const out: ChatHouse[] = [];
  for (const group of groups) {
    let label = group.propertyId;
    try {
      const { data } = await db.from("manager_property_records").select("row_data").eq("id", group.propertyId).maybeSingle();
      label = propertyLabel((data as { row_data?: unknown } | null)?.row_data) || label;
    } catch {
      /* the id is the label's last resort */
    }
    out.push({ propertyId: group.propertyId, label, members: (await loadMembers(db, group.id)).length });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Post a manager's announcement to the chosen houses. `requestKey` makes the whole send idempotent:
 * a repeat of the same request posts nothing twice. Each house answers on its own (a house in quiet
 * hours reports `quiet_hours` and the rest still go).
 */
export async function announceToHouses(
  db: SupabaseClient,
  input: { workspaceId: string; propertyIds: readonly string[]; text: string; requestKey: string },
  deps: PostDeps = {},
): Promise<AnnounceOutcome[]> {
  const text = input.text.replace(/\s+/g, " ").trim().slice(0, ANNOUNCE_MAX_CHARS);
  const houses = await listChatHouses(db, { workspaceId: input.workspaceId, allowedPropertyIds: input.propertyIds });
  const byId = new Map(houses.map((h) => [h.propertyId, h] as const));
  const out: AnnounceOutcome[] = [];
  for (const propertyId of input.propertyIds) {
    const house = byId.get(propertyId);
    if (!house) {
      out.push({ propertyId, label: propertyId, result: { ok: false, reason: "no_group" } });
      continue;
    }
    const result = await postToHouseGroup(
      db,
      { workspaceId: input.workspaceId, propertyId, text, kind: "announcement", idempotencyKey: `announce:${input.requestKey}:${propertyId}` },
      deps,
    );
    out.push({ propertyId, label: house.label, result });
  }
  return out;
}

export function announceOutcomeLine(outcomes: readonly AnnounceOutcome[]): string {
  const sent = outcomes.filter((o) => o.result.ok).map((o) => o.label);
  const held = outcomes.filter((o) => !o.result.ok);
  const parts: string[] = [];
  if (sent.length > 0) parts.push(`Posted to ${sent.join(", ")}.`);
  for (const o of held) {
    const why = !o.result.ok
      ? o.result.reason === "quiet_hours"
        ? "it is between 10 pm and 8 am, so nothing posts until morning"
        : o.result.reason === "no_group"
          ? "it has no house chat yet"
          : o.result.reason === "not_enabled"
            ? "house chat is off"
            : o.result.reason === "rate_limited"
              ? "it hit its daily limit"
              : "it could not be sent"
      : "";
    parts.push(`${o.label}: ${why}.`);
  }
  return parts.join(" ") || "Nothing was posted.";
}
