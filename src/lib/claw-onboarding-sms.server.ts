/**
 * First-account PropLane messaging assistant setup texts.
 * Idempotent via portal_outbound_mail_records so re-setup does not spam.
 */

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164Us } from "@/lib/claw-messenger.server";
import {
  buildManagerPropLaneAssistantIntroSms,
  buildResidentPropLaneAssistantIntroSms,
} from "@/lib/claw-onboarding-sms";
import { canSendResidentOutboundSms, sendResidentOutboundSms } from "@/lib/resident-outbound-sms.server";
import { normalizeE164 } from "@/lib/twilio";

export {
  buildManagerPropLaneAssistantIntroSms,
  buildResidentPropLaneAssistantIntroSms,
} from "@/lib/claw-onboarding-sms";

function introDedupId(kind: "resident" | "manager", userId: string): string {
  return `proplane_assistant_intro_${kind}_${userId}`;
}

async function alreadySentIntro(db: SupabaseClient, id: string): Promise<boolean> {
  const { data } = await db.from("portal_outbound_mail_records").select("id").eq("id", id).maybeSingle();
  return Boolean(data?.id);
}

async function markIntroSent(
  db: SupabaseClient,
  id: string,
  recipientEmail: string,
  phone: string,
): Promise<void> {
  await db.from("portal_outbound_mail_records").upsert(
    {
      id,
      recipient_email: recipientEmail || phone,
      subject: "PropLane messaging assistant intro",
      channel: "sms",
      row_data: {
        id,
        to: phone,
        kind: "proplane_assistant_intro",
        sentAt: new Date().toISOString(),
      },
    },
    { onConflict: "id" },
  );
}

/**
 * Send the resident PropLane assistant intro once (account create / welcome).
 * Opens a Claw thread so manager replies stay on the agent line.
 */
export async function sendResidentPropLaneAssistantIntro(args: {
  db: SupabaseClient;
  toPhone: string;
  residentUserId: string;
  residentEmail?: string | null;
  managerUserId?: string | null;
  name?: string | null;
  axisId?: string | null;
  fromNumber?: string | null;
}): Promise<{ sent: boolean; skipped?: boolean; error?: string }> {
  if (!canSendResidentOutboundSms(args.fromNumber)) {
    return { sent: false, error: "sms_not_configured" };
  }
  const dedupId = introDedupId("resident", args.residentUserId);
  if (await alreadySentIntro(args.db, dedupId)) {
    return { sent: false, skipped: true };
  }

  const text = buildResidentPropLaneAssistantIntroSms({
    name: args.name,
    axisId: args.axisId,
  });
  const openThread = args.managerUserId?.trim()
    ? {
        managerUserId: args.managerUserId.trim(),
        residentUserId: args.residentUserId,
        residentEmail: args.residentEmail,
        topic: "general" as const,
      }
    : null;

  const result = await sendResidentOutboundSms({
    to: args.toPhone,
    text,
    fromNumber: args.fromNumber,
    linkKind: null,
    sendClass: "transactional",
    openThread,
  });
  if (result.sent) {
    await markIntroSent(
      args.db,
      dedupId,
      (args.residentEmail ?? "").trim().toLowerCase() || args.toPhone,
      args.toPhone,
    );
  }
  return { sent: result.sent, error: result.error };
}

/**
 * Send the manager PropLane assistant intro once when their personal phone is known.
 * Uses Claw directly (no resident thread open — manager is the recipient).
 */
export async function sendManagerPropLaneAssistantIntro(args: {
  db: SupabaseClient;
  managerUserId: string;
  toPhone: string;
  managerEmail?: string | null;
  name?: string | null;
  fromNumber?: string | null;
}): Promise<{ sent: boolean; skipped?: boolean; error?: string }> {
  const dedupId = introDedupId("manager", args.managerUserId);
  if (await alreadySentIntro(args.db, dedupId)) {
    return { sent: false, skipped: true };
  }

  const toNorm = normalizeE164Us(args.toPhone) ?? normalizeE164(args.toPhone);
  if (!toNorm) return { sent: false, error: "invalid_to" };

  const workNumber = args.fromNumber?.trim() || null;
  const text = buildManagerPropLaneAssistantIntroSms({ name: args.name, workNumber });
  const { sendPropLaneSms } = await import("@/lib/proplane-sms-transport.server");
  const result = await sendPropLaneSms({ to: toNorm, text, fromNumber: workNumber });
  const sent = result.ok;
  const error = result.error;

  if (sent) {
    await markIntroSent(
      args.db,
      dedupId,
      (args.managerEmail ?? "").trim().toLowerCase() || toNorm,
      toNorm,
    );
  }
  return { sent, error };
}

/**
 * Best-effort: if the manager profile has a phone, send the assistant intro.
 * Call after manager signup or when a personal phone is first saved/verified.
 */
export async function maybeSendManagerPropLaneAssistantIntro(
  db: SupabaseClient,
  managerUserId: string,
): Promise<void> {
  try {
    const { data: profile } = await db
      .from("profiles")
      .select("phone, email, full_name, sms_from_number")
      .eq("id", managerUserId)
      .maybeSingle();
    const phone = String(profile?.phone ?? "").trim();
    if (!phone) return;
    await sendManagerPropLaneAssistantIntro({
      db,
      managerUserId,
      toPhone: phone,
      managerEmail: String(profile?.email ?? "").trim() || null,
      name: String(profile?.full_name ?? "").trim() || null,
      fromNumber: String(profile?.sms_from_number ?? "").trim() || null,
    });
  } catch {
    /* non-critical */
  }
}
