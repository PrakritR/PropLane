import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { logManagerSmsMessage } from "@/lib/manager-sms-messages.server";
import type { SmsCounterpartyRole } from "@/lib/sms-conversation-identity";
import { voiceCallNoteSid } from "@/lib/voice/voice-call-notes";

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

type CallNoteIdentity = {
  managerUserId: string;
  actorUserId: string;
  actorPhone: string;
  workNumber: string;
  callSid: string;
  counterpartyRole?: SmsCounterpartyRole;
};

async function logNote(
  db: SupabaseClient,
  args: CallNoteIdentity & {
    direction: "inbound" | "outbound";
    body: string;
    kind: "started" | "user" | "agent" | "ended";
  },
): Promise<boolean> {
  const body = args.body.trim();
  const callSid = args.callSid.trim();
  if (!body || !callSid) return false;
  return logManagerSmsMessage(db, {
    managerUserId: args.managerUserId,
    residentPhone: args.actorPhone,
    residentUserId: args.actorUserId,
    direction: args.direction,
    body,
    fromPhone: args.direction === "inbound" ? args.actorPhone : args.workNumber,
    toPhone: args.direction === "inbound" ? args.workNumber : args.actorPhone,
    messageSid: voiceCallNoteSid({
      callSid,
      kind: args.kind,
      digest: args.kind === "started" || args.kind === "ended" ? undefined : digest(body),
    }),
    source: "work_number",
    counterpartyRole: args.counterpartyRole ?? "manager",
  });
}

/** System line when recording consent is granted. */
export async function logVoiceCallStarted(
  db: SupabaseClient,
  args: CallNoteIdentity,
): Promise<boolean> {
  return logNote(db, {
    ...args,
    direction: "outbound",
    kind: "started",
    body: "Call started. What follows is a transcript of this voice call.",
  });
}

/** Spoken caller line + assistant reply, as Communication chat bubbles. */
export async function logVoiceCallTurnNotes(
  db: SupabaseClient,
  args: CallNoteIdentity & { spoken: string; reply: string },
): Promise<void> {
  const spoken = args.spoken.trim();
  const reply = args.reply.trim();
  if (spoken) {
    await logNote(db, {
      ...args,
      direction: "inbound",
      kind: "user",
      body: spoken,
    });
  }
  if (reply) {
    await logNote(db, {
      ...args,
      direction: "outbound",
      kind: "agent",
      body: reply,
    });
  }
}
