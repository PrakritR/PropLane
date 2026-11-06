import "server-only";

import type { ServiceRequest } from "@/lib/service-requests-storage";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { filingPropertyPriority } from "@/lib/resident-filing-scope";
import {
  isApprovedApplicationRow,
  residentHasApprovedResidency,
} from "@/lib/resident-manager-scope";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type ServiceRoleDb = ReturnType<typeof createSupabaseServiceRoleClient>;

type AppRow = {
  resident_email?: string | null;
  property_id?: string | null;
  assigned_property_id?: string | null;
  row_data?: Record<string, unknown> | null;
};

function propertyIdFromApp(row: AppRow): string {
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

/** Prefer approved residencies' property ids for this manager. */
async function residentEmailsAndPropertyForManager(
  db: ServiceRoleDb,
  managerUserId: string,
): Promise<{ byEmail: Map<string, string>; approvedEmails: Set<string> }> {
  const { data, error } = await db
    .from("manager_application_records")
    .select("resident_email, property_id, assigned_property_id, row_data")
    .eq("manager_user_id", managerUserId)
    .limit(500);
  if (error) throw new Error(error.message);

  const byEmail = new Map<string, string>();
  const approvedEmails = new Set<string>();
  for (const row of (data ?? []) as AppRow[]) {
    const email = String(row.resident_email ?? "").trim().toLowerCase();
    if (!email) continue;
    const approved = isApprovedApplicationRow(row);
    const propertyId = propertyIdFromApp(row);
    if (approved) {
      approvedEmails.add(email);
      if (!byEmail.has(email) || propertyId) byEmail.set(email, propertyId || byEmail.get(email) || "");
      continue;
    }
    // Pending only fills in when we don't already have an approved row for them.
    if (!approvedEmails.has(email) && !byEmail.has(email)) {
      byEmail.set(email, propertyId);
    }
  }
  return { byEmail, approvedEmails };
}

function makeApprovedResidencyChecker(db: ServiceRoleDb) {
  const cache = new Map<string, Promise<boolean>>();
  return (residentEmail: string, managerUserId: string): Promise<boolean> => {
    const key = `${residentEmail}|${managerUserId}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = residentHasApprovedResidency(db, { residentEmail, managerUserId }).catch(
        () => false,
      );
      cache.set(key, pending);
    }
    return pending;
  };
}

function makePropertyOwnershipChecker(db: ServiceRoleDb) {
  const cache = new Map<string, Promise<boolean>>();
  return (propertyId: string, managerUserId: string): Promise<boolean> => {
    const key = `${propertyId}|${managerUserId}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = (async () => {
        const { data, error } = await db
          .from("manager_property_records")
          .select("id")
          .eq("id", propertyId)
          .eq("manager_user_id", managerUserId)
          .limit(1);
        if (error) return false;
        return Array.isArray(data) && data.length > 0;
      })().catch(() => false);
      cache.set(key, pending);
    }
    return pending;
  };
}

/** Gate for hot read paths: run a scope repair at most once per TTL per key. */
const SCOPE_REPAIR_TTL_MS = 10 * 60 * 1000;
const scopeRepairLastRun = new Map<string, number>();

export function shouldRunScopeRepair(key: string, ttlMs = SCOPE_REPAIR_TTL_MS): boolean {
  const now = Date.now();
  const last = scopeRepairLastRun.get(key) ?? 0;
  if (now - last < ttlMs) return false;
  scopeRepairLastRun.set(key, now);
  return true;
}

async function shouldReassignToManager(params: {
  residentEmail: string;
  existingManager: string;
  targetManager: string;
  existingProperty: string;
  preferredProperty: string;
  weApproved: boolean;
  checkApproved: (residentEmail: string, managerUserId: string) => Promise<boolean>;
  ownsProperty: (propertyId: string, managerUserId: string) => Promise<boolean>;
}): Promise<boolean> {
  const {
    residentEmail,
    existingManager,
    targetManager,
    existingProperty,
    preferredProperty,
    weApproved,
    checkApproved,
    ownsProperty,
  } = params;
  if (!existingManager || existingManager === targetManager) return true;

  // We only have pending; never steal from another landlord.
  if (!weApproved) return false;

  const theyApproved = await checkApproved(residentEmail, existingManager);
  if (!theyApproved) {
    // The other manager only has a pending relationship — but a row coherently
    // stamped onto a property they actually own (e.g. one they created
    // themselves) is theirs, not a mis-stamp. Only reclaim incoherent rows.
    if (existingProperty && (await ownsProperty(existingProperty, existingManager))) {
      return false;
    }
    return true;
  }
  // When both are approved, reclaim if the row property matches ours (or is empty)
  // and doesn't clearly belong to their property — or when ours is the canonical
  // demo portfolio and theirs is a guided-tour mirror (sandbox dual residency).
  if (!existingProperty) return true;
  if (preferredProperty && existingProperty === preferredProperty) return true;
  if (
    preferredProperty &&
    filingPropertyPriority(preferredProperty) < filingPropertyPriority(existingProperty)
  ) {
    return true;
  }
  return false;
}

function buildNextServiceRequest(
  record: {
    id: string;
    status?: string | null;
    row_data?: unknown;
  },
  email: string,
  managerUserId: string,
  propertyId: string,
): ServiceRequest {
  const rd = (record.row_data ?? {}) as ServiceRequest;
  return {
    ...rd,
    id: String(record.id),
    residentEmail: email,
    managerUserId,
    propertyId: propertyId || rd.propertyId || "",
    status: (record.status as ServiceRequest["status"]) || rd.status || "pending",
    offerId: String(rd.offerId ?? "custom"),
    offerName: String(rd.offerName ?? "Add-on service"),
    offerDescription: String(rd.offerDescription ?? ""),
    price: String(rd.price ?? ""),
    deposit: String(rd.deposit ?? ""),
    residentName: String(rd.residentName ?? email),
    returnByDate: String(rd.returnByDate ?? ""),
    notes: String(rd.notes ?? ""),
    requestedAt: String(rd.requestedAt ?? "") || new Date().toISOString(),
    servicePaid: Boolean(rd.servicePaid),
    depositPaid: Boolean(rd.depositPaid),
  };
}

/**
 * Re-stamp orphaned service requests that belong to this manager's residents but
 * have a missing/wrong `manager_user_id` or empty `property_id` so they appear
 * in the manager Services portal.
 */
export async function repairServiceRequestScopesForManager(
  db: ServiceRoleDb,
  managerUserId: string,
): Promise<{ repaired: number }> {
  const mid = managerUserId.trim();
  if (!mid) return { repaired: 0 };

  const { byEmail: residents, approvedEmails } = await residentEmailsAndPropertyForManager(db, mid);
  const emails = [...residents.keys()];
  if (emails.length === 0) return { repaired: 0 };

  const checkApproved = makeApprovedResidencyChecker(db);
  const ownsProperty = makePropertyOwnershipChecker(db);

  const { data: rows, error } = await db
    .from("portal_service_request_records")
    .select("id, manager_user_id, resident_user_id, resident_email, property_id, status, row_data, row_revision")
    .in("resident_email", emails)
    .limit(500);
  if (error) throw new Error(error.message);

  let repaired = 0;
  for (const record of rows ?? []) {
    if (record.resident_user_id) continue;
    const email = String(record.resident_email ?? "").trim().toLowerCase();
    if (!email) continue;
    const existingManager = String(record.manager_user_id ?? "").trim();
    if (existingManager !== mid) continue;
    const preferredProperty = residents.get(email) || "";
    const existingProperty = String(record.property_id ?? "").trim();
    const weApproved = approvedEmails.has(email);

    const mayReassign = await shouldReassignToManager({
      residentEmail: email,
      existingManager,
      targetManager: mid,
      existingProperty,
      preferredProperty,
      weApproved,
      checkApproved,
      ownsProperty,
    });
    if (!mayReassign) continue;

    // Prefer the approved residency property when reclaiming or filling blanks /
    // fixing property mis-stamps onto a non-approved property for us.
    let nextProperty = existingProperty;
    if (weApproved && preferredProperty) {
      if (!existingProperty || existingManager !== mid || existingProperty !== preferredProperty) {
        // When reclaiming from another manager, always use our approved property.
        if (existingManager !== mid) nextProperty = preferredProperty;
        else if (!existingProperty) nextProperty = preferredProperty;
      }
    } else if (!nextProperty && preferredProperty) {
      nextProperty = preferredProperty;
    }

    const needsManager = existingManager !== mid;
    const needsProperty = existingProperty !== nextProperty;
    const rd = (record.row_data ?? {}) as ServiceRequest;
    if (!needsManager && !needsProperty && rd.managerUserId === mid && rd.propertyId === nextProperty) {
      continue;
    }

    const nextRow = buildNextServiceRequest(record, email, mid, nextProperty);
    const { data: updatedRows, error: upsertError } = await db.from("portal_service_request_records").update(
      {
        id: nextRow.id,
        manager_user_id: mid,
        resident_email: email,
        property_id: nextRow.propertyId || null,
        status: nextRow.status || null,
        row_data: nextRow,
        updated_at: new Date().toISOString(),
      },
    ).eq("id", nextRow.id).eq("manager_user_id", mid).eq("row_revision", record.row_revision).is("resident_user_id", null).select("id");
    if (!upsertError && updatedRows?.length) repaired += 1;
  }

  return { repaired };
}

/**
 * Same orphan re-stamp for work orders owned by this manager's residents.
 */
export async function repairWorkOrderScopesForManager(
  db: ServiceRoleDb,
  managerUserId: string,
): Promise<{ repaired: number }> {
  const mid = managerUserId.trim();
  if (!mid) return { repaired: 0 };

  const { byEmail: residents, approvedEmails } = await residentEmailsAndPropertyForManager(db, mid);
  const emails = [...residents.keys()];
  if (emails.length === 0) return { repaired: 0 };

  const checkApproved = makeApprovedResidencyChecker(db);
  const ownsProperty = makePropertyOwnershipChecker(db);

  const { data: rows, error } = await db
    .from("portal_work_order_records")
    .select("id, manager_user_id, resident_user_id, resident_email, property_id, assigned_property_id, row_data, row_revision")
    .in("resident_email", emails)
    .limit(500);
  if (error) throw new Error(error.message);

  let repaired = 0;
  for (const record of rows ?? []) {
    if (record.resident_user_id) continue;
    const email = String(record.resident_email ?? "").trim().toLowerCase();
    if (!email) continue;
    const existingManager = String(record.manager_user_id ?? "").trim();
    if (existingManager !== mid) continue;
    const preferredProperty = residents.get(email) || "";
    const existingProperty =
      String(record.property_id ?? "").trim() ||
      String(record.assigned_property_id ?? "").trim();
    const weApproved = approvedEmails.has(email);

    const mayReassign = await shouldReassignToManager({
      residentEmail: email,
      existingManager,
      targetManager: mid,
      existingProperty,
      preferredProperty,
      weApproved,
      checkApproved,
      ownsProperty,
    });
    if (!mayReassign) continue;

    let nextProperty = existingProperty;
    if (weApproved && preferredProperty && existingManager !== mid) {
      nextProperty = preferredProperty;
    } else if (!nextProperty && preferredProperty) {
      nextProperty = preferredProperty;
    }

    const rd = (record.row_data ?? {}) as DemoManagerWorkOrderRow;
    if (
      existingManager === mid &&
      rd.managerUserId === mid &&
      (existingProperty || !preferredProperty) &&
      existingProperty === nextProperty
    ) {
      continue;
    }

    const nextRow: DemoManagerWorkOrderRow = {
      ...rd,
      id: String(record.id),
      managerUserId: mid,
      residentEmail: email,
      propertyId: nextProperty || rd.propertyId,
      assignedPropertyId: rd.assignedPropertyId || nextProperty || undefined,
    };

    const { data: updatedRows, error: upsertError } = await db.from("portal_work_order_records").update(
      {
        id: nextRow.id,
        manager_user_id: mid,
        resident_email: email,
        property_id: nextRow.propertyId || null,
        assigned_property_id: nextRow.assignedPropertyId || null,
        row_data: nextRow,
        updated_at: new Date().toISOString(),
      },
    ).eq("id", nextRow.id).eq("manager_user_id", mid).eq("row_revision", record.row_revision).is("resident_user_id", null).select("id");
    if (!upsertError && updatedRows?.length) repaired += 1;
  }

  return { repaired };
}

/** Global admin sweep — optional single-manager scope. */
export async function repairServiceScopesAllManagers(
  db: ServiceRoleDb,
  managerUserId?: string | null,
): Promise<{ managers: number; serviceRequests: number; workOrders: number }> {
  const scoped = managerUserId?.trim();
  let managerIds: string[] = [];
  if (scoped) {
    managerIds = [scoped];
  } else {
    const { data, error } = await db
      .from("manager_application_records")
      .select("manager_user_id")
      .limit(2000);
    if (error) throw new Error(error.message);
    managerIds = [
      ...new Set(
        (data ?? [])
          .map((r) => String((r as { manager_user_id?: string }).manager_user_id ?? "").trim())
          .filter(Boolean),
      ),
    ];
  }

  let serviceRequests = 0;
  let workOrders = 0;
  for (const mid of managerIds) {
    const sr = await repairServiceRequestScopesForManager(db, mid);
    const wo = await repairWorkOrderScopesForManager(db, mid);
    serviceRequests += sr.repaired;
    workOrders += wo.repaired;
  }
  return { managers: managerIds.length, serviceRequests, workOrders };
}
