import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadSharedLineConfig, isSharedLineNumber } from "@/lib/one-number/config.server";
import { askedByLine, claimRoleQuestionAsk, readOnboardingState, saveOnboardingState } from "@/lib/one-number/onboarding/state.server";
import { CONTROL_ONLY_RE } from "@/lib/one-number/vendor-jobs/intent";
import { normalizeE164 } from "@/lib/phone-e164";
import { isPropLaneServiceLine } from "@/lib/service/service-catalog.server";
import { normalizeConsentPhone } from "@/lib/sms-consent";
import { buildConversationKey } from "@/lib/sms-conversation-identity";
import {
  MANAGE_OWN_REPLY,
  PROPLANE_ROLE_QUESTION,
  RESIDENT_NOT_FOUND_REPLY,
  VENDOR_TRADE_QUESTION,
  classifyFirstText,
  readRoleQuestionAnswer,
  roleQuestionFor,
  withOptOut,
} from "@/lib/sms/propline-first-text";
import { ensureRecipientInitiatedReplyConsent } from "@/lib/sms/signup-line-inbound.server";
import { loadWorkspaceById } from "@/lib/workspaces/active.server";

/**
 * The first text from a number nobody knows, on the PropLane line and on a manager's own work number (`per_workspace`;
 * on the shared number the router's unknown-sender step asks the same question).
 *
 *   first text, CLEAR     nothing happens here: it goes to the flow it asked for, exactly as before;
 *   first text, UNCLEAR   ONE question: resident, vendor, looking for a place, or manage your own property
 *                         ("hi", "who is this", "hello?"). On a manager's own number it carries the workspace's name;
 *   the answer            resident -> the resident lookup already ran (it is why this number is unknown), so it is told
 *                         where to look; manage -> the create-account link; looking -> the leasing assistant;
 *                         vendor -> the PropLane line's vendor flow, or the trade question on a manager's own number.
 *
 * "First text" = nothing was ever sent to this number from this line AND THIS LINE has not already asked it. The answer
 * is only read while this line holds a live ask (a recent `sms_onboarding_state.asked_at` naming this number in
 * `asked_line`, cleared as soon as the answer is recorded), so an ordinary text is never taken for an answer and one
 * workspace's question never stands in for another's — nor does a role this phone gave another line swallow the answer
 * to a question asked here. The question's own wording is fixed and carries no STOP line, so the opt-out notice rides the
 * reply that follows it (`withOptOut`). Nothing here reads or reveals a workspace's data: the only workspace fact in a
 * reply is the name on the question, and only on that workspace's own number.
 */
export const ROLE_QUESTION_PURPOSE = "line_role_question";

/** How long after the question a text still counts as its answer. */
export const ROLE_ANSWER_WINDOW_MS = 24 * 60 * 60 * 1000;

export type RoleQuestionInboundResult =
  | { handled: false; /** The sender said they are a vendor: the PropLane line's vendor flow takes this text whatever it says. */ forceVendor?: boolean }
  | { handled: true; sent: boolean };

async function outboundCount(db: SupabaseClient, managerUserId: string, phone: string): Promise<number | null> {
  const { count, error } = await db
    .from("sms_outbox")
    .select("id", { count: "exact", head: true })
    .eq("manager_user_id", managerUserId)
    .eq("recipient_phone", phone);
  return error ? null : (count ?? 0);
}

async function alreadyAnswered(db: SupabaseClient, managerUserId: string, dedupeKey: string): Promise<boolean> {
  const { data, error } = await db.from("sms_outbox").select("id").eq("manager_user_id", managerUserId).eq("dedupe_key", dedupeKey).limit(1);
  return !error && (data ?? []).length > 0;
}

async function workspaceNameOf(db: SupabaseClient, managerUserId: string, workspaceId: string | null | undefined): Promise<string | null> {
  try {
    if (workspaceId?.trim()) return (await loadWorkspaceById(db, workspaceId))?.name ?? null;
    const { data } = await db.from("portal_workspaces").select("name").eq("owner_user_id", managerUserId).eq("is_default", true).maybeSingle();
    return String((data as { name?: unknown } | null)?.name ?? "").trim() || null;
  } catch {
    return null;
  }
}

export async function handleRoleQuestionInbound(
  db: SupabaseClient,
  args: {
    /** Owner of the number that was texted (the line owner on the PropLane line). */
    managerUserId: string;
    workspaceId?: string | null;
    fromPhone: string;
    toPhone: string;
    messageSid: string;
    body: string;
    now?: Date;
    /** Puts the sender's text in the number owner's Communication inbox (the pipeline's own projection), so the team reads it. */
    projectInbound?: () => Promise<unknown>;
  },
): Promise<RoleQuestionInboundResult> {
  const phone = normalizeE164(args.fromPhone);
  const body = String(args.body ?? "").trim();
  if (!phone || !body || !args.messageSid.trim() || CONTROL_ONLY_RE.test(body)) return { handled: false };
  const now = args.now ?? new Date();
  const dedupeKey = `line_role_${args.messageSid}`;
  const phoneKey = normalizeConsentPhone(phone);

  let serviceLine: boolean;
  try {
    const config = await loadSharedLineConfig(db);
    // The shared number's strangers are the router's (unknown-sender asks the same question there).
    if (isSharedLineNumber(config, args.toPhone)) return { handled: false };
    serviceLine = await isPropLaneServiceLine(db, { ownerUserId: args.managerUserId, workNumber: args.toPhone, sharedNumber: config.sharedNumber });
  } catch {
    return { handled: false };
  }

  // A webhook retry of a text we already answered says nothing twice.
  if (await alreadyAnswered(db, args.managerUserId, dedupeKey)) return { handled: true, sent: true };

  const sent = await outboundCount(db, args.managerUserId, phone);
  // Unknown whether this number was ever answered: ask nothing, change nothing.
  if (sent === null) return { handled: false };

  // "Have we asked?" is `sms_onboarding_state.asked_at`, not the outbox: a burst of unclear texts that arrives before the
  // question's outbox row lands reads the same `asked_at`, so the question is asked once and only once. It is asked once
  // per LINE, so `asked_line` has to name this number: another workspace's question is not this one's, and its answer
  // is not addressed here either.
  const lineKey = normalizeE164(args.toPhone) ?? String(args.toPhone ?? "").trim();
  const { available, state } = await readOnboardingState(db, phoneKey).catch(() => ({ available: false, state: null }));
  const askedAt = state?.askedAt ? Date.parse(state.askedAt) : NaN;
  const askedRecently = Number.isFinite(askedAt) && now.getTime() - askedAt <= ROLE_ANSWER_WINDOW_MS;
  const askedHere = askedRecently && askedByLine(state, lineKey);
  // A role this phone gave ANOTHER line does not close this line's question: the ask is per line, so the answer is
  // read whenever THIS line has a live ask. Recording the answer clears `asked_at`, so no later text is re-read as one.
  const awaitingAnswer = available && state !== null && askedHere;

  let reply: string | null = null;
  if (awaitingAnswer) {
    const role = readRoleQuestionAnswer(body);
    if (!role) return { handled: false };
    if (role === "resident") reply = RESIDENT_NOT_FOUND_REPLY;
    else if (role === "manage") {
      await saveOnboardingState(db, phoneKey, { role: "landlord", stage: "finish_sent", askedAt: null }, now).catch(() => false);
      reply = MANAGE_OWN_REPLY;
    } else if (role === "looking") {
      await saveOnboardingState(db, phoneKey, { role: "searcher", askedAt: null }, now).catch(() => false);
      return { handled: false };
    } else {
      await saveOnboardingState(db, phoneKey, { role: "vendor", askedAt: null }, now).catch(() => false);
      if (serviceLine) return { handled: false, forceVendor: true };
      reply = VENDOR_TRADE_QUESTION;
    }
    // The question itself carries no opt-out notice (its wording is fixed), so this reply - the first one that can - does.
    reply = withOptOut(reply);
  } else if (sent === 0 && !askedHere) {
    // First text from this number. A clear one skips the question.
    if (classifyFirstText(body).kind === "clear") return { handled: false };
    // The ask is recorded BEFORE it is sent, and only one request wins it. An ask that could not be stored is not
    // sent at all: its answer could never be read back, so the text falls through to the path it always took.
    const claimed = await claimRoleQuestionAsk(db, phoneKey, lineKey, state?.askedAt ?? null, now).catch(() => false);
    if (!claimed) return { handled: false };
    reply = serviceLine ? PROPLANE_ROLE_QUESTION : roleQuestionFor(await workspaceNameOf(db, args.managerUserId, args.workspaceId));
  } else {
    return { handled: false };
  }

  const conversationKey = buildConversationKey({ ownerManagerUserId: args.managerUserId, role: "prospect", counterpartyUserId: null, counterpartyPhone: phone });
  const consent = await ensureRecipientInitiatedReplyConsent(db, {
    managerUserId: args.managerUserId,
    phone,
    messageSid: args.messageSid,
    conversationKey,
    purpose: ROLE_QUESTION_PURPOSE,
    role: "role_question",
  }).catch(() => "unavailable" as const);
  if (consent === "suppressed") return { handled: true, sent: true };
  if (consent === "unavailable") return { handled: true, sent: false };

  await args.projectInbound?.().catch((error: unknown) => console.error("role question inbound projection failed", error instanceof Error ? error.message : "unknown"));
  const { sendFromManagerWorkNumber } = await import("@/lib/proplane-sms-transport.server");
  const result = await sendFromManagerWorkNumber({
    managerUserId: args.managerUserId,
    to: phone,
    text: reply,
    fromNumber: args.toPhone,
    counterpartyRole: "prospect",
    sendClass: "transactional",
    purpose: ROLE_QUESTION_PURPOSE,
    conversationKey,
    // One answer per inbound text: a retry is caught above, and a lost race is stopped by this key.
    dedupeKey,
    workspaceId: args.workspaceId ?? null,
  });
  const accepted = result.ok || Boolean(result.durablyAccepted);
  if (!accepted) console.error("role question reply not sent", result.error ?? "unknown");
  return { handled: true, sent: accepted };
}
