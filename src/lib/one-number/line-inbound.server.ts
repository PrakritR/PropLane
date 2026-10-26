import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { handleLineMemberText, isLineKeywordOrUrgentText } from "@/lib/one-number/line-member-status.server";
import { personalNumberRedirectFor } from "@/lib/one-number/personal-number-redirect.server";
import { handleLineResidentText } from "@/lib/one-number/line-resident.server";
import { isHousingSearchText } from "@/lib/one-number/line-intent";
import { findResidentCandidates, findVendorJobCandidates, findVerifiedProfileByPhone } from "@/lib/one-number/router-lookups.server";
import { classifyLineWorkspaces, selfServeLineReply } from "@/lib/one-number/self-serve-line.server";
import { asksForJobs } from "@/lib/one-number/vendor-jobs/intent";
import { readSignupIntent } from "@/lib/one-number/signup/intent";
import { isPropLaneServiceLine } from "@/lib/service/service-catalog.server";
import { normalizeConsentPhone } from "@/lib/sms-consent";

/**
 * The per_workspace PropLane line (a number the platform service owner holds) serves homes PropLane manages, and answers
 * the known senders below before the prospect path would treat them as strangers:
 *
 *   a member     owner, teammate or owner of record of a PropLane-MANAGED workspace: read-only status of their houses
 *   a resident   of a managed workspace asking to pay: a phone-bound payment link for the workspace that holds the lease
 *   self-serve   a manager, teammate, resident or vendor whose ONLY ties are workspaces PropLane does not manage: not
 *                served here; told their own paid work number, else where a personal number comes from
 *
 * Everything else (a housing search, a stranger, an unverified phone, a topic nobody here owns) returns null and
 * the text goes down the path it always took. Called from the inbound pipeline after the work-number manager fork
 * and before the vendor and resident forks; the shared-line seam calls `handleLineMemberText` itself.
 */
export type PropLaneLineAnswer = { reply: string; actorUserId: string; kind: "member" | "resident" | "self_serve" | "number_redirect" };

export async function answerPropLaneLineText(
  db: SupabaseClient,
  input: { lineOwnerUserId: string; toPhone: string; fromPhone: string; body: string; messageSid?: string | null },
): Promise<PropLaneLineAnswer | null> {
  const phoneKey = normalizeConsentPhone(input.fromPhone);
  if (!phoneKey) return null;
  // The cheap test first: not the PropLane service owner's number = not this line, no further read.
  const onLine = await isPropLaneServiceLine(db, { ownerUserId: input.lineOwnerUserId, workNumber: input.toPhone }).catch(() => false);
  if (!onLine) return null;
  // "Sign me up as a manager" is the sign-up flow's, even from someone who already has an account: it tells them so and
  // texts a sign-in link instead of the member status ("I can only share status on this line").
  if (readSignupIntent(input.body).wantsSignup) return null;

  // Someone who pays for their own PropLane number is pointed at it, in both line modes, before the line answers anything
  // else. Lapsed or unreadable = no redirect; keywords and emergencies are never redirected.
  const redirect = await personalNumberRedirectFor(db, { fromPhone: input.fromPhone, body: input.body });
  if (redirect) return { reply: redirect.reply, actorUserId: redirect.actorUserId, kind: "number_redirect" };

  const member = await handleLineMemberText(db, {
    fromPhone: input.fromPhone,
    body: input.body,
    phoneKey,
    mode: "service_line",
    lineOwnerUserId: input.lineOwnerUserId,
    messageSid: input.messageSid ?? null,
  });
  if (member.handled) return { reply: member.reply, actorUserId: member.actorUserId, kind: "member" };

  const resident = await handleLineResidentText(db, {
    fromPhone: input.fromPhone,
    body: input.body,
    phoneKey,
    lineOwnerUserId: input.lineOwnerUserId,
  });
  if (resident.handled) return { reply: resident.reply, actorUserId: resident.residentUserId, kind: "resident" };

  const selfServe = await answerSelfServeTies(db, input);
  return selfServe ? { reply: selfServe.reply, actorUserId: selfServe.actorUserId, kind: "self_serve" } : null;
}

/**
 * A resident or a vendor (with an open job) whose ties are ALL to workspaces PropLane does not manage. Members were
 * answered above. A sender with any managed tie is not here (the managed flows serve them); neither is a housing search
 * (a prospect's question), a jobs ask (the PropLane vendor board), a keyword or an emergency. Anything unreadable is null:
 * the text falls to the stranger path, which discloses nothing about anyone.
 */
async function answerSelfServeTies(
  db: SupabaseClient,
  input: { lineOwnerUserId: string; fromPhone: string; body: string },
): Promise<{ reply: string; actorUserId: string } | null> {
  // A jobs ask belongs to the PropLane vendor board, whoever else the sender is: dropping only the vendor ties would
  // answer a vendor who also rents from a self-serve workspace with "text your work number" and never show the board.
  if (isLineKeywordOrUrgentText(input.body) || isHousingSearchText(input.body) || asksForJobs(input.body)) return null;
  const [residencies, jobs, profile] = await Promise.all([
    findResidentCandidates(db, input.fromPhone).catch(() => null),
    findVendorJobCandidates(db, input.fromPhone).catch(() => null),
    findVerifiedProfileByPhone(db, input.fromPhone).catch(() => null),
  ]);
  if (residencies === null || jobs === null) return null;
  const ties = [...residencies, ...jobs];
  if (ties.length === 0) return null;
  const kinds = await classifyLineWorkspaces(db, ties.map((t) => t.workspaceId), input.lineOwnerUserId);
  if (!kinds) return null;
  // Managed anywhere = served by the managed flows. Not in the map = unreadable = self-serve (served less).
  if (ties.some((t) => kinds.get(t.workspaceId) === "managed")) return null;
  const reply = await selfServeLineReply(db, ties.map((t) => ({ ownerUserId: t.ownerUserId, workspaceId: t.workspaceId })));
  return { reply, actorUserId: profile?.id ?? input.lineOwnerUserId };
}
