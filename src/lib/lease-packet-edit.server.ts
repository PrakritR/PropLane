import type { SupabaseClient } from "@supabase/supabase-js";

import { applyLeaseSectionBodyEdits } from "@/lib/lease-html-sections";
import { sanitizeManagerLeaseDocumentEdit } from "@/lib/lease-document-sanitizer";
import { regenerateLeaseHtmlForApplication } from "@/lib/lease-amendment.server";
import {
  leaseAllowsManagerDocumentEdits,
  normalizeLeasePipelineRow,
  type LeasePipelineRow,
} from "@/lib/lease-pipeline-storage";
import type { RentalWizardFormState } from "@/lib/rental-application/types";
import { stampSmsTestProvenance } from "@/lib/sms/sms-test-provenance.server";

export type LeasePacketApplicationPatch = Partial<
  Pick<
    RentalWizardFormState,
    | "leaseStart"
    | "leaseEnd"
    | "leaseTerm"
    | "managerRentOverride"
    | "managerUtilitiesOverride"
    | "managerSecurityDepositOverride"
    | "managerMoveInFeeOverride"
    | "roomChoice1"
    | "rentalType"
  >
>;

export type PatchLeasePacketInput = {
  leaseId: string;
  unit?: string;
  notes?: string;
  application?: LeasePacketApplicationPatch;
};

export function formatLeaseMoney(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(amount);
}

/** Patch an in-review lease packet and regenerate its HTML when application data changes. */
export async function patchLeasePacketForManagerReview(
  db: SupabaseClient,
  landlordId: string,
  input: PatchLeasePacketInput,
): Promise<{ ok: true; row: LeasePipelineRow } | { ok: false; error: string }> {
  const leaseId = input.leaseId.trim();
  if (!leaseId) return { ok: false, error: "Lease id is required." };

  const { data: record, error: loadError } = await db
    .from("portal_lease_pipeline_records")
    .select("id, manager_user_id, property_id, row_data")
    .eq("id", leaseId)
    .eq("manager_user_id", landlordId)
    .maybeSingle();
  if (loadError) return { ok: false, error: loadError.message };
  if (!record?.row_data) {
    return { ok: false, error: "No lease with that id belongs to this landlord." };
  }

  const leaseRow = normalizeLeasePipelineRow(record.row_data);
  if (!leaseAllowsManagerDocumentEdits(leaseRow)) {
    return {
      ok: false,
      error: "This lease can no longer be edited (it has signatures or has left manager review).",
    };
  }

  if (input.unit === undefined && input.notes === undefined && !input.application) {
    return { ok: false, error: "Nothing to update — provide rent, dates, term, fees, unit, or notes." };
  }

  const updatedApplication = {
    ...(leaseRow.application ?? {}),
    ...(input.application ?? {}),
  } as NonNullable<LeasePipelineRow["application"]>;

  const iso = new Date().toISOString();
  const shouldRegenerate = Boolean(input.application && Object.keys(input.application).length > 0);
  const newHtml = shouldRegenerate
    ? await regenerateLeaseHtmlForApplication(db, record, leaseRow, updatedApplication)
    : null;

  if (shouldRegenerate && !newHtml && !leaseRow.generatedHtml && !leaseRow.managerUploadedPdf?.dataUrl) {
    return { ok: false, error: "Could not regenerate the lease document from saved application data." };
  }

  const version = (leaseRow.versionNumber ?? leaseRow.pdfVersion ?? 0) + (shouldRegenerate && newHtml ? 1 : 0);

  const updatedRow = normalizeLeasePipelineRow({
    ...leaseRow,
    ...(input.unit !== undefined ? { unit: input.unit.trim() } : {}),
    ...(input.notes !== undefined ? { notes: input.notes.trim() } : {}),
    application: updatedApplication,
    ...(newHtml
      ? {
          generatedHtml: newHtml,
          managerUploadedPdf: null,
          generatedAtIso: iso,
          pdfVersion: version,
          versionNumber: version,
        }
      : {}),
    status: "Manager Review",
    currentActorRole: "manager",
    bucket: "manager",
    updatedAtIso: iso,
    updated: "just now",
  });

  const { error: upsertError } = await db.from("portal_lease_pipeline_records").upsert(
    {
      id: record.id,
      manager_user_id: landlordId,
      resident_user_id: updatedRow.residentUserId ?? null,
      resident_email: updatedRow.residentEmail.trim().toLowerCase() || null,
      property_id: record.property_id ?? updatedRow.propertyId ?? null,
      status: "manager",
      row_data: stampSmsTestProvenance(updatedRow as unknown as Record<string, unknown>),
      updated_at: iso,
    },
    { onConflict: "id" },
  );
  if (upsertError) return { ok: false, error: upsertError.message };

  return { ok: true, row: updatedRow };
}

/** Patch section body HTML on a generated lease without regenerating from application data. */
export async function patchLeaseDocumentSectionsForManagerReview(
  db: SupabaseClient,
  landlordId: string,
  input: { leaseId: string; sectionBodies: Readonly<Record<string, string>> },
): Promise<{ ok: true; row: LeasePipelineRow } | { ok: false; error: string }> {
  const leaseId = input.leaseId.trim();
  if (!leaseId) return { ok: false, error: "Lease id is required." };
  const sectionIds = Object.keys(input.sectionBodies).filter((id) => id.trim());
  if (!sectionIds.length) return { ok: false, error: "Provide at least one section body to update." };

  const { data: record, error: loadError } = await db
    .from("portal_lease_pipeline_records")
    .select("id, manager_user_id, property_id, row_data")
    .eq("id", leaseId)
    .eq("manager_user_id", landlordId)
    .maybeSingle();
  if (loadError) return { ok: false, error: loadError.message };
  if (!record?.row_data) {
    return { ok: false, error: "No lease with that id belongs to this landlord." };
  }

  const leaseRow = normalizeLeasePipelineRow(record.row_data);
  if (!leaseAllowsManagerDocumentEdits(leaseRow)) {
    return {
      ok: false,
      error: "This lease can no longer be edited (it has signatures or has left manager review).",
    };
  }
  const baseHtml = leaseRow.generatedHtml?.trim();
  if (!baseHtml || leaseRow.managerUploadedPdf?.dataUrl || leaseRow.templateDocumentUrl) {
    return { ok: false, error: "Section editing requires a generated HTML lease (not an uploaded PDF)." };
  }

  const editedHtml = applyLeaseSectionBodyEdits(baseHtml, input.sectionBodies);
  const sanitized = sanitizeManagerLeaseDocumentEdit(baseHtml, editedHtml);
  if (!sanitized.ok) return { ok: false, error: sanitized.error };
  if (sanitized.html === baseHtml) {
    return { ok: false, error: "No section content changed." };
  }

  const iso = new Date().toISOString();
  const version = (leaseRow.versionNumber ?? leaseRow.pdfVersion ?? 0) + 1;
  const updatedRow = normalizeLeasePipelineRow({
    ...leaseRow,
    generatedHtml: sanitized.html,
    managerUploadedPdf: null,
    generatedAtIso: iso,
    pdfVersion: version,
    versionNumber: version,
    managerDocumentEditedAtIso: iso,
    managerDocumentRegenerationRequiredAtIso: null,
    status: "Manager Review",
    currentActorRole: "manager",
    bucket: "manager",
    updatedAtIso: iso,
    updated: "just now",
  });

  const { error: upsertError } = await db.from("portal_lease_pipeline_records").upsert(
    {
      id: record.id,
      manager_user_id: landlordId,
      resident_user_id: updatedRow.residentUserId ?? null,
      resident_email: updatedRow.residentEmail.trim().toLowerCase() || null,
      property_id: record.property_id ?? updatedRow.propertyId ?? null,
      status: "manager",
      row_data: stampSmsTestProvenance(updatedRow as unknown as Record<string, unknown>),
      updated_at: iso,
    },
    { onConflict: "id" },
  );
  if (upsertError) return { ok: false, error: upsertError.message };

  return { ok: true, row: updatedRow };
}
