import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { manualResidentSignedLeasePdf } from "@/lib/existing-resident-onboarding";
import {
  deliverExistingResidentWelcome,
  RESIDENT_WELCOME_EMAIL_RE,
  type ResidentWelcomeActor,
} from "@/lib/resident-welcome.server";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { normalizeLeasePipelineRow } from "@/lib/lease-pipeline-storage";

function asUuidOrNull(value: unknown): string | null {
  const v = typeof value === "string" ? value.trim() : "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : null;
}

function buildLeaseUpsert(row: Record<string, unknown>) {
  return {
    id: row.id,
    manager_user_id: row.managerUserId ?? row.manager_user_id ?? null,
    resident_user_id: asUuidOrNull(row.residentUserId ?? row.resident_user_id),
    resident_email: row.residentEmail ?? row.resident_email ?? null,
    property_id: row.propertyId ?? row.property_id ?? null,
    status: row.bucket ?? row.status ?? null,
    row_data: row,
    updated_at: new Date().toISOString(),
  };
}

export type ExistingResidentOnboardingResult =
  | {
      ok: true;
      leaseId: string;
      welcomeEmailSent: boolean;
      axisId: string;
      row: DemoApplicantRow;
    }
  | { ok: false; status: number; error: string; mailtoHref?: string; leaseId?: string };

export async function runExistingResidentOnboarding(
  db: SupabaseClient,
  actor: ResidentWelcomeActor & { managerName?: string },
  row: DemoApplicantRow,
  opts?: { sendWelcomeEmail?: boolean },
): Promise<ExistingResidentOnboardingResult> {
  if (!row.manuallyAdded) {
    return { ok: false, status: 400, error: "Not a manager-added existing resident." };
  }

  const email = row.email?.trim().toLowerCase() ?? "";
  if (!email || !RESIDENT_WELCOME_EMAIL_RE.test(email)) {
    return { ok: false, status: 400, error: "A valid resident email is required on the record." };
  }

  const sendWelcomeEmail = opts?.sendWelcomeEmail !== false;
  const iso = new Date().toISOString();
  const residentName = row.name?.trim() || "Resident";
  const managerName = actor.managerName?.trim() || "Property Manager";
  const propertyId = row.assignedPropertyId?.trim() || row.propertyId?.trim() || "";
  const axisId = normalizeApplicationAxisId(row.id);
  const leaseId = `lease_app_${axisId}`;
  const manualPdf = manualResidentSignedLeasePdf(row);

  const leaseRow = manualPdf
    ? normalizeLeasePipelineRow({
        id: leaseId,
        residentName,
        residentEmail: email,
        unit: row.property?.trim() || "—",
        updated: iso,
        bucket: "signed",
        pdfVersion: 1,
        notes: "Existing resident — lease executed off-platform.",
        updatedAtIso: iso,
        axisId: row.id,
        propertyId: propertyId || undefined,
        managerUserId: actor.userId,
        managerUploadedPdf: manualPdf,
        managerSignature: { role: "manager", name: managerName, signedAtIso: iso },
        residentSignature: { role: "resident", name: residentName, signedAtIso: iso },
        signatureName: residentName,
        signedAtIso: iso,
        sentToResidentAt: iso,
        fullySignedAt: iso,
        residentSignedAt: iso,
        managerSignedAt: iso,
        externallySignedLease: true,
        thread: [],
      })
    : normalizeLeasePipelineRow({
        id: leaseId,
        residentName,
        residentEmail: email,
        unit: row.property?.trim() || "—",
        updated: iso,
        bucket: "manager",
        pdfVersion: 1,
        notes: "Manager-added resident — generate or upload a lease.",
        updatedAtIso: iso,
        axisId: row.id,
        propertyId: propertyId || undefined,
        managerUserId: actor.userId,
        application: row.application ?? undefined,
        // The manager is onboarding an EXISTING tenant. Without this the portal
        // gate saw no signed document and resolved them to `pre_approval` —
        // someone who already lives there and pays rent was shown Tour and
        // Application tabs and could not reach Payments (PRP-239). Not a
        // signature: there is no document to hash, and inventing one would
        // fabricate execution evidence.
        managerAttestedTenancyAt: iso,
        thread: [],
      });

  // `leaseId` is derived from the application's axis id, which is the SAME id
  // space real approved-application leases use, so two managers can arrive at
  // the same lease id from applications each of them legitimately owns.
  // Without this check an upsert on a colliding id would replace another
  // manager's fully executed lease (document, signatures and all) and
  // re-parent the row to the caller. Never write onto a lease record somebody
  // else owns.
  const { data: existingLease } = await db
    .from("portal_lease_pipeline_records")
    .select("id, manager_user_id")
    .eq("id", leaseId)
    .maybeSingle();
  if (existingLease && existingLease.manager_user_id && existingLease.manager_user_id !== actor.userId) {
    return { ok: false, status: 409, error: "That resident record belongs to another manager.", leaseId };
  }

  const { error: leaseError } = await db
    .from("portal_lease_pipeline_records")
    .upsert(buildLeaseUpsert(leaseRow as unknown as Record<string, unknown>), { onConflict: "id" });
  if (leaseError) {
    return { ok: false, status: 500, error: leaseError.message };
  }

  let welcomeEmailSent = false;
  let nextRow = row;
  if (sendWelcomeEmail) {
    const welcome = await deliverExistingResidentWelcome(db, actor, {
      to: email,
      residentName,
      axisId,
      propertyLabel: row.property,
    });
    if (!welcome.ok) {
      return {
        ok: false,
        status: welcome.status,
        error: welcome.error,
        mailtoHref: welcome.mailtoHref,
        leaseId,
      };
    }
    welcomeEmailSent = !welcome.skipped;
    nextRow = {
      ...row,
      manualResidentDetails: {
        ...row.manualResidentDetails,
        onboardingWelcomeSentAt: iso,
        ...(manualPdf ? { externallySignedLease: true as const } : {}),
      },
    };
    // Scoped to the caller as defence in depth: the route only hands us a row
    // it read back under this manager's id, and this update must not be able
    // to reach another manager's application even if that ever changes.
    await db
      .from("manager_application_records")
      .update({
        row_data: nextRow,
        resident_email: email,
        updated_at: iso,
      })
      .eq("id", row.id)
      .eq("manager_user_id", actor.userId);
  }

  return { ok: true, leaseId, welcomeEmailSent, axisId, row: nextRow };
}
