import "server-only";

import type { DemoApplicantRow, DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { managerOwnedPropertyIdSet } from "@/lib/auth/manager-application-access";
import {
  fetchRowsForManagerWithLinked,
  linkedPropertyIdsForModule,
} from "@/lib/auth/co-manager-module-scope";
import { fetchLeasesForManagerUser } from "@/lib/auth/manager-lease-scope";
import type { HouseholdCharge } from "@/lib/household-charges";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import {
  scopeChargesToManagerPaymentsLedger,
  unpaidManagerPaymentCharges,
} from "@/lib/manager-payments-scope";
import { notifyManagerFromAgent } from "@/lib/agent-notify.server";
import type { ManagerAttentionDigestCadence } from "@/lib/manager-notification-preferences";
import { traceSystemNotification } from "@/lib/observability/langfuse";
import { isSubmittedPendingApplicationRow } from "@/lib/rental-application/in-progress-application";
import type { ServiceRequest } from "@/lib/service-requests-storage";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type ServiceDb = ReturnType<typeof createSupabaseServiceRoleClient>;

type StoredRow = {
  id: string;
  row_data: unknown;
  manager_user_id?: string | null;
  property_id?: string | null;
  assigned_property_id?: string | null;
};

export type ManagerAttentionSummary = {
  unpaidCharges: number;
  openWorkOrders: number;
  pendingServiceRequests: number;
  pendingApplications: number;
  unsignedLeases: number;
  total: number;
};

function scopedRowData<T>(record: StoredRow): T {
  const data = record.row_data && typeof record.row_data === "object"
    ? (record.row_data as Record<string, unknown>)
    : {};
  return {
    ...data,
    id: String(data.id ?? record.id),
    managerUserId: data.managerUserId ?? record.manager_user_id ?? null,
    propertyId: data.propertyId ?? record.property_id ?? undefined,
    assignedPropertyId: data.assignedPropertyId ?? record.assigned_property_id ?? undefined,
  } as unknown as T;
}

/** Server-side twin of the manager dashboard's four attention domains. */
export async function loadManagerAttentionSummary(
  db: ServiceDb,
  managerUserId: string,
): Promise<ManagerAttentionSummary> {
  const [ownedPropertyIds, applicationIds, residentIds, paymentIds, serviceIds] = await Promise.all([
    managerOwnedPropertyIdSet(db, managerUserId),
    linkedPropertyIdsForModule(db, managerUserId, "applications"),
    linkedPropertyIdsForModule(db, managerUserId, "residents"),
    linkedPropertyIdsForModule(db, managerUserId, "payments"),
    linkedPropertyIdsForModule(db, managerUserId, "services"),
  ]);
  const applicationPropertyIds = new Set([
    ...ownedPropertyIds,
    ...applicationIds,
    ...residentIds,
  ]);

  const [applicationRecords, chargeRecords, workOrderRecords, serviceRequestRecords, leaseRecords] =
    await Promise.all([
      fetchRowsForManagerWithLinked<StoredRow>(
        db,
        "manager_application_records",
        managerUserId,
        applicationPropertyIds,
        {
          select: "id,row_data,manager_user_id,property_id,assigned_property_id,updated_at",
          propertyColumns: ["property_id", "assigned_property_id"],
        },
      ),
      fetchRowsForManagerWithLinked<StoredRow>(
        db,
        "portal_household_charge_records",
        managerUserId,
        paymentIds,
        { select: "id,row_data,manager_user_id,property_id,updated_at", propertyColumns: ["property_id"], limit: 2000 },
      ),
      fetchRowsForManagerWithLinked<StoredRow>(
        db,
        "portal_work_order_records",
        managerUserId,
        serviceIds,
        {
          select: "id,row_data,manager_user_id,property_id,assigned_property_id,updated_at",
          propertyColumns: ["property_id", "assigned_property_id"],
        },
      ),
      fetchRowsForManagerWithLinked<StoredRow>(
        db,
        "portal_service_request_records",
        managerUserId,
        serviceIds,
        { select: "id,row_data,manager_user_id,property_id,updated_at", propertyColumns: ["property_id"] },
      ),
      fetchLeasesForManagerUser(db, managerUserId),
    ]);

  const applications = applicationRecords.map((row) => scopedRowData<DemoApplicantRow>(row));
  const charges = chargeRecords.map((row) => scopedRowData<HouseholdCharge>(row));
  const scopedCharges = scopeChargesToManagerPaymentsLedger(charges, applications);
  const workOrders = workOrderRecords.map((row) => scopedRowData<DemoManagerWorkOrderRow>(row));
  const serviceRequests = serviceRequestRecords.map((row) => scopedRowData<ServiceRequest>(row));
  const leases = leaseRecords.map((record) => scopedRowData<LeasePipelineRow>(record as StoredRow));

  const counts = {
    unpaidCharges: unpaidManagerPaymentCharges(scopedCharges).length,
    openWorkOrders: workOrders.filter((row) => row.bucket === "open" || row.bucket === "scheduled").length,
    pendingServiceRequests: serviceRequests.filter((row) => row.status === "pending").length,
    pendingApplications: applications.filter(isSubmittedPendingApplicationRow).length,
    unsignedLeases: leases.filter(
      (row) => row.status === "Manager Signature Pending" || row.status === "Resident Signature Pending",
    ).length,
  };
  return { ...counts, total: Object.values(counts).reduce((sum, count) => sum + count, 0) };
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function renderManagerAttentionDigest(summary: ManagerAttentionSummary, portalUrl: string): string {
  return [
    [
      countLabel(summary.unpaidCharges, "unpaid charge"),
      countLabel(summary.openWorkOrders, "open work order"),
      countLabel(summary.pendingServiceRequests, "pending service request"),
      countLabel(summary.pendingApplications, "pending application"),
      countLabel(summary.unsignedLeases, "unsigned lease"),
    ].join(" · "),
    `Open PropLane: ${portalUrl}`,
  ].join("\n");
}

export function managerAttentionDigestDue(cadence: ManagerAttentionDigestCadence, now: Date): boolean {
  if (cadence === "daily") return true;
  return cadence === "weekly" && now.getUTCDay() === 1;
}

export function managerAttentionDigestPeriodKey(
  cadence: Exclude<ManagerAttentionDigestCadence, "off">,
  now: Date,
): string {
  if (cadence === "daily") return now.toISOString().slice(0, 10);
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const offset = (monday.getUTCDay() + 6) % 7;
  monday.setUTCDate(monday.getUTCDate() - offset);
  return `week-${monday.toISOString().slice(0, 10)}`;
}

export async function deliverManagerAttentionDigest(input: {
  db: ServiceDb;
  managerUserId: string;
  cadence: Exclude<ManagerAttentionDigestCadence, "off">;
  portalUrl: string;
  now: Date;
}): Promise<{ sent: boolean; reason?: "empty" | "suppressed"; summary: ManagerAttentionSummary }> {
  const summary = await loadManagerAttentionSummary(input.db, input.managerUserId);
  if (summary.total === 0) return { sent: false, reason: "empty", summary };
  const periodKey = managerAttentionDigestPeriodKey(input.cadence, input.now);
  const delivery = await traceSystemNotification({
    domain: "manager_attention_digest",
    managerUserId: input.managerUserId,
    entityId: periodKey,
    cadence: input.cadence,
    run: () =>
      notifyManagerFromAgent(input.db, {
        landlordId: input.managerUserId,
        subject: "PropLane needs-attention digest",
        text: renderManagerAttentionDigest(summary, input.portalUrl),
        externalText: renderManagerAttentionDigest(summary, input.portalUrl),
        category: "attention_digest",
        url: "/portal",
        idempotencyKey: `manager-attention-digest:${periodKey}`,
      }),
    summarize: (result) => ({
      ok: result.delivered,
      suppressed: result.suppressed,
      cadence: input.cadence,
      counts: summary,
    }),
  });
  return {
    sent: delivery.delivered,
    ...(delivery.suppressed ? { reason: "suppressed" as const } : {}),
    summary,
  };
}
