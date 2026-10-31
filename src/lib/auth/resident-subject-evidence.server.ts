import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Only server-stored subject ids can bind historical housing to a login. */
export async function residentSubjectManagerIds(db: SupabaseClient, userId: string, email: string): Promise<string[]> {
  void email;
  if (!userId) return [];
  const ids = new Set<string>();
  const apps = await db.from("manager_application_records").select("manager_user_id, row_data").eq("row_data->>residentUserId", userId);
  if (apps.error) return [];
  for (const row of apps.data ?? []) {
    const data = row.row_data as Record<string, unknown> | null;
    if (data?.withdrawnAt || ["rejected", "withdrawn"].includes(String(data?.bucket ?? "").toLowerCase())) continue;
    if (row.manager_user_id) ids.add(String(row.manager_user_id));
  }
  for (const table of ["portal_household_charge_records", "portal_lease_pipeline_records"]) {
    const result = await db.from(table).select("manager_user_id").eq("resident_user_id", userId);
    if (result.error) return [];
    for (const row of result.data ?? []) if (row.manager_user_id) ids.add(String(row.manager_user_id));
  }
  return [...ids];
}

/**
 * `resident_email` is stored as the writer received it on both `manager_application_records` and
 * `portal_lease_pipeline_records` (hence the `lower(resident_email)` index on the latter), so a
 * residency is matched case-insensitively and then re-checked here on the exact address. `%`, `_`
 * and the escape character itself are escaped so a local part carrying one cannot widen the pattern.
 */
function literalEmail(email: string): string {
  return email.replace(/[\\%_]/g, "\\$&");
}

function sameEmail(stored: unknown, address: string): boolean {
  return typeof stored === "string" && stored.trim().toLowerCase() === address;
}

/** Every place an application row can record the house, the same set `resolveResidentFilingScope` reads. */
function applicationPropertyIds(row: { property_id?: unknown; assigned_property_id?: unknown; row_data?: unknown }): string[] {
  const data = (row.row_data ?? {}) as Record<string, unknown>;
  const nested = (data.application ?? {}) as Record<string, unknown>;
  return [row.assigned_property_id, row.property_id, data.assignedPropertyId, data.propertyId, nested.propertyId]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
}

function applicationIsLive(row: { row_data?: unknown }): boolean {
  const data = (row.row_data ?? {}) as Record<string, unknown>;
  return !data.withdrawnAt && !["rejected", "withdrawn"].includes(String(data.bucket ?? "").toLowerCase());
}

export async function residentSubjectHasHouse(db: SupabaseClient, userId: string, email: string, ownerId: string, propertyId: string): Promise<boolean> {
  if (!userId || !ownerId || !propertyId) return false;
  const app = await db.from("manager_application_records").select("row_data, property_id, assigned_property_id").eq("manager_user_id", ownerId).eq("row_data->>residentUserId", userId);
  if (app.error) return false;
  if ((app.data ?? []).some((row) => applicationIsLive(row) && applicationPropertyIds(row).includes(propertyId))) return true;
  for (const table of ["portal_household_charge_records", "portal_lease_pipeline_records"]) {
    const result = await db.from(table).select("id").eq("manager_user_id", ownerId).eq("resident_user_id", userId).eq("property_id", propertyId).limit(1);
    if (result.error) continue;
    if ((result.data ?? []).length) return true;
  }
  return false;
}

/**
 * The Auth subject a manager's OWN residency rows already bind to the resident they picked, for one
 * house. Used when a manager files a service for a resident so the row reaches them.
 *
 * The email only SELECTS among that manager's roster; the subject is never derived from it. It comes
 * from a residency the server already proved — an application's bound `row_data.residentUserId`, or a
 * lease's `resident_user_id` — and only under the same manager and the same property. No such
 * residency, or more than one subject, binds nothing: the row stays manager-only.
 */
export async function boundResidentSubjectForManagerHouse(
  db: SupabaseClient,
  params: { managerUserId: string; propertyId: string; residentEmail: string },
): Promise<string | null> {
  const ownerId = params.managerUserId.trim();
  const propertyId = params.propertyId.trim();
  const email = params.residentEmail.trim().toLowerCase();
  if (!ownerId || !propertyId || !email.includes("@")) return null;

  const subjects = new Set<string>();
  const apps = await db
    .from("manager_application_records")
    .select("row_data, property_id, assigned_property_id, resident_email")
    .eq("manager_user_id", ownerId)
    .ilike("resident_email", literalEmail(email));
  if (apps.error) return null;
  for (const row of apps.data ?? []) {
    if (!sameEmail(row.resident_email, email)) continue;
    if (!applicationIsLive(row) || !applicationPropertyIds(row).includes(propertyId)) continue;
    const subject = String((row.row_data as Record<string, unknown> | null)?.residentUserId ?? "").trim();
    if (subject) subjects.add(subject);
  }

  const leases = await db
    .from("portal_lease_pipeline_records")
    .select("resident_user_id, resident_email")
    .eq("manager_user_id", ownerId)
    .eq("property_id", propertyId)
    .ilike("resident_email", literalEmail(email))
    .not("resident_user_id", "is", null);
  if (leases.error) return null;
  for (const row of leases.data ?? []) {
    if (!sameEmail(row.resident_email, email)) continue;
    const subject = String(row.resident_user_id ?? "").trim();
    if (subject) subjects.add(subject);
  }

  return subjects.size === 1 ? [...subjects][0]! : null;
}
