import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptSensitiveValue, encryptSensitiveValue, type EncryptionContext } from "@/lib/security/data-encryption";
import { getRentReportingPartner } from "@/lib/rent-reporting/partner";

export type RentReportingStatus = "active" | "paused" | "stopped";

export type RentReportingEnrollment = {
  id: string;
  residentUserId: string;
  managerUserId: string;
  propertyId: string | null;
  leaseId: string | null;
  status: RentReportingStatus;
  consentedAt: string | null;
  stoppedAt: string | null;
  partnerSubjectId: string | null;
};

const SELECT_COLUMNS =
  "id, resident_user_id, manager_user_id, property_id, lease_id, status, consented_at, stopped_at, partner_subject_id";

function rowToEnrollment(row: Record<string, unknown>): RentReportingEnrollment {
  return {
    id: String(row.id),
    residentUserId: String(row.resident_user_id),
    managerUserId: String(row.manager_user_id),
    propertyId: (row.property_id as string | null) ?? null,
    leaseId: (row.lease_id as string | null) ?? null,
    status: (row.status as RentReportingStatus) ?? "active",
    consentedAt: (row.consented_at as string | null) ?? null,
    stoppedAt: (row.stopped_at as string | null) ?? null,
    partnerSubjectId: (row.partner_subject_id as string | null) ?? null,
  };
}

/** Binds legal name / DOB ciphertext to the exact row and manager so one row's key can never open another's. */
function identityContext(recordId: string, managerUserId: string, field: "legal_name" | "dob"): EncryptionContext {
  return { purpose: "rent-reporting-consent", ownerId: managerUserId, recordId, field };
}

/** Every currently-active enrollment, across every manager — the monthly cron's input set. */
export async function loadActiveRentReportingEnrollments(db: SupabaseClient): Promise<RentReportingEnrollment[]> {
  const { data, error } = await db.from("resident_rent_reporting").select(SELECT_COLUMNS).eq("status", "active");
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => rowToEnrollment(row as Record<string, unknown>));
}

export async function loadRentReportingEnrollment(
  db: SupabaseClient,
  residentUserId: string,
  propertyId: string,
): Promise<RentReportingEnrollment | null> {
  if (!residentUserId.trim() || !propertyId.trim()) return null;
  const { data, error } = await db
    .from("resident_rent_reporting")
    .select(SELECT_COLUMNS)
    .eq("resident_user_id", residentUserId)
    .eq("property_id", propertyId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? rowToEnrollment(data as Record<string, unknown>) : null;
}

/** Decrypts the stored legal name for display ("Reported as"); returns null on any failure rather than 500ing a read. */
export async function openRentReportingLegalName(
  db: SupabaseClient,
  enrollment: Pick<RentReportingEnrollment, "id" | "managerUserId">,
): Promise<string | null> {
  const { data, error } = await db
    .from("resident_rent_reporting")
    .select("legal_name_encrypted")
    .eq("id", enrollment.id)
    .maybeSingle();
  if (error || !data?.legal_name_encrypted) return null;
  try {
    return decryptSensitiveValue(
      data.legal_name_encrypted as string,
      identityContext(enrollment.id, enrollment.managerUserId, "legal_name"),
    );
  } catch {
    return null;
  }
}

export type StartRentReportingInput = {
  residentUserId: string;
  managerUserId: string;
  propertyId: string;
  propertyLabel?: string;
  leaseId?: string | null;
  legalName: string;
  dob: string;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Turn rent reporting on. Encrypts legal name + DOB at rest, enrolls with the partner
 * (the stub records what would be sent) once per resident+property, and (re)activates
 * the row — reactivating a previously stopped enrollment reuses the same row id so its
 * submission history stays attached.
 */
export async function startRentReportingConsent(
  db: SupabaseClient,
  input: StartRentReportingInput,
): Promise<RentReportingEnrollment> {
  const residentUserId = input.residentUserId.trim();
  const managerUserId = input.managerUserId.trim();
  const propertyId = input.propertyId.trim();
  const legalName = input.legalName.trim();
  const dob = input.dob.trim();
  if (!residentUserId || !managerUserId || !propertyId) throw new Error("Missing resident, manager, or property.");
  if (!legalName) throw new Error("Legal name on your credit file is required.");
  if (!ISO_DATE.test(dob)) throw new Error("Date of birth is required.");

  const { data: existing, error: existingError } = await db
    .from("resident_rent_reporting")
    .select("id, partner_subject_id")
    .eq("resident_user_id", residentUserId)
    .eq("property_id", propertyId)
    .maybeSingle();
  if (existingError) throw new Error(existingError.message);

  const recordId = (existing?.id as string | undefined) ?? randomUUID();
  const legalNameEncrypted = encryptSensitiveValue(legalName, identityContext(recordId, managerUserId, "legal_name"));
  const dobEncrypted = encryptSensitiveValue(dob, identityContext(recordId, managerUserId, "dob"));

  let partnerSubjectId = (existing?.partner_subject_id as string | null) ?? null;
  if (!partnerSubjectId) {
    const enrolled = await getRentReportingPartner().enroll({
      reportingId: recordId,
      legalName,
      dob,
      propertyLabel: input.propertyLabel,
    });
    partnerSubjectId = enrolled.partnerSubjectId;
  }

  const now = new Date().toISOString();
  const { data, error } = await db
    .from("resident_rent_reporting")
    .upsert(
      {
        id: recordId,
        resident_user_id: residentUserId,
        manager_user_id: managerUserId,
        property_id: propertyId,
        lease_id: input.leaseId ?? null,
        status: "active",
        consented_at: now,
        stopped_at: null,
        legal_name_encrypted: legalNameEncrypted,
        dob_encrypted: dobEncrypted,
        partner_subject_id: partnerSubjectId,
        updated_at: now,
      },
      { onConflict: "id" },
    )
    .select(SELECT_COLUMNS)
    .maybeSingle();
  if (error || !data) throw new Error(error?.message ?? "Could not start rent reporting.");
  return rowToEnrollment(data as Record<string, unknown>);
}

/**
 * Turn rent reporting off. Reporting stops the NEXT cycle: this only marks the row
 * `stopped` so the monthly export skips it going forward, and never deletes or
 * retroactively withdraws submissions already sent.
 */
export async function stopRentReportingConsent(
  db: SupabaseClient,
  input: { residentUserId: string; propertyId: string },
): Promise<RentReportingEnrollment> {
  const existing = await loadRentReportingEnrollment(db, input.residentUserId, input.propertyId);
  if (!existing) throw new Error("Not enrolled in rent reporting.");
  if (existing.partnerSubjectId) {
    await getRentReportingPartner().stop(existing.partnerSubjectId);
  }
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("resident_rent_reporting")
    .update({ status: "stopped", stopped_at: now, updated_at: now })
    .eq("id", existing.id)
    .select(SELECT_COLUMNS)
    .maybeSingle();
  if (error || !data) throw new Error(error?.message ?? "Could not stop rent reporting.");
  return rowToEnrollment(data as Record<string, unknown>);
}
