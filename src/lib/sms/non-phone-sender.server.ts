import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isSharedLineNumber, loadSharedLineConfig } from "@/lib/one-number/config.server";
import { toGsm7 } from "@/lib/one-number/segments";
import { loadPlatformOpsPhones } from "@/lib/one-number/inbound-alert.server";
import { readServiceOwnerOrThrow } from "@/lib/one-number/service-line.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { sendTextFromServiceOwner } from "@/lib/service/service-manager.server";
import { rateLimit } from "@/lib/rate-limit";
import { resolveOwnedWorkNumber } from "@/lib/sms/resolve-owned-work-number.server";
import { SERVICE_ALERT_PHONE_SMS_PURPOSE } from "@/lib/sms/team-notice-consent.server";
import { buildNonPhoneAlertText, nonPhoneConversationKey, type NonPhoneSender } from "@/lib/sms/non-phone-sender";

/** Ops text alerts for short-code / alphanumeric senders (spoofable, unauthenticated): per sender and across all senders, per hour. */
export const NON_PHONE_ALERT_SENDER_LIMIT_PER_HOUR = 5;
export const NON_PHONE_ALERT_GLOBAL_LIMIT_PER_HOUR = 30;
const HOUR_MS = 60 * 60 * 1000;

async function nonPhoneAlertAllowed(sender: string): Promise<boolean> {
  try {
    const key = createHash("sha256").update(sender.toLowerCase()).digest("hex").slice(0, 24);
    if (!(await rateLimit(`nonphone-alert:sender:${key}`, NON_PHONE_ALERT_SENDER_LIMIT_PER_HOUR, HOUR_MS)).ok) return false;
    return (await rateLimit("nonphone-alert:global", NON_PHONE_ALERT_GLOBAL_LIMIT_PER_HOUR, HOUR_MS)).ok;
  } catch {
    return false; // fail closed: the message is stored, only the text alert is skipped
  }
}

export type NonPhoneInboundResult = { stored: boolean; reason: "stored" | "duplicate" | "not_propline_line" | "no_service_owner"; alerted: number };

/**
 * Stores a text from a short code / alphanumeric sender as its own conversation in PropLane's admin Communication and
 * alerts the admin phones once. It sends NOTHING to the sender and runs no agent. Only the PropLane line is served (the
 * shared number, or the service owner's own number); a text to anyone else's number is dropped, never stored on theirs.
 * Idempotent on the provider MessageSid. A failed read or write throws so the durable ingress retries.
 */
export async function ingestNonPhoneSenderText(
  db: SupabaseClient,
  input: { from: NonPhoneSender; toPhone: string; body: string; messageSid: string | null },
): Promise<NonPhoneInboundResult> {
  const to = normalizeE164(input.toPhone);
  if (!to) return { stored: false, reason: "not_propline_line", alerted: 0 };
  const serviceOwner = await readServiceOwnerOrThrow(db);
  if (!serviceOwner) return { stored: false, reason: "no_service_owner", alerted: 0 };
  const config = await loadSharedLineConfig(db);
  const owned = await resolveOwnedWorkNumber(db, to);
  const onPropLaneLine = isSharedLineNumber(config, to) || owned?.managerId === serviceOwner;
  if (!onPropLaneLine) return { stored: false, reason: "not_propline_line", alerted: 0 };

  const sid = input.messageSid?.trim() || null;
  let stored = true;
  if (sid) {
    const existing = await db.from("inbound_sms_log").select("id").eq("message_sid", sid).limit(1);
    if (existing.error) throw new Error("non-phone inbound lookup failed");
    if ((existing.data ?? []).length > 0) stored = false;
  }
  if (stored) {
    const { error } = await db.from("inbound_sms_log").insert({
      manager_user_id: serviceOwner,
      from_phone: input.from.sender,
      to_phone: to,
      body: input.body,
      message_sid: sid,
      counterparty_role: "unknown",
      conversation_key: nonPhoneConversationKey(serviceOwner, input.from.sender),
    });
    if (error) throw new Error("non-phone inbound insert failed");
  }

  // One alert per message: the dedupe key is the MessageSid plus the phone, so a retry of the same text never double-sends.
  let alerted = 0;
  // Over the cap the message is still stored (admin Communication shows it); only the text alert is skipped. A retry of an
  // already-stored message spends no budget (the per-phone dedupe key keeps it from double-sending).
  if (sid && (!stored || (await nonPhoneAlertAllowed(input.from.sender)))) {
    const phones = await loadPlatformOpsPhones(db);
    const text = toGsm7(buildNonPhoneAlertText(input.from.sender, input.body));
    for (const phone of phones) {
      const sent = await sendTextFromServiceOwner(db, {
        toPhone: phone,
        text,
        dedupeKey: `svc-alert:${createHash("sha256").update(`nonphone-alert:${sid}:${phone}`).digest("hex").slice(0, 24)}`,
        purpose: SERVICE_ALERT_PHONE_SMS_PURPOSE,
      }).catch(() => ({ ok: false as const }));
      if (sent.ok) alerted += 1;
    }
  }
  return { stored, reason: stored ? "stored" : "duplicate", alerted };
}
