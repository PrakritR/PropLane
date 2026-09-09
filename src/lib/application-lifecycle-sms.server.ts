/**
 * Application lifecycle SMS via PropLane / Claw.
 */

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { residentPortalUrl } from "@/lib/claw-resident-links";
import { fetchManagerSmsConversations } from "@/lib/manager-sms-messages.server";
import { canSendResidentOutboundSms, sendResidentOutboundSms } from "@/lib/resident-outbound-sms.server";
import {
  resolveExistingSmsConversation,
  type ExistingSmsConversation,
  type ExistingSmsConversationResolution,
} from "@/lib/sms/existing-conversation.server";

export type ApplicationSmsEvent = "submitted" | "approved" | "rejected" | "needs_info";

function applicationSmsBody(
  event: ApplicationSmsEvent,
  opts: {
    applicantName?: string | null;
    propertyTitle?: string | null;
    axisId?: string | null;
    signupUrl?: string | null;
    setupEmailSelected?: boolean;
  },
): string {
  const name = (opts.applicantName ?? "").trim();
  const where = (opts.propertyTitle ?? "").trim();
  const at = where ? ` for ${where}` : "";
  const hi = name ? `Hi ${name}` : "Hi";

  switch (event) {
    case "submitted": {
      const lines = [
        `${hi} — PropLane received your rental application${at}.`,
        opts.axisId?.trim() ? `Application ID: ${opts.axisId.trim()}` : null,
        "We'll text you when there's an update.",
      ].filter(Boolean) as string[];
      if (opts.signupUrl?.trim()) {
        lines.push(`Create your resident account: ${opts.signupUrl.trim()}`);
      } else {
        lines.push(`Track status: ${residentPortalUrl("applications")}`);
      }
      return lines.join("\n");
    }
    case "approved":
      return [
        `${hi} — your rental application${at} was approved.`,
        opts.setupEmailSelected
          ? "Check your email for your PropLane resident portal setup link and next steps."
          : `Next steps: ${residentPortalUrl("login")}`,
      ].join("\n");
    case "rejected":
      return [
        `${hi} — your rental application${at} was not approved.`,
        `Details: ${residentPortalUrl("applications")}`,
      ].join("\n");
    case "needs_info":
      return [
        `${hi} — your property manager needs more information on your application${at}.`,
        `Open applications: ${residentPortalUrl("applications")}`,
      ].join("\n");
    default:
      return `PropLane application update${at}. ${residentPortalUrl("applications")}`;
  }
}

async function resolveApplicantPhone(
  db: SupabaseClient,
  email: string,
  fallbackPhone?: string | null,
): Promise<{ phone: string; userId: string | null }> {
  const normalized = email.trim().toLowerCase();
  if (normalized.includes("@")) {
    const { data } = await db.from("profiles").select("id, phone").eq("email", normalized).maybeSingle();
    const phone = String(data?.phone ?? "").trim() || String(fallbackPhone ?? "").trim();
    return { phone, userId: data?.id ? String(data.id) : null };
  }
  return { phone: String(fallbackPhone ?? "").trim(), userId: null };
}

/**
 * Reuse an existing prospect/applicant thread only when its owner and phone are
 * exact and unambiguous. A phone can legitimately have several role threads;
 * choosing one by recency would leak an approval into the wrong conversation.
 */
export function resolveExistingApplicantConversation(
  rows: Awaited<ReturnType<typeof fetchManagerSmsConversations>>["residents"],
  args: { managerUserId: string; applicantPhone: string; workNumber: string | null },
): ExistingSmsConversationResolution {
  return resolveExistingSmsConversation(rows, {
    managerUserId: args.managerUserId,
    recipientPhone: args.applicantPhone,
    workNumber: args.workNumber,
    allowedRoles: ["prospect", "applicant"],
  });
}

/**
 * Text the applicant about an application lifecycle event. Opens a Claw thread
 * under topic `applications` when a manager id is provided.
 */
export async function notifyApplicantApplicationSms(
  db: SupabaseClient,
  input: {
    event: ApplicationSmsEvent;
    applicantEmail: string;
    applicantPhone?: string | null;
    applicantName?: string | null;
    propertyTitle?: string | null;
    axisId?: string | null;
    signupUrl?: string | null;
    managerUserId?: string | null;
    fromNumber?: string | null;
    /** Stable owner-scoped idempotency key for lifecycle retries. */
    dedupeKey?: string | null;
    /** The approved route accepted the setup-email channel for this message. */
    setupEmailSelected?: boolean;
  },
): Promise<{ sent: boolean; accepted?: boolean; error?: string; outboxStatus?: string }> {
  const email = input.applicantEmail.trim().toLowerCase();
  const managerUserId = input.managerUserId?.trim() || null;
  // Managed Twilio derives the authoritative sender from manager_sms_numbers,
  // not the denormalized profiles.sms_from_number cache. Only require the
  // legacy transport check when there is no owner scope to resolve.
  if (!managerUserId && !canSendResidentOutboundSms(input.fromNumber)) {
    return { sent: false, error: "sms_not_configured" };
  }

  const { phone, userId } = await resolveApplicantPhone(db, email, input.applicantPhone);
  if (!phone) return { sent: false, error: "no_phone" };

  let existingThread: ExistingSmsConversation | null = null;
  if (managerUserId && input.event === "approved") {
    try {
      const conversations = await fetchManagerSmsConversations(db, managerUserId, {
        scopeManagerIdsOverride: [managerUserId],
        provisionWorkNumber: false,
      });
      const resolution = resolveExistingApplicantConversation(conversations.residents, {
        managerUserId,
        applicantPhone: phone,
        workNumber: conversations.workNumber,
      });
      if (resolution.kind !== "matched") {
        return { sent: false, error: resolution.kind === "ambiguous" ? "conversation_ambiguous" : resolution.kind === "sender_unavailable" ? "conversation_sender_unavailable" : "conversation_not_found" };
      }
      existingThread = resolution.conversation;
    } catch {
      return { sent: false, error: "conversation_lookup_failed" };
    }
  }

  const text = applicationSmsBody(input.event, {
    applicantName: input.applicantName,
    propertyTitle: input.propertyTitle,
    axisId: input.axisId,
    signupUrl: input.signupUrl,
    setupEmailSelected: input.setupEmailSelected,
  });

  const result = await sendResidentOutboundSms({
    to: phone,
    text,
    fromNumber: input.fromNumber,
    linkKind: null,
    sendClass: "transactional",
    openThread: managerUserId
      ? {
          managerUserId,
          residentUserId: userId,
          residentEmail: email || null,
          topic: "applications",
          counterpartyRole: existingThread?.counterpartyRole ?? "applicant",
          conversationKey: existingThread?.conversationKey ?? null,
        }
      : null,
    // Submitted often has no manager thread yet / prospect — skip inverted mirror.
    mirrorToManager: Boolean(managerUserId) && input.event !== "submitted",
    purpose: `application_${input.event}_notification`,
    dedupeKey: input.dedupeKey ?? undefined,
  });

  return { sent: result.sent, accepted: result.accepted, error: result.error, outboxStatus: result.outboxStatus };
}
