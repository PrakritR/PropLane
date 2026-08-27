import "server-only";

import { isAdminUser } from "@/lib/auth/admin-preview";
import {
  managerCanAccessApplicationRecord,
  type ApplicationAccessRecord,
} from "@/lib/auth/manager-application-access";
import { managerCanAccessLeaseRecord } from "@/lib/auth/manager-lease-scope";
import { applicationIdVariants } from "@/lib/portal-record-share-payload.server";
import type { PortalRecordShareKind } from "@/lib/portal-record-share-links.server";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type ServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

const RECORD_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export function isValidPortalRecordShareId(recordId: string): boolean {
  return RECORD_ID_PATTERN.test(recordId.trim());
}

async function propertyOwnerUserId(db: ServiceClient, propertyIds: string[]): Promise<string | null> {
  const ids = [...new Set(propertyIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return null;
  const { data, error } = await db
    .from("manager_property_records")
    .select("manager_user_id")
    .in("id", ids)
    .not("manager_user_id", "is", null)
    .limit(1);
  if (error || !data?.[0]?.manager_user_id) return null;
  return String(data[0].manager_user_id);
}

/** Portfolio owner for share-link storage and public payload scoping. */
export async function resolveApplicationRecordOwnerUserId(
  db: ServiceClient,
  record: ApplicationAccessRecord,
): Promise<string | null> {
  const stamped = String(record.manager_user_id ?? "").trim();
  if (stamped) return stamped;
  return propertyOwnerUserId(db, [
    String(record.property_id ?? ""),
    String(record.assigned_property_id ?? ""),
  ]);
}

export async function resolveLeaseRecordOwnerUserId(
  db: ServiceClient,
  record: { manager_user_id?: string | null; property_id?: string | null },
): Promise<string | null> {
  const stamped = String(record.manager_user_id ?? "").trim();
  if (stamped) return stamped;
  const propertyId = String(record.property_id ?? "").trim();
  if (!propertyId) return null;
  return propertyOwnerUserId(db, [propertyId]);
}

export type AuthorizedPortalRecordShare =
  | {
      ok: true;
      canonicalRecordId: string;
      recordOwnerUserId: string;
      recordTitle: string;
    }
  | { ok: false; status: number; error: string };

export async function authorizePortalRecordShare(
  db: ServiceClient,
  userId: string,
  kind: PortalRecordShareKind,
  recordId: string,
  level: "read" | "edit",
): Promise<AuthorizedPortalRecordShare> {
  const trimmed = recordId.trim();
  if (!isValidPortalRecordShareId(trimmed)) {
    return { ok: false, status: 400, error: "kind and recordId are required." };
  }

  const admin = await isAdminUser(userId);

  if (kind === "lease") {
    const { data: record } = await db
      .from("portal_lease_pipeline_records")
      .select("id, manager_user_id, property_id, row_data")
      .eq("id", trimmed)
      .maybeSingle();
    if (!record) return { ok: false, status: 404, error: "Lease not found." };

    const allowed = admin || (await managerCanAccessLeaseRecord(db, userId, record, level));
    if (!allowed) return { ok: false, status: 403, error: "Not authorized." };

    const recordOwnerUserId = await resolveLeaseRecordOwnerUserId(db, record);
    if (!recordOwnerUserId) {
      return { ok: false, status: 400, error: "Could not resolve lease owner for this link." };
    }

    const rowData = record.row_data as { residentName?: string; unit?: string; propertyId?: string } | null;
    const recordTitle =
      rowData?.residentName?.trim() || rowData?.unit?.trim() || rowData?.propertyId?.trim() || "Lease";

    return {
      ok: true,
      canonicalRecordId: String(record.id),
      recordOwnerUserId,
      recordTitle,
    };
  }

  const ids = applicationIdVariants(trimmed);
  if (ids.length === 0) return { ok: false, status: 404, error: "Application not found." };

  const { data: records } = await db
    .from("manager_application_records")
    .select("id, manager_user_id, property_id, assigned_property_id, row_data")
    .in("id", ids);
  const record =
    records?.find((row) => row.id === trimmed) ??
    records?.sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
  if (!record) return { ok: false, status: 404, error: "Application not found." };

  const allowed =
    admin || (await managerCanAccessApplicationRecord(db, userId, record, { level }));
  if (!allowed) return { ok: false, status: 403, error: "Not authorized." };

  const recordOwnerUserId = await resolveApplicationRecordOwnerUserId(db, record);
  if (!recordOwnerUserId) {
    return { ok: false, status: 400, error: "Could not resolve application owner for this link." };
  }

  const rowData = record.row_data as { name?: string; property?: string; application?: { fullLegalName?: string } } | null;
  const recordTitle =
    rowData?.name?.trim() ||
    rowData?.application?.fullLegalName?.trim() ||
    rowData?.property?.trim() ||
    "Application";

  return {
    ok: true,
    canonicalRecordId: String(record.id),
    recordOwnerUserId,
    recordTitle,
  };
}
