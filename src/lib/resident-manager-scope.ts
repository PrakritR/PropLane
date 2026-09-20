import { isWithdrawnApplicationRow } from "@/lib/rental-application/resident-application-list";
import { pickPrimaryFilingScope } from "@/lib/resident-filing-scope";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type ServiceRoleDb = ReturnType<typeof createSupabaseServiceRoleClient>;

/**
 * Authoritative per-landlord check for resident-originated portal writes.
 *
 * A resident may only write a record (service request, work order, ...) into a
 * manager's queue if that manager actually has the resident on a residency
 * record. Residents are approved/managed applicants, so the source of truth for
 * "which manager owns this resident" is `manager_application_records`, keyed by
 * the lowercased `resident_email` and `manager_user_id`. We deliberately do NOT
 * accept property ownership as a substitute signal: a manager's `live` listings
 * are publicly selectable, so any resident could discover an unrelated manager's
 * property id and inject a row into that manager's queue.
 */
/**
 * Manager user ids that own the given resident: approved application records
 * plus any charge/lease records keyed by the resident's email. This is the
 * authoritative "who are my managers" resolver, shared by the inbox recipient
 * scope and the resident agent context.
 */
export async function managerIdsOwningResident(
  db: ServiceRoleDb,
  residentEmail: string,
): Promise<string[]> {
  const email = residentEmail.trim().toLowerCase();
  if (!email) return [];
  const ids = new Set<string>();

  const { data: apps } = await db
    .from("manager_application_records")
    .select("manager_user_id, row_data")
    .eq("resident_email", email);
  for (const row of apps ?? []) {
    if (!applicationRowLinksResident(row.row_data)) continue;
    const id = String(row.manager_user_id ?? "").trim();
    if (id) ids.add(id);
  }

  for (const table of ["portal_household_charge_records", "portal_lease_pipeline_records"] as const) {
    const { data } = await db.from(table).select("manager_user_id").eq("resident_email", email);
    for (const row of data ?? []) {
      const id = String(row.manager_user_id ?? "").trim();
      if (id) ids.add(id);
    }
  }

  return [...ids];
}

export async function residentBelongsToManager(
  db: ServiceRoleDb,
  params: { residentEmail: string; managerUserId: string },
): Promise<boolean> {
  const residentEmail = params.residentEmail.trim().toLowerCase();
  const managerUserId = params.managerUserId.trim();
  if (!residentEmail || !managerUserId) return false;

  const { data, error } = await db
    .from("manager_application_records")
    .select("id")
    .eq("manager_user_id", managerUserId)
    .eq("resident_email", residentEmail)
    .limit(1);
  if (error) throw new Error(error.message);
  return Array.isArray(data) && data.length > 0;
}

type ApplicationScopeRow = {
  manager_user_id: string | null;
  property_id: string | null;
  assigned_property_id?: string | null;
  row_data?: Record<string, unknown> | null;
  updated_at?: string | null;
};

export function applicationBucket(rowData: unknown): string {
  if (!rowData || typeof rowData !== "object" || Array.isArray(rowData)) return "";
  return String((rowData as { bucket?: string }).bucket ?? "").trim().toLowerCase();
}

function applicationLinksResidentToManager(bucket: string): boolean {
  return bucket !== "rejected" && bucket !== "withdrawn";
}

/**
 * Whether an application record still links the resident to the manager —
 * the ONE "which applications count" rule, shared by the messaging scope
 * above and the resident contact card (`resident-manager-contact.server.ts`),
 * so the two cannot drift.
 *
 * Withdrawal is checked separately from `bucket`: a resident withdrawal
 * (`PATCH /api/manager-applications`) stamps only `row_data.withdrawnAt` and
 * never rewrites `bucket` away from "pending", so a withdrawn row must be
 * excluded here even though `applicationLinksResidentToManager` alone would
 * still call it linked.
 */
export function applicationRowLinksResident(rowData: unknown): boolean {
  if (!rowData || typeof rowData !== "object" || Array.isArray(rowData)) return false;
  const record = rowData as Record<string, unknown>;
  if (isWithdrawnApplicationRow({ withdrawnAt: record.withdrawnAt as string | null | undefined })) return false;
  return applicationLinksResidentToManager(applicationBucket(record));
}

export function isApprovedApplicationRow(row: { row_data?: unknown }): boolean {
  return applicationBucket(row.row_data) === "approved";
}

export async function residentHasApprovedResidency(
  db: ServiceRoleDb,
  params: { residentEmail: string; managerUserId: string },
): Promise<boolean> {
  const residentEmail = params.residentEmail.trim().toLowerCase();
  const managerUserId = params.managerUserId.trim();
  if (!residentEmail || !managerUserId) return false;

  const { data, error } = await db
    .from("manager_application_records")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .eq("resident_email", residentEmail)
    .limit(25);
  if (error) throw new Error(error.message);
  return (data ?? []).some((row) => isApprovedApplicationRow(row));
}

function propertyIdFromApplication(row: ApplicationScopeRow): string {
  const fromCols =
    String(row.assigned_property_id ?? "").trim() || String(row.property_id ?? "").trim();
  if (fromCols) return fromCols;
  const rd = row.row_data ?? {};
  return (
    String(rd.assignedPropertyId ?? "").trim() ||
    String(rd.propertyId ?? "").trim() ||
    String((rd.application as { propertyId?: string } | undefined)?.propertyId ?? "").trim()
  );
}

/**
 * Prefer approved residencies over pending apps when stamping filings.
 * Test residents often have leftover pending apps at other managers/properties —
 * using the newest row blindly routes service requests into the wrong queue.
 */
function preferApprovedThenRecent(rows: ApplicationScopeRow[]): ApplicationScopeRow[] {
  const approved = rows.filter(isApprovedApplicationRow);
  return approved.length > 0 ? approved : rows;
}

/**
 * Resolve which manager + property a resident filing should be stamped with.
 * Prefer approved residencies; within that set, prefer the canonical demo
 * portfolio over guided-tour mirrors, and honor client claims only when they
 * land in that top tier. Pending leftover apps never win over an approved lease.
 */
export async function resolveResidentFilingScope(
  db: ServiceRoleDb,
  params: {
    residentEmail: string;
    claimedManagerUserId?: string | null;
    claimedPropertyId?: string | null;
  },
): Promise<{ managerUserId: string; propertyId: string } | null> {
  const residentEmail = params.residentEmail.trim().toLowerCase();
  if (!residentEmail) return null;

  const { data, error } = await db
    .from("manager_application_records")
    .select("manager_user_id, property_id, assigned_property_id, row_data, updated_at")
    .eq("resident_email", residentEmail)
    .order("updated_at", { ascending: false })
    .limit(25);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as ApplicationScopeRow[];
  if (rows.length === 0) return null;

  const claimedManager = params.claimedManagerUserId?.trim() || "";
  const claimedProperty = params.claimedPropertyId?.trim() || "";

  const preferred = preferApprovedThenRecent(rows);
  const candidates = preferred
    .map((r) => {
      const managerUserId = String(r.manager_user_id ?? "").trim();
      const propertyId = propertyIdFromApplication(r);
      if (!managerUserId) return null;
      return {
        managerUserId,
        propertyId,
        approved: isApprovedApplicationRow(r),
        updatedAt: r.updated_at ?? null,
      };
    })
    .filter((c): c is NonNullable<typeof c> => Boolean(c));

  const chosen = pickPrimaryFilingScope(candidates, {
    managerUserId: claimedManager,
    propertyId: claimedProperty,
  });
  if (!chosen) return null;
  const managerUserId = chosen.managerUserId;
  const propertyId = chosen.propertyId || claimedProperty;
  return { managerUserId, propertyId };
}
