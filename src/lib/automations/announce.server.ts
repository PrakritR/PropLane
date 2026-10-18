import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadWorkspaceProperties } from "@/lib/one-number/knowledge/scope.server";
import { fireAutomation, type FireOutcome } from "./fire.server";
import { loadHouseDirectory, loadLeaseSubjects } from "./sources.server";
import { GROUP_VIOLATION_MESSAGES, groupTextViolations } from "./templates";

/**
 * "announce: water off Tuesday 9-12", from a manager's text or the dashboard button. One announcement
 * fans to the chosen houses (or all of them); each house gets the text in its group, or one on one
 * to each resident when it has no group. The text is the manager's own, so it is held to the group
 * rule: no resident's name, no amount, no door or Wi-Fi secret.
 */

export type AnnounceHouse = { id: string; label: string };

/** The houses an actor may announce to: the workspace's own, narrowed to a co-manager's assigned houses. */
export async function listAnnounceHouses(
  db: SupabaseClient,
  input: { ownerUserId: string; workspaceId: string; allowedPropertyIds: readonly string[] | null },
): Promise<AnnounceHouse[]> {
  const briefs = await loadWorkspaceProperties(db, input.ownerUserId, input.workspaceId, input.allowedPropertyIds);
  return briefs.map((b) => ({ id: b.id, label: b.label }));
}

export type AnnounceResult =
  | { ok: true; announcementId: string; houses: Array<{ propertyId: string; label: string; outcome: FireOutcome["status"]; reason?: string }> }
  | { ok: false; error: "empty" | "too_long" | "no_houses" | "needs_house"; message: string; houses?: AnnounceHouse[] };

export const MAX_ANNOUNCEMENT_LENGTH = 300;

/** Pure: why this announcement cannot go to a house group, for the composer to show before sending. */
export function announcementProblem(text: string, input: { residentFirstNames: readonly string[]; houseInfo: Parameters<typeof groupTextViolations>[1]["houseInfo"] }): string | null {
  const clean = String(text ?? "").trim();
  if (!clean) return "Write the announcement.";
  if (clean.length > MAX_ANNOUNCEMENT_LENGTH) return `Keep it under ${MAX_ANNOUNCEMENT_LENGTH} characters.`;
  const violations = groupTextViolations(clean, { residentFirstNames: input.residentFirstNames, houseInfo: input.houseInfo });
  return violations.length > 0 ? GROUP_VIOLATION_MESSAGES[violations[0]!] : null;
}

export async function announceToHouses(
  db: SupabaseClient,
  input: {
    ownerUserId: string;
    workspaceId: string;
    allowedPropertyIds: readonly string[] | null;
    /** House ids to announce to, or "all" for every house the actor may reach. */
    propertyIds: readonly string[] | "all";
    text: string;
    /** Stable per announcement so a retry never repeats it. Defaults to a fresh id. */
    announcementId?: string;
  },
): Promise<AnnounceResult> {
  const text = String(input.text ?? "").replace(/\s+/g, " ").trim();
  if (!text) return { ok: false, error: "empty", message: "Write the announcement." };
  if (text.length > MAX_ANNOUNCEMENT_LENGTH) {
    return { ok: false, error: "too_long", message: `Keep it under ${MAX_ANNOUNCEMENT_LENGTH} characters.` };
  }

  const reachable = await listAnnounceHouses(db, input);
  if (reachable.length === 0) return { ok: false, error: "no_houses", message: "There are no houses to announce to." };
  let chosen: AnnounceHouse[];
  if (input.propertyIds === "all") chosen = reachable;
  else {
    // An id from a body or a model is only a request: it must be one of the actor's own houses.
    const wanted = new Set(input.propertyIds);
    chosen = reachable.filter((h) => wanted.has(h.id));
  }
  if (chosen.length === 0) {
    return { ok: false, error: "needs_house", message: "Which house?", houses: reachable };
  }

  const houses = await loadHouseDirectory(db, chosen.map((h) => h.id));
  const leases = await loadLeaseSubjects(db, { onlyOwner: input.ownerUserId, houses });
  const announcementId = input.announcementId ?? randomUUID();
  const results: Array<{ propertyId: string; label: string; outcome: FireOutcome["status"]; reason?: string }> = [];
  for (const house of chosen) {
    const subject = houses.get(house.id);
    if (!subject || subject.workspaceId !== input.workspaceId || subject.ownerUserId !== input.ownerUserId) continue;
    const outcome = await fireAutomation(db, {
      workspaceId: input.workspaceId,
      ownerUserId: input.ownerUserId,
      preset: "announcement",
      idempotencyKey: `announce:${announcementId}:${house.id}`,
      vars: { house: subject.propertyLabel, announcement: text },
      target: {
        kind: "group",
        house: subject,
        roster: leases.filter((l) => l.propertyId === house.id),
        fallbackToResidents: true,
      },
    });
    results.push({
      propertyId: house.id,
      label: house.label,
      outcome: outcome.status,
      ...("reason" in outcome && outcome.reason ? { reason: outcome.reason } : {}),
    });
  }
  return { ok: true, announcementId, houses: results };
}
