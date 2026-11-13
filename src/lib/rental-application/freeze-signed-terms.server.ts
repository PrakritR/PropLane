import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { assertPropertyInActiveWorkspace } from "@/lib/workspaces/scope.server";
import { applicationPropertyId } from "@/lib/application-property-id";
import { managerCanAccessApplicationRecord } from "@/lib/auth/manager-application-access";
import { hasBothLeaseSignatures } from "@/lib/lease-execution-evidence";
import { openApplicantRow } from "@/lib/security/applicant-identity";
import { signedTermsFromExecutedLease } from "@/lib/signed-lease-document-terms";

type Candidate = { signedMonthlyRent?: unknown; managerRentOverride?: unknown; managerUtilitiesOverride?: unknown; managerSecurityDepositOverride?: unknown; managerMoveInFeeOverride?: unknown };
const money = (value: unknown): number | null => {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^\d+(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
};

/** Patch only missing money terms onto the current application, never a client snapshot. */
export async function freezeSignedTermsForApplication(db: SupabaseClient, userId: string, applicationId: string, leaseId: string, candidate: Candidate) {
  const application = await db.from("manager_application_records").select("id, manager_user_id, resident_email, property_id, assigned_property_id, row_data, updated_at").eq("id", applicationId).maybeSingle();
  if (application.error || !application.data) return { ok: false as const, status: 404, error: "Application not found." };
  const record = application.data;
  const property = applicationPropertyId(record);
  if (!property || !(await assertPropertyInActiveWorkspace(db, userId, property)) || !(await managerCanAccessApplicationRecord(db, userId, { manager_user_id: record.manager_user_id, property_id: property, assigned_property_id: property }, { level: "edit" }))) return { ok: false as const, status: 403, error: "Not authorized to update this application." };
  const leaseResult = await db.from("portal_lease_pipeline_records").select("id, manager_user_id, property_id, row_data").eq("id", leaseId).maybeSingle();
  if (leaseResult.error || !leaseResult.data) return { ok: false as const, status: 404, error: "Signed lease not found." };
  const leaseRecord = leaseResult.data;
  const lease = leaseRecord.row_data as LeasePipelineRow | null;
  const row = record.row_data as DemoApplicantRow | null;
  const leaseAppId = lease?.axisId?.trim();
  const member = lease?.leaseKind === "joint_bundle" && lease.jointLeaseMembers?.some((item) => item.applicationId.trim() === applicationId);
  if (!row || !lease || row.id !== applicationId || (row.managerUserId && row.managerUserId !== record.manager_user_id) || (lease.managerUserId && lease.managerUserId !== leaseRecord.manager_user_id) || (lease.propertyId && lease.propertyId !== leaseRecord.property_id) || !record.manager_user_id || !property || record.manager_user_id !== leaseRecord.manager_user_id || property !== leaseRecord.property_id || (!member && leaseAppId !== applicationId) || lease.status === "Voided" || lease.voidedAt || !hasBothLeaseSignatures(lease)) {
    return { ok: false as const, status: 409, error: "The signed lease no longer matches this application." };
  }
  try { openApplicantRow(row, applicationId); } catch { return { ok: false as const, status: 409, error: "The application cannot be safely read." }; }
  const currentRoom = row.assignedRoomChoice?.trim() || row.application?.roomChoice1?.trim() || "";
  const leaseRoom = lease.roomChoice?.trim() || lease.application?.roomChoice1?.trim() || "";
  if (currentRoom && leaseRoom && currentRoom !== leaseRoom) return { ok: false as const, status: 409, error: "The signed lease no longer matches this application." };
  const parsed = signedTermsFromExecutedLease(lease);
  const app = row.application ? { ...row.application } : undefined;
  const next: DemoApplicantRow = { ...row, ...(app ? { application: app } : {}) };
  const hadRent = Boolean(String(row.application?.managerRentOverride ?? "").trim()) || (Number(row.signedMonthlyRent) > 0);
  const fields = [
    ["managerRentOverride", "monthlyRent"], ["managerUtilitiesOverride", "monthlyUtilities"],
    ["managerSecurityDepositOverride", "securityDeposit"], ["managerMoveInFeeOverride", "moveInFee"],
  ] as const;
  let changed = false;
  for (const [key, docKey] of fields) {
    if (!app || (key === "managerRentOverride" && hadRent) || String(app[key] ?? "").trim() || candidate[key] == null) continue;
    const amount = money(candidate[key]);
    if (amount == null || (parsed[docKey] != null && parsed[docKey] !== amount)) return { ok: false as const, status: 409, error: "The payment terms do not match the signed lease." };
    app[key] = String(amount); changed = true;
  }
  if (!hadRent && next.signedMonthlyRent == null && candidate.signedMonthlyRent != null) {
    const amount = money(candidate.signedMonthlyRent);
    if (amount == null || (parsed.monthlyRent != null && parsed.monthlyRent !== amount)) return { ok: false as const, status: 409, error: "The payment terms do not match the signed lease." };
    next.signedMonthlyRent = amount; changed = true;
  }
  if (changed) {
    let query = db.from("manager_application_records").update({ row_data: next, updated_at: new Date().toISOString() }).eq("id", applicationId).eq("manager_user_id", record.manager_user_id);
    query = record.updated_at == null ? query.is("updated_at", null) : query.eq("updated_at", record.updated_at);
    const saved = await query.select("id");
    if (saved.error || !saved.data?.length) return { ok: false as const, status: 409, error: "Application changed. Refresh and retry." };
  }
  return { ok: true as const, row: { ...openApplicantRow(next, applicationId), id: applicationId, managerUserId: record.manager_user_id } };
}
