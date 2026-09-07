import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveManagerSmsAgentContext } from "@/lib/tools/manager-sms-context";
import { resolveManagerSmsInboundIdentity } from "@/lib/sms/manager-sms-access.server";
import { resolveOwnedWorkNumber } from "@/lib/sms/resolve-owned-work-number.server";
import { runManagerVoiceAgentTurn } from "@/lib/agent/manager-voice-agent.server";
import { normalizeVoiceConfirmationForAgentGate } from "@/lib/voice/voice-confirmation.server";
import { normalizeE164 } from "@/lib/twilio";

export { resolveOwnedWorkNumber };

/** @deprecated Use `runVoiceCallTurnFromSpeech` — manager-only helper kept for tests. */
export async function runManagerVoiceTurnFromSpeech(args: {
  db: SupabaseClient;
  workNumberOwnerId: string;
  fromPhone: string;
  toPhone: string;
  speechResult: string;
  callSid: string;
}): Promise<string | null> {
  const identity = await resolveManagerSmsInboundIdentity(args.db, {
    workNumberOwnerId: args.workNumberOwnerId,
    fromPhone: args.fromPhone,
    toPhone: args.toPhone,
  });
  if (!identity) return null;

  const managerIdentity = await resolveManagerSmsAgentContext(args.db, {
    managerUserId: identity.workNumberOwnerId,
    actorUserId: identity.actorUserId,
    access: identity.access,
  });
  if (!managerIdentity.ok) return null;

  const normalizedSpeech = normalizeVoiceConfirmationForAgentGate(args.speechResult);
  const turn = await runManagerVoiceAgentTurn(args.db, {
    ctx: managerIdentity.ctx,
    managerPhoneE164: normalizeE164(identity.actorPhone) ?? identity.actorPhone,
    inboundText: normalizedSpeech,
    inboundCallSid: args.callSid,
  });
  return turn?.reply?.trim() || null;
}
