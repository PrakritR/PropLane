import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SharedLineCandidate } from "@/lib/one-number/contracts";
import { spokenLabelFor } from "@/lib/one-number/router.server";
import { isServiceWorkspace } from "@/lib/one-number/service-line.server";
import { normalizeConsentPhone } from "@/lib/sms-consent";
import { toGsm7 } from "@/lib/one-number/segments";
import { logManagerSmsMessage } from "@/lib/manager-sms-messages.server";
import { normalizeE164, formatUsPhoneDisplay } from "@/lib/phone-e164";
import { resolveWorkspaceStatusLine } from "@/lib/sms/manager-workspace-role.server";

/**
 * Number model (captain, Oct 18): a workspace that holds a personalized number (a paying Pro /
 * Business workspace) texts from it, never from the shared PropLane line. A person
 * whose ONLY ties are to such workspaces who texts the shared line is told, once, where to text.
 */

/** "5259 Brooklyn texts from (206) 555-0111. Please text that number." One GSM-7 segment. */
export function buildDedicatedRedirectReply(label: string | null | undefined, ownNumber: string): string {
  const name = String(label ?? "").trim().replace(/\s+/g, " ").slice(0, 40) || "Your property team";
  return toGsm7(`${name} texts from ${formatUsPhoneDisplay(ownNumber)}. Please text that number.`);
}

/**
 * A PropLane-managed home that has its own line (captain, Nov 24): "For 5257 Brooklyn, text us at (814) 679-3694 - that's the
 * line for this home." Built from the resolved number, never typed here.
 */
export function buildManagedHomeRedirectReply(label: string | null | undefined, ownNumber: string): string {
  const name = String(label ?? "").trim().replace(/\s+/g, " ").slice(0, 40) || "this home";
  return toGsm7(`For ${name}, text us at ${formatUsPhoneDisplay(ownNumber)} - that's the line for this home.`);
}

/** A repeat text inside the 30 days is answered briefly, not redirected again. */
export function buildManagedHomeRepeatReply(label: string | null | undefined, ownNumber: string): string {
  const name = String(label ?? "").trim().replace(/\s+/g, " ").slice(0, 40) || "this home";
  return toGsm7(`Thanks, we have your message about ${name}. The team will reply from ${formatUsPhoneDisplay(ownNumber)}.`);
}

export const MANAGED_HOME_REDIRECT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Claim the once-per-30-days redirect marker for (phone, workspace) BEFORE answering, so two overlapping texts cannot both
 * redirect. Missing schema or an unreadable marker answers "first" (fail toward service: the person is told where to text).
 */
async function claimManagedHomeRedirect(db: SupabaseClient, input: { phoneKey: string; workspaceId: string; messageSid: string; now: Date }): Promise<"first" | "repeat"> {
  try {
    const nowIso = input.now.toISOString();
    const row = { phone_key: input.phoneKey, workspace_id: input.workspaceId, notified_at: nowIso, message_sid: input.messageSid };
    const inserted = await db.from("sms_managed_home_redirects").insert(row);
    if (!inserted.error) return "first";
    if (inserted.error.code !== "23505") return "first";
    const cutoff = new Date(input.now.getTime() - MANAGED_HOME_REDIRECT_WINDOW_MS).toISOString();
    const took = await db
      .from("sms_managed_home_redirects")
      .update({ notified_at: nowIso, message_sid: input.messageSid })
      .eq("phone_key", input.phoneKey)
      .eq("workspace_id", input.workspaceId)
      .lt("notified_at", cutoff)
      .select("phone_key");
    if (took.error) return "first";
    return took.data?.length ? "first" : "repeat";
  } catch {
    return "first";
  }
}

async function redirectReplyFor(db: SupabaseClient, candidate: SharedLineCandidate, own: string): Promise<string> {
  const label = spokenLabelFor(candidate);
  const managed = await isServiceWorkspace(db, candidate.workspaceId).catch(() => null);
  return managed === true ? buildManagedHomeRedirectReply(label, own) : buildDedicatedRedirectReply(label, own);
}

/**
 * The workspace's own number, as the send path would resolve it (home row, a held number, or the
 * owner's legacy unplaced row for the default workspace). Null when it has none we can name.
 */
async function ownNumberOf(db: SupabaseClient, candidate: SharedLineCandidate): Promise<string | null> {
  try {
    const line = await resolveWorkspaceStatusLine(db, candidate.ownerUserId, candidate.workspaceId);
    return normalizeE164(line.phoneNumber);
  } catch {
    return null;
  }
}

/**
 * Answer a shared-line text from someone who belongs to a workspace with its own number. Returns the
 * reply for the webhook's own TwiML (no workspace pays for it: the shared line is the platform's),
 * or null when the workspace's number cannot be named (the existing no-owner path then logs the
 * text). The text and the reply are written to that workspace's thread so its team can see them.
 * Another workspace's number is never named: the number is the candidate workspace's own.
 */
export async function answerFromDedicatedWorkspace(
  db: SupabaseClient,
  input: { candidate: SharedLineCandidate; fromPhone: string; body: string; messageSid: string; sharedNumber: string | null },
): Promise<string | null> {
  const own = await ownNumberOf(db, input.candidate);
  // A "line of its own" that is the PropLane line itself is no redirect: never tell a text on the 206 to text the 206.
  if (!own || own === normalizeE164(input.sharedNumber ?? "")) return null;
  // A vendor is named the general area, never the street: this redirect can reach one whose job is only offered.
  const managed = (await isServiceWorkspace(db, input.candidate.workspaceId).catch(() => null)) === true;
  const phoneKey = normalizeConsentPhone(input.fromPhone);
  const mark = managed && phoneKey
    ? await claimManagedHomeRedirect(db, { phoneKey, workspaceId: input.candidate.workspaceId, messageSid: input.messageSid, now: new Date() })
    : "first";
  const reply = mark === "repeat"
    ? buildManagedHomeRepeatReply(spokenLabelFor(input.candidate), own)
    : await redirectReplyFor(db, input.candidate, own);
  const from = normalizeE164(input.fromPhone) ?? input.fromPhone;
  const line = input.sharedNumber ?? own;
  const base = {
    managerUserId: input.candidate.ownerUserId,
    residentPhone: from,
    source: "work_number" as const,
    counterpartyRole: input.candidate.role,
    workspaceId: input.candidate.workspaceId,
  };
  await logManagerSmsMessage(db, {
    ...base, direction: "inbound", body: input.body, fromPhone: from, toPhone: line, messageSid: input.messageSid,
  }).catch(() => false);
  await logManagerSmsMessage(db, {
    ...base, direction: "outbound", body: reply, fromPhone: line, toPhone: from, messageSid: `redirect:${input.messageSid}`,
  }).catch(() => false);
  return reply;
}

/**
 * The redirect sentence for a workspace with its own number, without writing anything (a phone CALL has no text to log).
 * Null when the workspace's number cannot be named.
 */
export async function dedicatedRedirectReplyFor(db: SupabaseClient, candidate: SharedLineCandidate): Promise<string | null> {
  const own = await ownNumberOf(db, candidate);
  return own ? await redirectReplyFor(db, candidate, own) : null;
}
