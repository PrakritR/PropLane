import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadManagerAutomationSettings } from "@/lib/payment-automation-settings";
import {
  managerNotificationCategoryForEvent,
  resolveManagerNotificationRoute,
  type ManagerNotificationCategory,
} from "@/lib/manager-notification-preferences";
import { isPhoneOptedOut } from "@/lib/sms-consent";
import { resolveActiveManagerSendNumber } from "@/lib/sms/manager-number-provisioning.server";

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
): Promise<{ inbox: boolean; email: boolean; sms: boolean; fellBackToAssistant: boolean }> {
  let profile = suppliedProfile ?? null;
  if (!profile) {
    const { data } = await db
      .from("profiles")
      .select("phone, phone_verified_at, sms_from_number, sms_forward_inbound")
      .eq("id", managerUserId)
      .maybeSingle();
    profile = (data as ManagerNotificationProfile | null) ?? null;
  }

  const settings = await loadManagerAutomationSettings(db, managerUserId);
  const resolvedCategory = managerNotificationCategoryForEvent(category);
  const phone = String(profile?.phone ?? "").trim();
  const optedOut = phone ? await isPhoneOptedOut(db, phone) : false;
  const categoryEnabled = settings.managerNotificationCategories[resolvedCategory];
  const destinationNeedsSms =
    settings.managerNotificationDestination === "personal_number" ||
    settings.managerNotificationDestination === "both";
  const activeWorkNumber =
    categoryEnabled && destinationNeedsSms
      ? await resolveActiveManagerSendNumber(db, managerUserId).catch(() => null)
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
  };
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
  },
): Promise<{ sent: boolean }> {
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
  );
  const to = String(profile?.phone ?? "").trim();
  const fromNumber = channels.sms
    ? await resolveActiveManagerSendNumber(db, input.managerUserId).catch(() => null)
    : null;
  if (!channels.sms || !to || !fromNumber) return { sent: false };

  const { sendPropLaneSms } = await import("@/lib/proplane-sms-transport.server");
  const result = await sendPropLaneSms({
    to,
    fromNumber,
    text: `${input.subject}\n${input.text}`.slice(0, 1500),
    sendClass: "transactional",
    purpose: input.purpose,
    dedupeKey: input.dedupeKey,
    log: {
      managerUserId: input.managerUserId,
      residentPhone: to,
      source: "automated",
      counterpartyRole: "manager",
    },
  }).catch(() => null);
  return { sent: Boolean(result && "sent" in result && result.sent) };
}
