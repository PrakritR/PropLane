import { enrichHouseholdChargesFromPropertyRecords } from "@/lib/household-charge-payment-eligibility.server";
import type { HouseholdCharge, RecurringRentProfile } from "@/lib/household-charges";
import { filterChargesEligibleForPaymentReminders } from "@/lib/household-charges";
import { normalizeManagerListingSubmissionV1, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  loadManagerAutomationSettings,
  loadScheduledMessageOverrides,
  legacyPaymentReminderDedupIds,
  type PaymentReminderKind,
} from "@/lib/payment-automation-settings";
import { projectScheduledPaymentMessages, type ScheduledPaymentMessage } from "@/lib/scheduled-payment-messages";
import type { SupabaseClient } from "@supabase/supabase-js";

function listingFromPropertyRow(propertyData: unknown): ManagerListingSubmissionV1 | null {
  if (!propertyData || typeof propertyData !== "object") return null;
  const submission = (propertyData as { listingSubmission?: unknown }).listingSubmission;
  if (!submission || typeof submission !== "object") return null;
  const v = (submission as { v?: unknown }).v;
  if (v !== 1) return null;
  return normalizeManagerListingSubmissionV1(submission as ManagerListingSubmissionV1);
}

export async function loadManagerRentProfiles(
  db: SupabaseClient,
  managerUserId: string,
): Promise<RecurringRentProfile[]> {
  const { data, error } = await db
    .from("portal_recurring_rent_profile_records")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .limit(1000);
  if (error) throw error;
  return (data ?? []).map((row) => row.row_data as RecurringRentProfile);
}

export async function loadManagerPendingCharges(
  db: SupabaseClient,
  managerUserId: string,
): Promise<HouseholdCharge[]> {
  const [{ data, error }, rentProfiles] = await Promise.all([
    db
      .from("portal_household_charge_records")
      .select("id, row_data")
      .eq("manager_user_id", managerUserId)
      .eq("status", "pending")
      .limit(1000),
    loadManagerRentProfiles(db, managerUserId),
  ]);
  if (error) throw error;
  const raw = (data ?? []).map((row) => row.row_data as HouseholdCharge);
  const enriched = await enrichHouseholdChargesFromPropertyRecords(db, raw);
  return filterChargesEligibleForPaymentReminders(enriched, rentProfiles);
}

export async function loadListingByPropertyId(db: SupabaseClient): Promise<Map<string, ManagerListingSubmissionV1>> {
  const { data: propertyRows } = await db.from("manager_property_records").select("id, property_data");
  const listingByPropertyId = new Map<string, ManagerListingSubmissionV1>();
  for (const row of propertyRows ?? []) {
    const sub = listingFromPropertyRow(row.property_data);
    if (sub && typeof row.id === "string") listingByPropertyId.set(row.id, sub);
  }
  return listingByPropertyId;
}

export async function loadSentReminderDedupIds(
  db: SupabaseClient,
  chargeIds: string[],
): Promise<Set<string>> {
  if (!chargeIds.length) return new Set();
  const { data } = await db
    .from("portal_outbound_mail_records")
    .select("id")
    .limit(5000);
  const ids = new Set<string>();
  for (const row of data ?? []) {
    if (typeof row.id === "string") ids.add(row.id);
  }
  return ids;
}

export async function loadManagerScheduledMessages(
  db: SupabaseClient,
  managerUserId: string,
  opts?: { includeHidden?: boolean },
): Promise<{ settings: Awaited<ReturnType<typeof loadManagerAutomationSettings>>; messages: ScheduledPaymentMessage[] }> {
  const [settings, overrides, charges, listingByPropertyId] = await Promise.all([
    loadManagerAutomationSettings(db, managerUserId),
    loadScheduledMessageOverrides(db, managerUserId),
    loadManagerPendingCharges(db, managerUserId),
    loadListingByPropertyId(db),
  ]);

  const { data: profile } = await db.from("profiles").select("full_name, email").eq("id", managerUserId).maybeSingle();
  const managerName = profile?.full_name?.trim() || profile?.email?.trim() || "Your property manager";

  const sentDedupIds = await loadSentReminderDedupIds(
    db,
    charges.map((c) => c.id),
  );

  const messages = projectScheduledPaymentMessages({
    managerUserId,
    charges,
    settings,
    overrides,
    sentDedupIds,
    listingByPropertyId,
    managerName,
    includeHidden: opts?.includeHidden,
  });

  return { settings, messages };
}

export function parseScheduledMessageListId(id: string): {
  chargeId: string;
  kind: PaymentReminderKind;
  daysBeforeDue: number | null;
} | null {
  const parts = id.split("|");
  if (parts.length !== 5 || parts[0] !== "sched") return null;
  const chargeId = parts[1]!;
  const kind = parts[2] as PaymentReminderKind;
  if (!["pre_due", "same_day", "post_due", "overdue_daily", "late_fee", "set_date"].includes(kind)) return null;
  const dayPart = parts[3]!;
  const daysBeforeDue = dayPart === "na" ? null : Number(dayPart);
  return { chargeId, kind, daysBeforeDue: Number.isFinite(daysBeforeDue) ? daysBeforeDue : null };
}

export function reminderWasSent(
  sentIds: Set<string>,
  kind: PaymentReminderKind,
  chargeId: string,
  daysBeforeDue: number | null | undefined,
  todayKey: string,
): boolean {
  return legacyPaymentReminderDedupIds({
    kind,
    chargeId,
    daysBeforeDue: daysBeforeDue ?? undefined,
  }).some((id) => sentIds.has(id) || (kind === "overdue_daily" && sentIds.has(id.replace(todayKey, ""))));
}
