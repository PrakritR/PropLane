import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadSharedLineConfig, workspaceOnSharedLine } from "@/lib/one-number/config.server";
import type { PhoneBoundLinkPurpose, SharedLineRole } from "@/lib/one-number/contracts";
import { sendSharedLineMessage } from "@/lib/one-number/send.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { sendFromManagerWorkNumber } from "@/lib/proplane-sms-transport.server";
import type { SmsCounterpartyRole } from "@/lib/sms-conversation-identity";
import { ensureVendorLinkRequestConsent, vendorConversationKeys, VENDOR_CONVERSATION_PURPOSE } from "@/lib/sms/vendor-conversation-consent.server";
import { MANAGER_NOTICE_SMS_PURPOSE_PREFIX } from "@/lib/sms/team-notice-consent.server";

/** The role a texted code is billed and signed as, by what the person is doing. */
export function roleForLinkPurpose(purpose: PhoneBoundLinkPurpose | "public_apply" | "public_tour"): SharedLineRole {
  switch (purpose) {
    case "lease":
      return "applicant";
    case "rent":
    case "move_in":
      return "resident";
    case "job":
    case "payouts":
      return "vendor";
    default:
      return "prospect";
  }
}

/**
 * Why this text may go to this phone, which is what the consent gate reads.
 *
 * - `code`: a one-time code the person JUST asked for (they tapped "text me a code" on a link bound to
 *   their phone, or typed the number they are proving). It is `control` class, like a passcode a
 *   person requests from any service: the request is the consent, it carries no marketing and no
 *   account history, and it needs no stored grant. STOP is still absolute: the dispatcher reads the
 *   suppression ledger before the class check, so a number that texted STOP gets no code.
 * - `manager_notice`: a notice to a signed-in manager or owner at their own verified profile phone.
 *   It uses the manager-recipient purposes the consent model defines (`manager_agent_notification_*`),
 *   so the grant is that verified phone and not a rental application they never filed.
 * - `vendor_notice`: a notice to a vendor in their own vendor thread (`vendor_conversation`). A vendor
 *   who texted the line or who the manager attested holds that grant; nothing here invents one.
 */
export type PhoneTextBasis =
  | { kind: "code" }
  | { kind: "manager_notice"; topic: string; recipientUserId: string }
  | {
      kind: "vendor_notice";
      recipientUserId: string | null;
      /** The phone-bound link the vendor asked for by text: that request is their opt-in to this one reply. */
      requestLinkId?: string | null;
    };

export const LINK_CODE_SMS_PURPOSE = "phone_link_code";

/** The delivery the consent gate sees for a basis (pure; tested on its own). */
export function deliveryForBasis(
  basis: PhoneTextBasis,
  ownerUserId: string,
  phone: string,
): { sendClass: "control" | "transactional"; purpose: string; recipientUserId: string | null; conversationKey: string | null; counterpartyRole: SmsCounterpartyRole | null } {
  if (basis.kind === "code") {
    return { sendClass: "control", purpose: LINK_CODE_SMS_PURPOSE, recipientUserId: null, conversationKey: null, counterpartyRole: null };
  }
  if (basis.kind === "manager_notice") {
    const topic = basis.topic.trim().replace(/[^a-z0-9_]/gi, "_").toLowerCase() || "notice";
    return {
      sendClass: "transactional",
      purpose: `${MANAGER_NOTICE_SMS_PURPOSE_PREFIX}${topic}`,
      recipientUserId: basis.recipientUserId,
      conversationKey: null,
      counterpartyRole: "manager",
    };
  }
  return {
    sendClass: "transactional",
    purpose: VENDOR_CONVERSATION_PURPOSE,
    recipientUserId: basis.recipientUserId,
    conversationKey: vendorConversationKeys({ managerUserId: ownerUserId, vendorUserId: basis.recipientUserId, phone })[0] ?? null,
    counterpartyRole: "vendor",
  };
}

/**
 * Send a text to a phone, from the workspace it concerns: through the shared-line sender when the
 * workspace is on the shared line, otherwise from the workspace's own work number (exactly today's
 * path). The destination is whatever the CALLER bound (a link's phone, a verified profile phone, or the
 * phone someone just typed to prove they hold it); a model or request body never reaches here.
 * `basis` says why the person may be texted (see `PhoneTextBasis`). Returns whether the text left; a
 * refusal (opted out, no number, no consent) is a plain false.
 */
export async function sendWorkspacePhoneText(
  db: SupabaseClient,
  input: {
    workspaceId: string;
    phoneKey: string;
    body: string;
    role: SharedLineRole;
    idempotencyKey: string;
    basis: PhoneTextBasis;
  },
): Promise<boolean> {
  const to = normalizeE164(input.phoneKey);
  if (!to) return false;
  const { data: workspace, error } = await db
    .from("portal_workspaces")
    .select("id, owner_user_id")
    .eq("id", input.workspaceId)
    .maybeSingle();
  const ownerUserId = String((workspace as Record<string, unknown> | null)?.owner_user_id ?? "").trim();
  if (error || !ownerUserId) return false;
  const delivery = deliveryForBasis(input.basis, ownerUserId, to);
  if (input.basis.kind === "vendor_notice" && input.basis.requestLinkId) {
    const allowed = await ensureVendorLinkRequestConsent(db, {
      managerUserId: ownerUserId,
      vendorUserId: input.basis.recipientUserId,
      phone: to,
      linkId: input.basis.requestLinkId,
    }).catch(() => false);
    if (!allowed) return false;
  }

  const config = await loadSharedLineConfig(db);
  if (workspaceOnSharedLine(config, input.workspaceId)) {
    const result = await sendSharedLineMessage(db, {
      workspaceId: input.workspaceId,
      ownerUserId,
      toPhone: to,
      body: input.body,
      role: input.role,
      idempotencyKey: input.idempotencyKey,
      delivery: {
        sendClass: delivery.sendClass,
        purpose: delivery.purpose,
        conversationKey: delivery.conversationKey,
        recipientUserId: delivery.recipientUserId,
      },
    });
    if (result.ok) return true;
    // Anything but "the shared sender is not live yet" is a real refusal.
    if (result.reason !== "not_shared_mode") return false;
  }

  const sent = await sendFromManagerWorkNumber({
    managerUserId: ownerUserId,
    // The workspace the text is about: a workspace with its own number texts from it.
    workspaceId: input.workspaceId,
    to,
    text: input.body,
    sendClass: delivery.sendClass,
    purpose: delivery.purpose,
    dedupeKey: input.idempotencyKey,
    ...(delivery.recipientUserId ? { recipientUserId: delivery.recipientUserId } : {}),
    ...(delivery.conversationKey ? { conversationKey: delivery.conversationKey } : {}),
    ...(delivery.counterpartyRole ? { counterpartyRole: delivery.counterpartyRole } : {}),
    // A code or an account notice is never copied into the Communication thread.
    skipLog: true,
  });
  return sent.ok;
}
