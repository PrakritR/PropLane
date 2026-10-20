import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SharedLineCandidate } from "@/lib/one-number/contracts";
import { spokenLabelFor } from "@/lib/one-number/router.server";
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
  if (!own) return null;
  // A vendor is named the general area, never the street: this redirect can reach one whose job is only offered.
  const reply = buildDedicatedRedirectReply(spokenLabelFor(input.candidate), own);
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
