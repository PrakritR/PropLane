import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadManagerAutomationSettings, normalizeManagerAutomationSettings } from "@/lib/payment-automation-settings";
import {
  managerNotificationCategoryForEvent,
  resolveManagerNotificationRoute,
  type ManagerNotificationCategory,
  type ManagerNotificationDestination,
} from "@/lib/manager-notification-preferences";
import { isPhoneOptedOut } from "@/lib/sms-consent";
import {
  resolveActiveManagerSendNumber,
  resolveWorkspaceSendLine,
} from "@/lib/sms/manager-number-provisioning.server";
import { resolveSettingsScope, type SettingsScopeCache } from "@/lib/settings/scope-resolver.server";

export type ManagerNotificationProfile = {
  phone?: string | null;
  phone_verified_at?: string | null;
  sms_from_number?: string | null;
  sms_forward_inbound?: boolean | null;
};

export async function resolveManagerNotificationChannels(
  db: SupabaseClient,
  managerUserId: string,
  category: ManagerNotificationCategory | string,
  suppliedProfile?: ManagerNotificationProfile | null,
  /**
   * The triggering row's workspace, when it has one (PLAN-0920-0845 phase C).
   * Notifications have no property rung — a house-level override never
   * applies here — so this resolves workspace row → account row → default.
   * Omitted (or no matching workspace row) behaves exactly as before: the
   * manager's account-level notification settings.
   */
  workspaceId?: string | null,
  cache?: SettingsScopeCache,
  /**
   * Whose work number the text would leave from. A teammate is texted from the
   * WORKSPACE OWNER's number (a co-manager never has a line of their own), so
   * "work number ready" asks about that line, not the recipient's. Omitted =
   * the recipient's own default line, exactly as before.
   */
  sendFrom?: { ownerUserId: string; workspaceId?: string | null },
): Promise<{
  inbox: boolean;
  email: boolean;
  sms: boolean;
  fellBackToAssistant: boolean;
  /** The recipient's alert destination, so an email leg can honor "none". */
  destination: ManagerNotificationDestination;
  /** The topic is switched on for this recipient. */
  categoryEnabled: boolean;
  /**
   * The work-number lookup FAILED (a read error), rather than answering "no
   * line". `sms` is false either way, but only the second is a refusal: a caller
   * that must not silently drop a text needs to tell them apart.
   */
  workNumberUnreadable: boolean;
}> {
  let profile = suppliedProfile ?? null;
  if (!profile) {
    const { data } = await db
      .from("profiles")
      .select("phone, phone_verified_at, sms_from_number, sms_forward_inbound")
      .eq("id", managerUserId)
      .maybeSingle();
    profile = (data as ManagerNotificationProfile | null) ?? null;
  }

  const { value: settings } = await resolveSettingsScope(
    db,
    { managerUserId, workspaceId },
    "paymentAutomation",
    { normalize: normalizeManagerAutomationSettings, loadAccount: (d, m) => loadManagerAutomationSettings(d, m) },
    cache,
  );
  const resolvedCategory = managerNotificationCategoryForEvent(category);
  const phone = String(profile?.phone ?? "").trim();
  const optedOut = phone ? await isPhoneOptedOut(db, phone) : false;
  const categoryEnabled = settings.managerNotificationCategories[resolvedCategory];
  const destinationNeedsSms =
    settings.managerNotificationDestination === "personal_number" ||
    settings.managerNotificationDestination === "both";
  let workNumberUnreadable = false;
  const activeWorkNumber =
    categoryEnabled && destinationNeedsSms
      ? await (sendFrom
          ? resolveActiveManagerSendNumber(db, sendFrom.ownerUserId, sendFrom.workspaceId ?? null)
          : resolveActiveManagerSendNumber(db, managerUserId)
        ).catch(() => {
          workNumberUnreadable = true;
          return null;
        })
      : null;
  const route = resolveManagerNotificationRoute({
    destination: settings.managerNotificationDestination,
    categoryEnabled,
    personalPhoneReady:
      Boolean(phone) && Boolean(profile?.phone_verified_at) && !optedOut && profile?.sms_forward_inbound !== false,
    workNumberReady: Boolean(activeWorkNumber),
  });

  return {
    inbox: route.assistant,
    // Email remains a separate account notification transport. The preference
    // consolidates the two conversational paths: Assistant and manager-cell SMS.
    email: true,
    sms: route.sms,
    fellBackToAssistant: route.fellBackToAssistant,
    destination: settings.managerNotificationDestination,
    categoryEnabled,
    workNumberUnreadable,
  };
}

/**
 * Why a manager notification text did not go out. `not_routed` / `no_phone` /
 * `no_work_number` / `blocked` are deliberate refusals (the topic is off, there is
 * no verified number, a STOP, no credit) and are a quiet no. `line_unreadable` and
 * `transport` are failures of something that should have worked, so a caller may retry.
 */
export type ManagerNotificationSmsRefusal =
  | "not_routed"
  | "no_phone"
  | "no_work_number"
  | "blocked"
  | "line_unreadable"
  | "transport";

export type ManagerNotificationSmsResult = { sent: true } | { sent: false; reason: ManagerNotificationSmsRefusal };

/** True when the reason is a deliberate refusal rather than a transient failure. */
export function managerNotificationSmsRefused(reason: ManagerNotificationSmsRefusal | undefined): boolean {
  return reason === "not_routed" || reason === "no_phone" || reason === "no_work_number" || reason === "blocked";
}

export function isManagerNotificationSmsAccepted(result: {
  ok?: boolean;
  durablyAccepted?: boolean;
  outboxStatus?: string;
} | null | undefined): boolean {
  const status = String(result?.outboxStatus ?? "");
  if (["unknown", "failed", "blocked"].includes(status)) return false;
  const acceptedOutboxStatus = new Set([
    "queued", "deferred", "claimed", "submitting", "submitted", "sent", "delivered",
  ]).has(status);
  return Boolean(result?.ok || (result?.durablyAccepted && acceptedOutboxStatus));
}

export async function sendManagerNotificationSms(
  db: SupabaseClient,
  input: {
    managerUserId: string;
    category: ManagerNotificationCategory;
    subject: string;
    text: string;
    purpose: string;
    dedupeKey?: string;
    /** The triggering row's workspace, when it has one (phase C). */
    workspaceId?: string | null;
    /**
     * Send from a WORKSPACE line that is not the recipient's own: a teammate's
     * notice leaves from the workspace owner's number and is billed to the
     * owner (`ownerUserId`), never to the teammate. `text` is then prefixed
     * "PropLane: " and pinned to that line.
     */
    sendFrom?: { ownerUserId: string; workspaceId?: string | null };
  },
): Promise<ManagerNotificationSmsResult> {
  const { data } = await db
    .from("profiles")
    .select("phone, phone_verified_at, sms_from_number, sms_forward_inbound")
    .eq("id", input.managerUserId)
    .maybeSingle();
  const profile = (data as ManagerNotificationProfile | null) ?? null;
  const channels = await resolveManagerNotificationChannels(
    db,
    input.managerUserId,
    input.category,
    profile,
    input.workspaceId,
    undefined,
    input.sendFrom,
  );
  const to = String(profile?.phone ?? "").trim();
  // A line that could not be READ is a transient failure, not a refusal: the two
  // have to stay apart so a caller can retry the first and stay quiet about the second.
  let lineUnreadable = false;
  const readLine = async () => {
    try {
      return input.sendFrom
        ? await resolveWorkspaceSendLine(db, input.sendFrom.ownerUserId, input.sendFrom.workspaceId ?? null)
        : await resolveActiveManagerSendNumber(db, input.managerUserId).then((phoneNumber) =>
            phoneNumber ? { phoneNumber, numberId: null } : null,
          );
    } catch {
      lineUnreadable = true;
      return null;
    }
  };
  const line = channels.sms ? await readLine() : null;
  // `sms: false` is normally the recipient's own choice (topic off, destination,
  // no verified phone, a STOP). It is NOT when the work-number lookup threw.
  if (!channels.sms) return { sent: false, reason: channels.workNumberUnreadable ? "line_unreadable" : "not_routed" };
  if (!to) return { sent: false, reason: "no_phone" };
  if (!line) return { sent: false, reason: lineUnreadable ? "line_unreadable" : "no_work_number" };
  const fromNumber = line.phoneNumber;
  const billedTo = input.sendFrom?.ownerUserId.trim() || input.managerUserId;

  const { sendPropLaneSms } = await import("@/lib/proplane-sms-transport.server");
  const result = await sendPropLaneSms({
    to,
    fromNumber,
    text: `${input.sendFrom ? "PropLane: " : ""}${input.subject}\n${input.text}`.slice(0, 1500),
    sendClass: "transactional",
    purpose: input.purpose,
    dedupeKey: input.dedupeKey,
    // A workspace-line send is billed to the line's owner; the recipient (the
    // account whose verified phone this is) is named so the dispatcher reads
    // THEIR consent, and the line is pinned for the provider-boundary recheck.
    ...(input.sendFrom
      ? {
          actorUserId: input.managerUserId,
          recipientUserId: input.managerUserId,
          selectedWorkLineId: line.numberId,
        }
      : {}),
    // The manager's PropLane Assistant thread is the one transcript of texts to
    // their own phone (the outbox dispatcher mirrors it there once the carrier
    // accepts), so no second manager-to-self SMS conversation is projected.
    suppressConversationLog: true,
    log: {
      managerUserId: billedTo,
      residentPhone: to,
      source: "automated",
      counterpartyRole: "manager",
    },
  }).catch(() => null);
  // Managed sends return `{ ok, outboxStatus, durablyAccepted }`; they do not
  // expose a legacy `sent` field. A queued/deferred durable handoff is an
  // accepted notification, while unknown/failed/blocked outcomes never are.
  if (isManagerNotificationSmsAccepted(result)) return { sent: true };
  // `blocked` is the transport's own quiet no (a STOP, no credit); anything else
  // is a send that should have gone out and did not.
  return { sent: false, reason: String(result?.outboxStatus ?? "") === "blocked" ? "blocked" : "transport" };
}
