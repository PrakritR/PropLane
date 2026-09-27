import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { conversationPhoneRef, type SmsCounterpartyRole } from "@/lib/sms-conversation-identity";
import {
  enqueueSmsProjectionRetry,
  projectOriginalEvent,
  resolveSmsProjectionWorkLine,
  type SmsProjectionEventInput,
} from "@/lib/sms/sms-projection.server";
import { isVoiceCallNoteSid } from "@/lib/voice/voice-call-notes";

/** Mirror one accepted original provider event into the manager Communication read model. */
export async function projectManagerSmsEvent(
  db: SupabaseClient,
  input: {
    ownerManagerUserId: string;
    counterpartyRole: SmsCounterpartyRole;
    counterpartyUserId: string | null;
    counterpartyPhone: string;
    workPhone: string | null;
    legacyConversationKey: string;
    messageSid: string | null;
    direction: "inbound" | "outbound";
    body: string;
    occurredAt: string;
    fromPhone: string | null;
    toPhone: string;
    source: "work_number" | "relay" | "automated";
    sourceRef?: Record<string, unknown>;
  },
): Promise<boolean> {
  const sid = input.messageSid?.trim();
  // Voice notes have deterministic source IDs but are annotations, never
  // provider SMS originals. Keep them in the same bounded conversation read
  // model under a separate namespace with no provider-SID uniqueness claim.
  if (!sid) return true;
  const isCallNote = isVoiceCallNoteSid(sid);
  const sourceIdHash = createHash("sha256").update(sid).digest("hex").slice(0, 12);
  const phone = conversationPhoneRef(input.counterpartyPhone);
  const workPhone = input.workPhone?.trim() ?? "";
  const line = workPhone
    ? await resolveSmsProjectionWorkLine(db, { ownerManagerUserId: input.ownerManagerUserId, phoneNumber: workPhone, occurredAt: input.occurredAt })
    : null;
  const identityKind = input.counterpartyUserId ? "user" : input.counterpartyRole === "unknown" ? "unresolved" : "phone";
  const identityKey = input.counterpartyUserId
    ? `user:${input.counterpartyUserId}`
    : identityKind === "unresolved" ? `unresolved:${sid}` : `phone:${phone}`;
  const event: SmsProjectionEventInput = {
    ownerManagerUserId: input.ownerManagerUserId,
    counterpartyRole: input.counterpartyRole,
    workLineId: line?.workLineId ?? "",
    identityKey,
    identityKind,
    counterpartyUserId: input.counterpartyUserId,
    counterpartyPhone: phone,
    legacyConversationKey: input.legacyConversationKey,
    sourceNamespace: isCallNote
      ? `voice:${input.ownerManagerUserId}`
      : `twilio:${input.ownerManagerUserId}:${process.env.TWILIO_ACCOUNT_SID?.trim() || "unconfigured"}`,
    sourceEventId: sid,
    direction: input.direction,
    body: input.body,
    occurredAt: input.occurredAt,
    fromPhone: input.fromPhone,
    toPhone: input.toPhone,
    sourceRef: input.sourceRef ?? { table: "manager_sms_messages", source: input.source },
    metadata: isCallNote ? { annotationKind: "call" } : {},
  };
  if (!line) {
    try {
      await enqueueSmsProjectionRetry(db, event, "work_line_unresolved");
    } catch {
      console.error("sms projection retry marker unavailable", { sourceIdHash, reason: "work_line_unresolved" });
    }
    return false;
  }
  try {
    await projectOriginalEvent(db, event);
    return true;
  } catch (error) {
    console.error("sms projection failed", { sourceIdHash, reason: error instanceof Error ? error.message.split(":")[0] : "unknown" });
    return false;
  }
}
