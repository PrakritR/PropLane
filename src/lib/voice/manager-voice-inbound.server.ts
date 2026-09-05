import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveManagerSmsAgentContext } from "@/lib/tools/manager-sms-context";
import { resolveManagerSmsInboundIdentity } from "@/lib/sms/manager-sms-access.server";
import { runManagerVoiceAgentTurn } from "@/lib/agent/manager-voice-agent.server";
import { normalizeVoiceConfirmationForAgentGate } from "@/lib/voice/voice-confirmation.server";
import { normalizeE164 } from "@/lib/twilio";

function digitsOf(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

function phoneVariants(raw: string): string[] {
  const d = digitsOf(raw);
  if (d.length !== 10) return [raw.trim()].filter(Boolean);
  return [
    `+1${d}`,
    d,
    `1${d}`,
    `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`,
    `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`,
    raw.trim(),
  ].filter(Boolean);
}

export async function resolveOwnedWorkNumber(
  db: SupabaseClient,
  toPhone: string,
): Promise<{ managerId: string; messagingServiceSid: string } | null> {
  const expectedServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();
  if (!expectedServiceSid) return null;
  const { data, error } = await db
    .from("manager_sms_numbers")
    .select("manager_user_id, messaging_service_sid, provision_state, grace_expires_at, updated_at")
    .in("phone_number", phoneVariants(toPhone))
    .eq("messaging_service_sid", expectedServiceSid)
    .order("updated_at", { ascending: false })
    .limit(10);
  if (error) return null;
  const candidates = (data ?? []).filter((row) => {
    const graceActive = row.grace_expires_at && Date.parse(String(row.grace_expires_at)) > Date.now();
    return row.provision_state === "active" || row.provision_state === "provisioning" || graceActive;
  });
  if (candidates.length !== 1) return null;
  const row = candidates[0];
  const managerId = String(row.manager_user_id ?? "").trim();
  return managerId ? { managerId, messagingServiceSid: expectedServiceSid } : null;
}

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
