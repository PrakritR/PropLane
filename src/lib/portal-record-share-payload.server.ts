import "server-only";

import type { DemoApplicantRow } from "@/data/demo-portal";
import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";
import { loadApplicationGroupMembersForDocument } from "@/lib/application-group-document.server";
import { buildApplicationHtml } from "@/lib/manager-application-html";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { getLeaseDocumentHtml, normalizeLeasePipelineRow, type LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { stripDisclosureReviewFromLeaseHtml } from "@/lib/property-lease-document-display";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type ServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

const RECORD_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function applicationIdVariants(id: string): string[] {
  const trimmed = id.trim();
  const normalized = normalizeApplicationAxisId(trimmed);
  return [...new Set([trimmed, normalized].filter(Boolean))].filter((value) => RECORD_ID_PATTERN.test(value));
}

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

export async function loadSharedLeasePayload(
  db: ServiceClient,
  recordId: string,
  managerUserId: string,
): Promise<SharedLeasePayload | null> {
  if (!RECORD_ID_PATTERN.test(recordId.trim())) return null;
  const { data, error } = await db
    .from("portal_lease_pipeline_records")
    .select("id, manager_user_id, row_data")
    .eq("id", recordId.trim())
    .maybeSingle();
  if (error || !data) return null;

  const row = normalizeLeasePipelineRow(data.row_data) as LeasePipelineRow;
  const residentName = row.residentName?.trim() || row.residentEmail?.trim() || "Resident";
  const propertyLabel = row.unit?.trim() || row.propertyId || "Lease";
  const title = `${residentName} · ${propertyLabel}`;
  const subtitle = row.status ? `Lease · ${row.status}` : "Lease document";

  if (row.managerUploadedPdf?.dataUrl) {
    return {
      kind: "lease",
      title,
      subtitle,
      contentType: "pdf",
      pdfDataUrl: row.managerUploadedPdf.dataUrl,
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
  managerUserId: string,
): Promise<SharedApplicationPayload | null> {
  const ids = applicationIdVariants(recordId);
  if (ids.length === 0) return null;

  const { data: records, error } = await db
    .from("manager_application_records")
    .select("id, row_data, manager_user_id")
    .in("id", ids)
    .limit(1);
  if (error || !records?.[0]?.row_data) return null;
  const record = records[0];

  const row = record.row_data as DemoApplicantRow;
  const signerIds = [...new Set([...ids, ...ids.map((v) => v.toUpperCase())])];
  const { data: cosignerRows } = await db
    .from("cosigner_submission_records")
    .select("row_data, created_at")
    .in("signer_app_id", signerIds)
    .order("created_at", { ascending: true });
  const cosignerSubmissions = (cosignerRows ?? [])
    .map((r) => r.row_data)
    .filter(Boolean) as CosignerSubmission[];

  const groupMembers = await loadApplicationGroupMembersForDocument(db, row, {
    managerUserId,
  });

  const applicantName = row.name?.trim() || row.application?.fullName?.trim() || "Applicant";
  const title = `${applicantName} · Application`;
  const propertyLabel = row.property?.trim() || "Application";
  const subtitle = `${propertyLabel} · ${row.bucket === "approved" ? "Approved" : row.bucket === "rejected" ? "Rejected" : "Pending"}`;

  return {
    kind: "application",
    title,
    subtitle,
    html: buildApplicationHtml(row, { cosignerSubmissions, groupMembers }),
  };
}
