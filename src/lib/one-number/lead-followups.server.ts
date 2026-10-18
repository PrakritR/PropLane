import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { MockProperty } from "@/data/types";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { loadSharedLineConfig } from "@/lib/one-number/config.server";
import { buildOfferText, firstOfferPhoto, matchRooms, offerFromRow } from "@/lib/one-number/lead-match";
import { nextQuestion, pacificToday, toGsm7, type LeadProfile } from "@/lib/one-number/lead-qualifying";
import { sendPlatformLeadText, type PlatformLeadSendResult } from "@/lib/one-number/lead-send.server";
import { e164FromPhoneKey } from "@/lib/one-number/unassigned-leads.server";
import { quietHoursBlocks } from "@/lib/sms/number-registration-policy";
import { getCrawlPublicListings } from "@/lib/seo/public-catalog.server";

/** One nudge at 24h, one at 72h, then nothing. A lead is only ever texted by this scheduler twice. */
export const NUDGE_FIRST_AFTER_MS = 24 * 60 * 60 * 1000;
export const NUDGE_SECOND_AFTER_MS = 72 * 60 * 60 * 1000;
/** Leads quiet longer than this are left alone for good. */
export const LEAD_FOLLOWUP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

type Row = Record<string, unknown>;

export type FollowUpDeps = {
  now?: () => Date;
  listings?: () => Promise<MockProperty[]>;
  origin?: () => string;
  send?: (db: SupabaseClient, input: { to: string; body: string; mediaUrls?: string[]; now?: Date }) => Promise<PlatformLeadSendResult>;
};

export type FollowUpSummary = {
  considered: number;
  nudged24: number;
  nudged72: number;
  newMatch: number;
  skipped?: "not_shared_mode" | "quiet_hours";
};

export function nudgeText(kind: "24" | "72", profile: LeadProfile): string {
  if (kind === "72") return "PropLane here. Reply anytime to pick up your room search. Reply STOP to opt out.";
  if (profile.stage === "offered" && (profile.offers?.length ?? 0) > 0) {
    const n = profile.offers!.length;
    return `Hi, this is PropLane. Still interested in one of those rooms? Reply ${n === 1 ? "1" : n === 2 ? "1 or 2" : "1, 2 or 3"}, or TOUR.`;
  }
  const question = nextQuestion(profile);
  return `Hi, this is PropLane. Still looking for a room?${question ? ` ${question.text}` : ""}`;
}

/** Which nudge (if any) a lead is due, from how long it has been quiet and which went out already. */
export function dueNudge(profile: LeadProfile, quietMs: number): "24" | "72" | null {
  if (profile.stage === "no_match" || profile.stage === "assigned") return null;
  if (quietMs >= NUDGE_SECOND_AFTER_MS && !profile.nudged72) return "72";
  if (quietMs >= NUDGE_FIRST_AFTER_MS && quietMs < NUDGE_SECOND_AFTER_MS && !profile.nudged24) return "24";
  return null;
}

/**
 * The hourly sweep over open leads. Live only on the shared line, never in quiet hours. A flag is
 * written (optimistically, on `updated_at`) BEFORE the text goes out, so two overlapping sweeps
 * cannot send twice; a failed send takes its flag back so the next sweep retries.
 */
export async function runLeadFollowUps(db: SupabaseClient, depsIn: FollowUpDeps = {}): Promise<FollowUpSummary> {
  const now = depsIn.now ?? (() => new Date());
  const send = depsIn.send ?? sendPlatformLeadText;
  const summary: FollowUpSummary = { considered: 0, nudged24: 0, nudged72: 0, newMatch: 0 };
  const config = await loadSharedLineConfig(db);
  if (config.mode !== "shared") return { ...summary, skipped: "not_shared_mode" };
  if (quietHoursBlocks("automated", now())) return { ...summary, skipped: "quiet_hours" };

  const cutoff = new Date(now().getTime() - NUDGE_FIRST_AFTER_MS).toISOString();
  const floor = new Date(now().getTime() - LEAD_FOLLOWUP_WINDOW_MS).toISOString();
  const { data, error } = await db
    .from("sms_unassigned_leads")
    .select("id, phone_key, profile, last_inbound_at, updated_at")
    .eq("status", "open")
    .lt("last_inbound_at", cutoff)
    .gt("last_inbound_at", floor)
    .order("last_inbound_at", { ascending: true })
    .limit(200);
  if (error) return summary;

  let catalog: MockProperty[] | null = null;
  for (const raw of (data ?? []) as Row[]) {
    summary.considered += 1;
    const id = String(raw.id);
    const profile = (raw.profile && typeof raw.profile === "object" ? raw.profile : {}) as LeadProfile;
    const quietMs = now().getTime() - Date.parse(String(raw.last_inbound_at));
    const to = e164FromPhoneKey(String(raw.phone_key));
    const stamp = String(raw.updated_at);

    // Optimistic claim: only the sweep that changes `updated_at` first may send.
    const claim = async (next: LeadProfile) => {
      const { data: won } = await db
        .from("sms_unassigned_leads")
        .update({ profile: next, updated_at: now().toISOString() })
        .eq("id", id)
        .eq("status", "open")
        .eq("updated_at", stamp)
        .select("id");
      return Boolean(won?.length);
    };
    const settle = async (body: string, sid: string, mediaUrls: string[] = []) => {
      const result = await send(db, { to, body, mediaUrls, now: now() });
      if (result.ok) {
        await db.from("sms_unassigned_lead_turns").insert({ lead_id: id, direction: "outbound", body, message_sid: sid, media: mediaUrls.length ? { urls: mediaUrls } : null });
      }
      return result.ok;
    };

    // A room that fits showed up after "no match": text it once.
    if (profile.stage === "no_match" && !profile.newMatchTexted) {
      catalog ??= await (depsIn.listings ?? getCrawlPublicListings)().catch(() => []);
      const rows = matchRooms(catalog, profile, pacificToday(now()));
      if (rows.length === 0) continue;
      const offers = rows.map((row, i) => offerFromRow(row, i + 1));
      const at = now().toISOString();
      // The new-match text is this lead's follow-up: it counts as the 24h nudge so the sweep never stacks a second text on it.
      const next: LeadProfile = { ...profile, stage: "offered", asked: "pick", offers, newMatchTexted: at, nudged24: profile.nudged24 ?? at };
      if (!(await claim(next))) continue;
      const photo = firstOfferPhoto(rows);
      const body = toGsm7(`A room that fits just opened.\n${buildOfferText(offers, (depsIn.origin ?? resolveEmailLinkBaseUrl)())}`);
      if (await settle(body, `newmatch:${id}`, photo ? [photo] : [])) summary.newMatch += 1;
      else await db.from("sms_unassigned_leads").update({ profile, updated_at: stamp }).eq("id", id).eq("status", "open");
      continue;
    }

    const due = dueNudge(profile, quietMs);
    if (!due) continue;
    const flagged: LeadProfile = due === "72"
      ? { ...profile, nudged24: profile.nudged24 ?? now().toISOString(), nudged72: now().toISOString() }
      : { ...profile, nudged24: now().toISOString() };
    if (!(await claim(flagged))) continue;
    if (await settle(toGsm7(nudgeText(due, profile)), `nudge:${id}:${due}`)) {
      if (due === "72") summary.nudged72 += 1;
      else summary.nudged24 += 1;
    } else {
      // Not sent (opted out, provider hiccup): take the flag back so a later sweep can retry.
      await db.from("sms_unassigned_leads").update({ profile, updated_at: stamp }).eq("id", id).eq("status", "open");
    }
  }
  return summary;
}
