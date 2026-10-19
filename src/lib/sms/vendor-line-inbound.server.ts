import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadSharedLineConfig, isSharedLineNumber } from "@/lib/one-number/config.server";
import { sendSharedLineMessage } from "@/lib/one-number/send.server";
import { handlePropLaneVendorText } from "@/lib/one-number/vendor-jobs/vendor-line.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { recordVendorInboundReplyConsent, VENDOR_CONVERSATION_PURPOSE } from "@/lib/sms/vendor-conversation-consent.server";
import { buildConversationKey } from "@/lib/sms-conversation-identity";
import { isPropLaneServiceLine, readPlatformServiceOwnerId } from "@/lib/service/service-catalog.server";

/**
 * The inbound pipeline's vendor branch for the PropLane line (W24, `on/smsvendor`). One call from
 * `inbound-pipeline.server.ts`, after the resident fork and before the leasing fallback, so a vendor on the line is
 * never turned into a prospect lead and never swallowed silently.
 *
 * The line is the platform service owner's own number in `per_workspace` mode (every vendor text from a known vendor
 * or a lead is answered; a stranger who reads as a vendor is captured and answered) and the shared number in `shared`
 * mode (only a jobs or link ask from a vendor the router already placed). Anything else is `handled: false` and the
 * pipeline continues exactly as before.
 */
export type VendorLineInboundResult = { handled: false } | { handled: true; sent: boolean; vendorUserId: string | null };

export async function handlePropLaneLineVendorInbound(
  db: SupabaseClient,
  args: {
    managerUserId: string;
    workspaceId?: string | null;
    fromPhone: string;
    toPhone: string;
    messageSid: string;
    body: string;
    /** Projects the vendor's text into the owner's thread (the pipeline's own `projectClassifiedInbound`). */
    projectInbound: (vendorUserId: string | null) => Promise<unknown>;
  },
): Promise<VendorLineInboundResult> {
  const phone = normalizeE164(args.fromPhone);
  if (!phone) return { handled: false };
  let mode: "service_line" | "shared";
  let ownerUserId: string | null;
  try {
    const config = await loadSharedLineConfig(db);
    if (isSharedLineNumber(config, args.toPhone)) {
      mode = "shared";
      ownerUserId = await readPlatformServiceOwnerId(db);
    } else if (await isPropLaneServiceLine(db, { ownerUserId: args.managerUserId, workNumber: args.toPhone, sharedNumber: config.sharedNumber })) {
      mode = "service_line";
      ownerUserId = args.managerUserId;
    } else {
      return { handled: false };
    }
  } catch {
    return { handled: false };
  }

  const turn = await handlePropLaneVendorText(db, { ownerUserId, phoneE164: phone, body: args.body, messageSid: args.messageSid, mode });
  if (!turn.handled || !turn.reply) return { handled: false };

  await args.projectInbound(turn.vendorUserId).catch((error: unknown) =>
    console.error("vendor line inbound projection failed", error instanceof Error ? error.message : "unknown"));

  const dedupe = `vendor_line_reply_${args.messageSid}`;
  if (mode === "shared") {
    const sent = await sendSharedLineMessage(db, {
      workspaceId: args.workspaceId ?? "",
      ownerUserId: args.managerUserId,
      toPhone: phone,
      body: turn.reply,
      role: "vendor",
      idempotencyKey: `vendor-line:${args.messageSid}`,
    });
    return { handled: true, sent: sent.ok, vendorUserId: turn.vendorUserId };
  }
  // A vendor texting the line first is their own opt-in to replies in this thread (never over a STOP).
  const consent = await recordVendorInboundReplyConsent(db, { managerUserId: args.managerUserId, vendorUserId: turn.vendorUserId, phone, messageSid: args.messageSid })
    .catch(() => "unavailable" as const);
  if (consent === "suppressed") return { handled: true, sent: true, vendorUserId: turn.vendorUserId };
  const { sendFromManagerWorkNumber } = await import("@/lib/proplane-sms-transport.server");
  const sent = await sendFromManagerWorkNumber({
    managerUserId: args.managerUserId,
    to: phone,
    text: turn.reply,
    fromNumber: args.toPhone,
    counterpartyRole: "vendor",
    sendClass: "transactional",
    purpose: VENDOR_CONVERSATION_PURPOSE,
    conversationKey: buildConversationKey({ ownerManagerUserId: args.managerUserId, role: "vendor", counterpartyUserId: turn.vendorUserId, counterpartyPhone: phone }),
    dedupeKey: dedupe,
    workspaceId: args.workspaceId ?? null,
  });
  const accepted = sent.ok || Boolean(sent.durablyAccepted);
  if (!accepted) console.error("vendor line reply not sent", sent.error ?? "unknown");
  return { handled: true, sent: accepted, vendorUserId: turn.vendorUserId };
}
