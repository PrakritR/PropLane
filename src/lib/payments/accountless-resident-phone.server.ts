import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeConsentPhone } from "@/lib/sms-consent";

/**
 * The phone the manager keeps on file for a resident who has no PropLane login: an imported resident (placeholder
 * `@import.proplane.local` address) or anyone whose charges carry no `resident_user_id`. There is no account to vouch for
 * a number, so the manager's own records are the source: the resident's lease row (the application and intake the
 * lease was made from) and their application row, for this manager, this house and this exact resident address.
 *
 * A phone-bound rent link for such a resident is minted to, and only opens for, a number found here. Change the phone
 * on the lease and every earlier link for the old number reads "This link is for a different number".
 */

type Row = Record<string, unknown>;
const str = (value: unknown): string => (typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim());
const obj = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});

/** A resident address an account deletion scrubbed: nobody is left to pay or to text. */
export function isDeletedResidentEmail(email: string): boolean {
  return /^deleted-[0-9a-f-]+@deleted\.invalid$/i.test(email.trim());
}

function phoneKey(value: unknown): string {
  const key = normalizeConsentPhone(str(value));
  return /^\d{10}$/.test(key) ? key : "";
}

/** Phone keys (10 digits) on the resident's own lease and application rows, newest lease first. */
export function phonesFromLeaseRow(rowData: unknown): string[] {
  const data = obj(rowData);
  if (str(data.voidedAt)) return [];
  return [phoneKey(obj(data.application).phone), phoneKey(obj(data.leaseIntake).phone)].filter(Boolean);
}

export async function accountlessResidentPhoneKeys(
  db: SupabaseClient,
  input: { managerUserId: string; propertyId: string; residentEmail: string },
): Promise<string[]> {
  const managerUserId = str(input.managerUserId);
  const propertyId = str(input.propertyId);
  const email = str(input.residentEmail).toLowerCase();
  if (!managerUserId || !propertyId || !email || isDeletedResidentEmail(email)) return [];

  const found: string[] = [];
  const { data: leases, error: leaseError } = await db
    .from("portal_lease_pipeline_records")
    .select("id, row_data, resident_email, resident_user_id, updated_at")
    .eq("manager_user_id", managerUserId)
    .eq("property_id", propertyId)
    .eq("resident_email", email)
    .order("updated_at", { ascending: false })
    .limit(10);
  if (leaseError) return [];
  for (const row of (leases ?? []) as Row[]) {
    // A lease that names an account is that account's: its verified phone is the one that counts, not this one.
    if (str(row.resident_user_id) || str(obj(row.row_data).residentUserId)) continue;
    found.push(...phonesFromLeaseRow(row.row_data));
  }

  const { data: apps, error: appError } = await db
    .from("manager_application_records")
    .select("id, row_data, resident_email, property_id, assigned_property_id")
    .eq("manager_user_id", managerUserId)
    .eq("resident_email", email)
    .limit(10);
  if (!appError) {
    for (const row of (apps ?? []) as Row[]) {
      const house = str(row.assigned_property_id) || str(row.property_id);
      if (house !== propertyId) continue;
      const key = phoneKey(obj(row.row_data).phone);
      if (key) found.push(key);
    }
  }
  return [...new Set(found)];
}

/** Is `phone` the number the manager has on file for this login-less resident? */
export async function accountlessResidentPhoneMatches(
  db: SupabaseClient,
  input: { managerUserId: string; propertyId: string; residentEmail: string },
  phone: string,
): Promise<boolean> {
  const key = phoneKey(phone);
  if (!key) return false;
  return (await accountlessResidentPhoneKeys(db, input)).includes(key);
}
