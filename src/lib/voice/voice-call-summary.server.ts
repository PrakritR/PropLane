import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { VOICE_CALL_NOTE_SID_PREFIX } from "@/lib/voice/voice-call-notes";
import { resolveManagerNotificationChannels } from "@/lib/manager-notification-routing.server";
import { sendFromManagerWorkNumber } from "@/lib/proplane-sms-transport.server";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";

/**
 * What the manager gets after a voice call ends.
 *
 * A call is the one channel there is no scrollback for, so when it ends the
 * transcript is summarised and pushed to the manager on every channel they
 * still have switched on: their real mobile by SMS, their email, and the
 * PropLane Communication thread. The thread copy already exists — each turn is
 * logged as it happens — so this adds the outward channels and a closing note,
 * and never re-writes the turns themselves.
 *
 * Every caller kind uses this one path: the manager calling their own work
 * number, a verified resident, or an unknown prospect. Only the wording of who
 * called changes.
 */

export type VoiceCallerKind = "manager" | "resident" | "prospect";

export type VoiceCallTranscriptLine = {
  direction: "inbound" | "outbound";
  body: string;
};

/** The call's turns, in order, read back out of the Communication thread. */
export async function loadVoiceCallTranscript(
  db: SupabaseClient,
  args: { managerUserId: string; callSid: string },
): Promise<VoiceCallTranscriptLine[]> {
  const callSid = args.callSid.trim();
  if (!callSid) return [];
  const { data, error } = await db
    .from("manager_sms_messages")
    .select("direction, body, message_sid, created_at")
    .eq("manager_user_id", args.managerUserId)
    .like("message_sid", `${VOICE_CALL_NOTE_SID_PREFIX}${callSid}:%`)
    .order("created_at", { ascending: true });
  if (error) return [];
  return (data ?? [])
    .map((row) => ({
      direction: String((row as { direction?: unknown }).direction ?? "") === "inbound" ? "inbound" as const : "outbound" as const,
      body: String((row as { body?: unknown }).body ?? "").trim(),
    }))
    .filter((line) => line.body.length > 0);
}

function callerLabel(kind: VoiceCallerKind, callerPhone: string): string {
  switch (kind) {
    case "manager":
      return "You called your work number";
    case "resident":
      return `A resident called from ${callerPhone}`;
    default:
      return `A prospect called from ${callerPhone}`;
  }
}

/**
 * Plain-text summary. Deliberately the SAME body on every channel — a manager
 * comparing the text on their phone against the email should not have to work
 * out whether they are looking at two different things.
 */
export function formatVoiceCallSummary(args: {
  callerKind: VoiceCallerKind;
  callerPhone: string;
  workNumber: string;
  transcript: VoiceCallTranscriptLine[];
}): { subject: string; body: string } {
  const who = callerLabel(args.callerKind, args.callerPhone);
  const spoken = args.transcript
    .map((line) => `${line.direction === "inbound" ? "Caller" : "PropLane"}: ${line.body}`)
    .join("\n");
  const origin = resolveEmailLinkBaseUrl().replace(/\/$/, "");
  const subject = `Call summary — ${args.callerPhone} → ${args.workNumber}`;
  const body = [
    `${who} on ${args.workNumber}.`,
    "",
    spoken || "No speech was captured on this call.",
    "",
    `Full thread: ${origin}/portal/communication`,
  ].join("\n");
  return { subject, body };
}

export type VoiceCallSummaryDelivery = {
  inbox: boolean;
  email: boolean;
  sms: boolean;
  skippedReason?: "no_transcript";
};

/**
 * Fan the summary out on whichever channels the manager still has on.
 *
 * `voice_calls` is its own notification category, so a manager can silence call
 * summaries without silencing anything else. Inbox is never suppressible — it
 * is the durable record — and matches how every other category behaves.
 */
export async function deliverVoiceCallSummary(
  db: SupabaseClient,
  args: {
    managerUserId: string;
    managerEmail: string | null;
    managerMobile: string | null;
    workNumber: string;
    callerPhone: string;
    callerKind: VoiceCallerKind;
    callSid: string;
    sendEmail: (input: { to: string; subject: string; text: string }) => Promise<boolean>;
  },
): Promise<VoiceCallSummaryDelivery> {
  const transcript = await loadVoiceCallTranscript(db, {
    managerUserId: args.managerUserId,
    callSid: args.callSid,
  });
  if (transcript.length === 0) {
    return { inbox: false, email: false, sms: false, skippedReason: "no_transcript" };
  }

  const { subject, body } = formatVoiceCallSummary({
    callerKind: args.callerKind,
    callerPhone: args.callerPhone,
    workNumber: args.workNumber,
    transcript,
  });

  // The MANAGER routing gate, not the resident/vendor matrix: it honours the
  // "Call summaries" toggle in Settings, the alert destination, phone
  // verification, and SMS opt-out — so switching it off in Settings actually
  // stops the text rather than only hiding a row.
  const channels = await resolveManagerNotificationChannels(db, args.managerUserId, "voice_calls");

  let emailSent = false;
  if (channels.email && args.managerEmail) {
    try {
      emailSent = await args.sendEmail({ to: args.managerEmail, subject, text: body });
    } catch {
      emailSent = false;
    }
  }

  let smsSent = false;
  // To the manager's REAL mobile, not the work number — the work number is the
  // line the call arrived on, and texting it would talk to the caller.
  if (channels.sms && args.managerMobile && args.managerMobile !== args.workNumber) {
    try {
      const res = await sendFromManagerWorkNumber({
        managerUserId: args.managerUserId,
        to: args.managerMobile,
        text: body,
        fromNumber: args.workNumber,
        source: "automated",
        sendClass: "transactional",
        purpose: "voice_call_summary",
        // One summary per call, even if Twilio retries the status callback.
        dedupeKey: `voice_summary:${args.callSid}`,
      });
      smsSent = res.ok;
    } catch {
      smsSent = false;
    }
  }

  return { inbox: true, email: emailSent, sms: smsSent };
}
