import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { handleLineMemberText } from "@/lib/one-number/line-member-status.server";
import { handleLineResidentText } from "@/lib/one-number/line-resident.server";
import { isPropLaneServiceLine } from "@/lib/service/service-catalog.server";
import { normalizeConsentPhone } from "@/lib/sms-consent";

/**
 * The per_workspace PropLane line (a number the platform service owner holds) answers two kinds of known sender
 * before the prospect path would treat them as strangers:
 *
 *   a member     owner, teammate or owner of record of ANOTHER workspace: read-only status of their own houses
 *   a resident   of another workspace asking to pay: a phone-bound payment link for the workspace that holds the lease
 *
 * Everything else (a housing search, a stranger, an unverified phone, a topic neither handler owns) returns null and
 * the text goes down the path it always took. Called from the inbound pipeline after the work-number manager fork
 * and before the vendor and resident forks; the shared-line seam calls `handleLineMemberText` itself.
 */
export type PropLaneLineAnswer = { reply: string; actorUserId: string; kind: "member" | "resident" };

export async function answerPropLaneLineText(
  db: SupabaseClient,
  input: { lineOwnerUserId: string; toPhone: string; fromPhone: string; body: string },
): Promise<PropLaneLineAnswer | null> {
  const phoneKey = normalizeConsentPhone(input.fromPhone);
  if (!phoneKey) return null;
  // The cheap test first: not the PropLane service owner's number = not this line, no further read.
  const onLine = await isPropLaneServiceLine(db, { ownerUserId: input.lineOwnerUserId, workNumber: input.toPhone }).catch(() => false);
  if (!onLine) return null;

  const member = await handleLineMemberText(db, {
    fromPhone: input.fromPhone,
    body: input.body,
    phoneKey,
    mode: "service_line",
    lineOwnerUserId: input.lineOwnerUserId,
  });
  if (member.handled) return { reply: member.reply, actorUserId: member.actorUserId, kind: "member" };

  const resident = await handleLineResidentText(db, {
    fromPhone: input.fromPhone,
    body: input.body,
    phoneKey,
    lineOwnerUserId: input.lineOwnerUserId,
  });
  if (resident.handled) return { reply: resident.reply, actorUserId: resident.residentUserId, kind: "resident" };
  return null;
}
