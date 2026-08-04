import type { SupabaseClient } from "@supabase/supabase-js";

import type { ManagerManualPaymentSettings } from "@/lib/manager-manual-payment-settings";
import type { HouseholdCharge } from "@/lib/household-charges";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function patchSubmission(
  submission: ManagerListingSubmissionV1,
  settings: ManagerManualPaymentSettings,
): ManagerListingSubmissionV1 {
  return {
    ...submission,
    zellePaymentsEnabled: settings.zellePaymentsEnabled,
    zelleContact: settings.zelleContact,
    venmoPaymentsEnabled: settings.venmoPaymentsEnabled,
    venmoContact: settings.venmoContact,
    applicationFeeZelleEnabled: settings.zellePaymentsEnabled,
    applicationFeeVenmoEnabled: settings.venmoPaymentsEnabled,
  };
}

/**
 * Push manual destinations to the selected owned listings and their still-open
 * charges. Charges deliberately are not a historical snapshot for a payee:
 * showing an old Zelle number after a manager changes it is a money-routing
 * error. Paid charges are retained as historical records and never changed.
 */
export async function applyManagerManualPaymentsToListings(
  db: SupabaseClient,
  managerUserId: string,
  settings: ManagerManualPaymentSettings,
  propertyIds?: string[],
): Promise<{ listingsUpdated: number; chargesUpdated: number }> {
  const selected = new Set((propertyIds ?? []).map((id) => id.trim()).filter(Boolean));
  const { data: rows, error } = await db
    .from("manager_property_records")
    .select("id, row_data, property_data")
    .eq("manager_user_id", managerUserId);
  if (error) throw error;
  const targets = (rows ?? []).filter((row) => selected.has(String(row.id)));
  let listingsUpdated = 0;
  for (const row of targets) {
    const rowData = asObject(row.row_data);
    const propertyData = asObject(row.property_data);
    const submission = (propertyData.listingSubmission ?? rowData.submission) as ManagerListingSubmissionV1 | undefined;
    if (!submission || typeof submission !== "object") continue;
    const nextSubmission = patchSubmission(submission, settings);
    const nextPropertyData = propertyData.listingSubmission
      ? { ...propertyData, listingSubmission: nextSubmission }
      : propertyData;
    const nextRowData = rowData.submission ? { ...rowData, submission: nextSubmission } : rowData;
    const { error: upsertError } = await db
      .from("manager_property_records")
      .update({
        row_data: nextRowData,
        property_data: nextPropertyData,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    if (upsertError) throw upsertError;
    listingsUpdated += 1;
  }

  const targetIds = targets.map((row) => String(row.id));
  if (targetIds.length === 0) return { listingsUpdated, chargesUpdated: 0 };
  const { data: chargeRows, error: chargeError } = await db
    .from("portal_household_charge_records")
    .select("id, row_data")
    .eq("manager_user_id", managerUserId)
    .eq("status", "pending")
    .in("property_id", targetIds);
  if (chargeError) throw chargeError;
  let chargesUpdated = 0;
  for (const row of chargeRows ?? []) {
    const charge = row.row_data as HouseholdCharge | null;
    if (!charge?.id) continue;
    const next: HouseholdCharge = {
      ...charge,
      zelleContactSnapshot:
        settings.zellePaymentsEnabled && settings.zelleContact.trim() ? settings.zelleContact.trim() : undefined,
      venmoContactSnapshot:
        settings.venmoPaymentsEnabled && settings.venmoContact.trim() ? settings.venmoContact.trim() : undefined,
    };
    const { error: updateError } = await db
      .from("portal_household_charge_records")
      .update({ row_data: next, updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("manager_user_id", managerUserId)
      .eq("status", "pending");
    if (updateError) throw updateError;
    chargesUpdated += 1;
  }
  return { listingsUpdated, chargesUpdated };
}
