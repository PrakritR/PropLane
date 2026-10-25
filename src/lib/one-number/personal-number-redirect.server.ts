import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { isLineKeywordOrUrgentText, listLineMemberships } from "@/lib/one-number/line-member-status.server";
import { findVerifiedProfileByPhone } from "@/lib/one-number/router-lookups.server";
import { toGsm7 } from "@/lib/one-number/segments";
import { asksForJobs } from "@/lib/one-number/vendor-jobs/intent";
import { asksForWorkOnOwnNumber } from "@/lib/one-number/vendor-jobs/own-number-intent";
import { isNumberSubscriptionEnabled } from "@/lib/number-subscription/constants";
import { numberServiceEntitled } from "@/lib/number-subscription/subscription.server";
import { formatUsPhoneDisplay } from "@/lib/phone-e164";
import { getActiveResidentAgentNumber } from "@/lib/resident-agent-number/number.server";
import { parseResidentFixedReply, parseVendorDispatchReply } from "@/lib/vendor-dispatch/reply-parse";
import { getRoutableVendorNumber } from "@/lib/vendor-work-identity.server";

/**
 * Someone who PAYS for a personal PropLane number is pointed at it when they text the PropLane line (the 206, in both line
 * modes), before the line routes the text anywhere:
 *
 *   a resident whose VERIFIED phone owns an active resident number with an entitled subscription (`numberServiceEntitled`):
 *       "You have your own PropLane number, (425) 555-0110. Text it to find homes, book tours and reach your manager."
 *   a vendor with a ROUTABLE dedicated number (`getRoutableVendorNumber`: active and entitled, so a lapsed number is not one):
 *       "Text your PropLane number (206) 555-0177 for jobs and messages."
 *
 * Fails toward service: a lapsed or unreadable number, an unverified or shared phone, anyone who also holds a manager-side
 * role or a workspace seat (their texts here are about running houses), and any read that throws is NO redirect, so the
 * sender is served normally. STOP / HELP / START, HUMAN, emergencies and the short answers to a dispatch offer or an "is it
 * fixed?" question are never redirected (they are owed an answer here and now). Reads only; the reply rides the webhook or
 * the line's own reply path and names nobody's number but the sender's own.
 */

export type PersonalNumberRedirect = { kind: "resident" | "vendor"; reply: string; actorUserId: string };

export function buildResidentNumberRedirect(number: string): string {
  return toGsm7(`You have your own PropLane number, ${formatUsPhoneDisplay(number)}. Text it to find homes, book tours and reach your manager.`);
}

export function buildVendorNumberRedirect(number: string): string {
  return toGsm7(`Text your PropLane number ${formatUsPhoneDisplay(number)} for jobs and messages.`);
}

/** True when the account runs houses or the platform (a role or a workspace seat), or when that could not be read. */
async function managesOrUnreadable(db: SupabaseClient, userId: string): Promise<boolean> {
  const { data, error } = await db.from("profile_roles").select("role").eq("user_id", userId).limit(20);
  if (error) return true;
  if ((data ?? []).some((row) => ["admin", "manager"].includes(String((row as { role?: unknown }).role ?? "")))) return true;
  const memberships = await listLineMemberships(db, userId).catch(() => null);
  return memberships === null || memberships.length > 0;
}

async function entitledResidentNumber(db: SupabaseClient, residentUserId: string): Promise<string | null> {
  if (!isNumberSubscriptionEnabled()) return null;
  const number = await getActiveResidentAgentNumber(db, residentUserId);
  if (!number) return null;
  return (await numberServiceEntitled(residentUserId, db)) ? number.phoneNumber : null;
}

export async function personalNumberRedirectFor(db: SupabaseClient, input: { fromPhone: string; body: string }): Promise<PersonalNumberRedirect | null> {
  try {
    if (isLineKeywordOrUrgentText(input.body)) return null;
    if (parseVendorDispatchReply(input.body) || parseResidentFixedReply(input.body)) return null;
    const profile = await findVerifiedProfileByPhone(db, input.fromPhone);
    if (!profile) return null;
    const [resident, vendor] = await Promise.all([
      entitledResidentNumber(db, profile.id).catch(() => null),
      getRoutableVendorNumber(db, profile.id).catch(() => null),
    ]);
    if (!resident && !vendor) return null;
    if (await managesOrUnreadable(db, profile.id)) return null;
    // Both: a work ask goes to the vendor number, everything else to the resident one.
    if (vendor && (!resident || asksForJobs(input.body) || asksForWorkOnOwnNumber(input.body))) {
      return { kind: "vendor", reply: buildVendorNumberRedirect(vendor.phoneNumber), actorUserId: profile.id };
    }
    return { kind: "resident", reply: buildResidentNumberRedirect(resident!), actorUserId: profile.id };
  } catch (error) {
    console.error("personal number redirect failed", error instanceof Error ? error.name : "unknown");
    return null;
  }
}
