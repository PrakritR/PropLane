import type { SupabaseClient } from "@supabase/supabase-js";

import type { ManagerManualPaymentSettings } from "@/lib/manager-manual-payment-settings";
import type { HouseholdCharge } from "@/lib/household-charges";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  LISTING_PAYMENT_WAIVER_CODE,
  persistListingServiceFeePayer,
  type ServiceFeePayer,
} from "@/lib/payment-policy";

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function patchSubmission(
  submission: ManagerListingSubmissionV1,
  _settings: ManagerManualPaymentSettings,
): ManagerListingSubmissionV1 {
  return {
    ...submission,
    zellePaymentsEnabled: false,
    zelleContact: "",
    venmoPaymentsEnabled: false,
    venmoContact: "",
    applicationFeeZelleEnabled: false,
    applicationFeeVenmoEnabled: false,
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
      zelleContactSnapshot: undefined,
      venmoContactSnapshot: undefined,
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

function readListingServiceFeePayer(
  rowData: unknown,
  propertyData: unknown,
): ServiceFeePayer | null {
  const read = (container: unknown): ServiceFeePayer | null => {
    if (!container || typeof container !== "object") return null;
    const record = container as Record<string, unknown>;
    const submission = record.submission ?? record.listingSubmission;
    if (!submission || typeof submission !== "object") return null;
    const payer = (submission as { serviceFeePayer?: unknown }).serviceFeePayer;
    if (payer === "resident" || payer === "manager" || payer === "proplane") return payer;
    return null;
  };
  return read(propertyData) ?? read(rowData);
}

function patchListingServiceFeePayer(
  submission: ManagerListingSubmissionV1,
  payer: ServiceFeePayer | null,
  accountWaiverGranted: boolean,
): ManagerListingSubmissionV1 {
  if (payer === null) {
    return { ...submission, serviceFeePayer: null, serviceFeeWaiverCode: undefined };
  }
  const waiverCode =
    payer === "proplane" && accountWaiverGranted
      ? LISTING_PAYMENT_WAIVER_CODE
      : submission.serviceFeeWaiverCode;
  const persisted = persistListingServiceFeePayer(payer, waiverCode);
  return { ...submission, ...persisted };
}

export async function loadPropertyServiceFeePayers(
  db: SupabaseClient,
  managerUserId: string,
  propertyIds: string[],
): Promise<Record<string, ServiceFeePayer | null>> {
  const ids = [...new Set(propertyIds.map((id) => id.trim()).filter(Boolean))];
  const out: Record<string, ServiceFeePayer | null> = {};
  if (ids.length === 0) return out;
  const { data: rows, error } = await db
    .from("manager_property_records")
    .select("id, row_data, property_data")
    .eq("manager_user_id", managerUserId)
    .in("id", ids);
  if (error) throw error;
  for (const row of rows ?? []) {
    out[String(row.id)] = readListingServiceFeePayer(row.row_data, row.property_data);
  }
  for (const id of ids) {
    if (!(id in out)) out[id] = null;
  }
  return out;
}

export async function applyPropertyServiceFeePayersToListings(
  db: SupabaseClient,
  managerUserId: string,
  updates: Array<{ propertyId: string; serviceFeePayer: ServiceFeePayer | null }>,
  accountWaiverGranted = false,
): Promise<{ listingsUpdated: number }> {
  const byId = new Map(
    updates
      .map((row) => ({
        propertyId: row.propertyId.trim(),
        serviceFeePayer: row.serviceFeePayer,
      }))
      .filter((row) => row.propertyId)
      .map((row) => [row.propertyId, row.serviceFeePayer]),
  );
  if (byId.size === 0) return { listingsUpdated: 0 };

  const { data: rows, error } = await db
    .from("manager_property_records")
    .select("id, row_data, property_data")
    .eq("manager_user_id", managerUserId)
    .in("id", [...byId.keys()]);
  if (error) throw error;

  let listingsUpdated = 0;
  for (const row of rows ?? []) {
    const propertyId = String(row.id);
    const payer = byId.get(propertyId);
    if (payer === undefined) continue;
    const rowData = asObject(row.row_data);
    const propertyData = asObject(row.property_data);
    const submission = (propertyData.listingSubmission ?? rowData.submission) as ManagerListingSubmissionV1 | undefined;
    if (!submission || typeof submission !== "object") continue;
    const nextSubmission = patchListingServiceFeePayer(submission, payer, accountWaiverGranted);
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
  return { listingsUpdated };
}
