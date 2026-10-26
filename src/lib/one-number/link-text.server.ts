import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { formatSmsLinks } from "@/lib/sms/link-format";
import { loadSharedLineConfig, workspaceOnSharedLine } from "@/lib/one-number/config.server";
import type { PhoneBoundLinkPurpose, SharedLineRole } from "@/lib/one-number/contracts";
import { sendSharedLineMessage } from "@/lib/one-number/send.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { sendFromManagerWorkNumber } from "@/lib/proplane-sms-transport.server";
import { resolveWorkspaceSendLine } from "@/lib/sms/manager-number-provisioning.server";
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
  /**
   * A resident's own rent text (a reminder, a pay link): the purpose names what it is (`payment_reminder`,
   * `weekly_rent_reminder`, ...) and the resident's consent is the one their rental application recorded for
   * it, materialized per purpose by the dispatcher. It stays in the Communication thread as any reminder does.
   */
  | {
      kind: "resident_notice";
      purpose: string;
      sendClass: "transactional" | "automated";
      recipientUserId: string | null;
      recipientEmail: string | null;
    }
  | { kind: "manager_notice"; topic: string; recipientUserId: string }
  | {
      kind: "vendor_notice";
      recipientUserId: string | null;
      /** The phone-bound link the vendor asked for by text: that request is their opt-in to this one reply. */
      requestLinkId?: string | null;
    };

export const LINK_CODE_SMS_PURPOSE = "phone_link_code";

type Delivery = {
  sendClass: "control" | "transactional" | "automated";
  purpose: string;
  recipientUserId: string | null;
  recipientEmail: string | null;
  conversationKey: string | null;
  counterpartyRole: SmsCounterpartyRole | null;
  /** Copy the text into the Communication thread (a resident's reminder yes; a code or account notice no). */
  logToThread: boolean;
};

/** The delivery the consent gate sees for a basis (pure; tested on its own). */
export function deliveryForBasis(basis: PhoneTextBasis, ownerUserId: string, phone: string): Delivery {
  if (basis.kind === "code") {
    return { sendClass: "control", purpose: LINK_CODE_SMS_PURPOSE, recipientUserId: null, recipientEmail: null, conversationKey: null, counterpartyRole: null, logToThread: false };
  }
  if (basis.kind === "manager_notice") {
    const topic = basis.topic.trim().replace(/[^a-z0-9_]/gi, "_").toLowerCase() || "notice";
    return {
      sendClass: "transactional",
      purpose: `${MANAGER_NOTICE_SMS_PURPOSE_PREFIX}${topic}`,
      recipientUserId: basis.recipientUserId,
      recipientEmail: null,
      conversationKey: null,
      counterpartyRole: "manager",
      logToThread: false,
    };
  }
  if (basis.kind === "resident_notice") {
    return {
      sendClass: basis.sendClass,
      purpose: basis.purpose,
      recipientUserId: basis.recipientUserId,
      recipientEmail: basis.recipientEmail,
      conversationKey: null,
      counterpartyRole: "resident",
      logToThread: true,
    };
  }
  return {
    sendClass: "transactional",
    purpose: VENDOR_CONVERSATION_PURPOSE,
    recipientUserId: basis.recipientUserId,
    recipientEmail: null,
    conversationKey: vendorConversationKeys({ managerUserId: ownerUserId, vendorUserId: basis.recipientUserId, phone })[0] ?? null,
    counterpartyRole: "vendor",
    logToThread: false,
  };
}

export type WorkspaceTextResult = { ok: boolean; error?: string; outboxId?: string };

/** The shared-line sender's closed reasons, in the words the reminder claim logic already knows. */
function sharedFailureError(reason: string, detail?: string): string {
  switch (reason) {
    case "opted_out":
      return "recipient_opted_out";
    case "budget":
      return "allowance_exhausted";
    case "quiet_hours":
      return "quiet_hours";
    case "no_shared_number":
      return "number_missing";
    default:
      return detail || "provider_error";
  }
}

/**
 * Send a text to a phone, from the line of the workspace it concerns, and say what happened.
 *
 *   1. the workspace is on the PropLane line (shared mode): the shared-line sender;
 *   2. a workspace of PropLane's own service (`is_service`) always texts on the PropLane line - the shared number, or
 *      in per-workspace mode the service owner's line - even when it still holds a number of its own (Oct 25);
 *   3. else the workspace's own work number;
 *   4. anything else with no number of its own is refused with `workspace_has_no_work_number` (one number
 *      per workspace; a workspace never borrows another customer's line).
 */
export async function sendWorkspaceText(
  db: SupabaseClient,
  input: {
    workspaceId: string;
    phoneKey: string;
    body: string;
    role: SharedLineRole;
    idempotencyKey: string;
    basis: PhoneTextBasis;
    /** The house the text is about, when a work number is chosen per house. */
    propertyId?: string | null;
  },
): Promise<WorkspaceTextResult> {
  const to = normalizeE164(input.phoneKey);
  if (!to) return { ok: false, error: "invalid_to" };
  const { data: workspace, error } = await db
    .from("portal_workspaces")
    .select("id, owner_user_id")
    .eq("id", input.workspaceId)
    .maybeSingle();
  const ownerUserId = String((workspace as Record<string, unknown> | null)?.owner_user_id ?? "").trim();
  if (error || !ownerUserId) return { ok: false, error: "workspace_unavailable" };
  const delivery = deliveryForBasis(input.basis, ownerUserId, to);
  if (input.basis.kind === "vendor_notice" && input.basis.requestLinkId) {
    const allowed = await ensureVendorLinkRequestConsent(db, {
      managerUserId: ownerUserId,
      vendorUserId: input.basis.recipientUserId,
      phone: to,
      linkId: input.basis.requestLinkId,
    }).catch(() => false);
    if (!allowed) return { ok: false, error: "scoped_consent_missing" };
  }
  // Every link in a text is on its own line, on the canonical host, with nothing glued to it.
  const body = formatSmsLinks(input.body, resolveEmailLinkBaseUrl());

  const config = await loadSharedLineConfig(db);
  if (workspaceOnSharedLine(config, input.workspaceId)) {
    const result = await sendSharedLineMessage(db, {
      workspaceId: input.workspaceId,
      ownerUserId,
      toPhone: to,
      body,
      role: input.role,
      idempotencyKey: input.idempotencyKey,
      delivery: {
        sendClass: delivery.sendClass,
        purpose: delivery.purpose,
        conversationKey: delivery.conversationKey,
        recipientUserId: delivery.recipientUserId,
      },
    });
    if (result.ok) return { ok: true };
    // Anything but "the shared sender is not live yet" is a real refusal.
    if (result.reason !== "not_shared_mode") return { ok: false, error: sharedFailureError(result.reason, result.detail) };
  }

  const viaLine = (workspaceId: string | null, propertyId: string | null, selectedWorkLineId: string | null) =>
    sendFromManagerWorkNumber({
      managerUserId: ownerUserId,
      // The workspace the text is about: a workspace with its own number texts from it.
      ...(workspaceId ? { workspaceId } : {}),
      to,
      text: body,
      sendClass: delivery.sendClass,
      purpose: delivery.purpose,
      dedupeKey: input.idempotencyKey,
      ...(delivery.recipientUserId ? { recipientUserId: delivery.recipientUserId } : {}),
      ...(delivery.recipientUserId && delivery.counterpartyRole === "resident" ? { residentUserId: delivery.recipientUserId } : {}),
      ...(delivery.recipientEmail ? { residentEmail: delivery.recipientEmail } : {}),
      ...(delivery.conversationKey ? { conversationKey: delivery.conversationKey } : {}),
      ...(delivery.counterpartyRole ? { counterpartyRole: delivery.counterpartyRole } : {}),
      ...(propertyId ? { propertyId } : {}),
      ...(selectedWorkLineId ? { selectedWorkLineId } : {}),
      // A code or an account notice is never copied into the Communication thread.
      skipLog: !delivery.logToThread,
    });
  // The workspace's own line, when it has one, is chosen by id so a non-default workspace never texts from
  // the owner's default line by accident. A PropLane-managed workspace (`is_service`) texts on the PropLane line in both
  // modes: `resolveWorkspaceSendLine` and the dispatcher's readiness check both resolve it there, and a line that cannot be
  // resolved refuses the send (no retry on the owner's default line, which could be the old number).
  const own = await resolveWorkspaceSendLine(db, ownerUserId, input.workspaceId).catch(() => null);
  const sent = await viaLine(input.workspaceId, input.propertyId ?? null, own?.numberId ?? null);
  return { ok: sent.ok, ...(sent.error ? { error: sent.error } : {}), ...(sent.outboxId ? { outboxId: sent.outboxId } : {}) };
}

/**
 * Send a text to a phone, from the workspace it concerns. The destination is whatever the CALLER bound (a
 * link's phone, a verified profile phone, or the phone someone just typed to prove they hold it); a model or
 * request body never reaches here. `basis` says why the person may be texted (see `PhoneTextBasis`). Returns
 * whether the text left; a refusal (opted out, no number, no consent) is a plain false.
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
  return (await sendWorkspaceText(db, input)).ok;
}
