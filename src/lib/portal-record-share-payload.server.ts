import "server-only";

import type { DemoApplicantRow } from "@/data/demo-portal";
import { loadApplicationGroupMembersForDocument } from "@/lib/application-group-document.server";
import { buildApplicationHtml } from "@/lib/manager-application-html";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { isSafeLeasePdfDataUrl } from "@/lib/portal-record-share-pdf";
import { getLeaseDocumentHtml, normalizeLeasePipelineRow, type LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { stripDisclosureReviewFromLeaseHtml } from "@/lib/property-lease-document-display";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type ServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

const RECORD_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export function applicationIdVariants(id: string): string[] {
  const trimmed = id.trim();
  const normalized = normalizeApplicationAxisId(trimmed);
  return [...new Set([trimmed, normalized].filter(Boolean))].filter((value) => RECORD_ID_PATTERN.test(value));
}

export { isSafeLeasePdfDataUrl };

/**
 * Pick the row the caller actually named.
 *
 * `applicationIdVariants` deliberately queries both the raw id and its normalized `AXIS-…` form,
 * so when BOTH exist as rows an ordering-based pick shares a different application than the one
 * the manager asked for. Every caller resolves through this, so the mint, revoke, and send paths
 * cannot pin different records for the same request.
 */
export function pickApplicationRecordForShare<T extends { id: string }>(
  records: T[] | null | undefined,
  recordId: string,
): T | null {
  if (!records?.length) return null;
  const trimmed = recordId.trim();
  return (
    records.find((row) => String(row.id) === trimmed) ??
    [...records].sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] ??
    null
  );
}

export type ShareLinkAccessContext = {
  recordOwnerUserId: string;
};

export type SharedLeasePayload = {
  kind: "lease";
  title: string;
  subtitle: string;
  contentType: "html" | "pdf";
  html?: string;
  pdfDataUrl?: string;
};

export type SharedApplicationPayload = {
  kind: "application";
  title: string;
  subtitle: string;
  html: string;
};

async function resolveApplicationRecordRow(db: ServiceClient, recordId: string, recordOwnerUserId: string) {
  const trimmed = recordId.trim();
  if (!RECORD_ID_PATTERN.test(trimmed)) return null;

  const { data: record, error } = await db
    .from("manager_application_records")
    .select("id, row_data, manager_user_id, property_id, assigned_property_id")
    .eq("id", trimmed)
    .eq("manager_user_id", recordOwnerUserId)
    .maybeSingle();
  if (error || !record?.row_data) return null;
  return record;
}

export async function loadSharedLeasePayload(
  db: ServiceClient,
  recordId: string,
  access: ShareLinkAccessContext,
): Promise<SharedLeasePayload | null> {
  if (!RECORD_ID_PATTERN.test(recordId.trim())) return null;
  const { data, error } = await db
    .from("portal_lease_pipeline_records")
    .select("id, manager_user_id, property_id, row_data")
    .eq("id", recordId.trim())
    .eq("manager_user_id", access.recordOwnerUserId)
    .maybeSingle();
  if (error || !data) return null;
  if (String(data.manager_user_id) !== access.recordOwnerUserId) return null;

  const row = normalizeLeasePipelineRow(data.row_data) as LeasePipelineRow;
  const residentName = row.residentName?.trim() || row.residentEmail?.trim() || "Resident";
  const propertyLabel = row.unit?.trim() || row.propertyId || "Lease";
  const title = `${residentName} · ${propertyLabel}`;
  const subtitle = row.status ? `Lease · ${row.status}` : "Lease document";

  const uploadedPdf = row.managerUploadedPdf?.dataUrl;
  if (uploadedPdf && isSafeLeasePdfDataUrl(uploadedPdf)) {
    return {
      kind: "lease",
      title,
      subtitle,
      contentType: "pdf",
      pdfDataUrl: uploadedPdf,
    };
  }

  const html = getLeaseDocumentHtml(row);
  if (!html) return null;
  return {
    kind: "lease",
    title,
    subtitle,
    contentType: "html",
    html: stripDisclosureReviewFromLeaseHtml(html),
  };
}

export async function loadSharedApplicationPayload(
  db: ServiceClient,
  recordId: string,
  access: ShareLinkAccessContext,
): Promise<SharedApplicationPayload | null> {
  const record = await resolveApplicationRecordRow(db, recordId, access.recordOwnerUserId);
  if (!record) return null;

  const row = record.row_data as DemoApplicantRow;

  const groupMembers = await loadApplicationGroupMembersForDocument(db, row, {
    managerUserId: access.recordOwnerUserId,
  });

  const applicantName = row.name?.trim() || row.application?.fullLegalName?.trim() || "Applicant";
  const title = `${applicantName} · Application`;
  const propertyLabel = row.property?.trim() || "Application";
  const subtitle = `${propertyLabel} · ${row.bucket === "approved" ? "Approved" : row.bucket === "rejected" ? "Rejected" : "Pending"}`;

  return {
    kind: "application",
    title,
    subtitle,
    html: buildApplicationHtml(row, {
      groupMembers,
      publicShare: true,
    }),
  };
}
