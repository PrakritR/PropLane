import "server-only";

import type { DemoApplicantRow } from "@/data/demo-portal";
import { loadApplicationGroupMembersForDocument } from "@/lib/application-group-document.server";
import { buildApplicationHtml } from "@/lib/manager-application-html";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { isSafeLeasePdfDataUrl } from "@/lib/portal-record-share-pdf";
import { getLeaseDocumentHtml, normalizeLeasePipelineRow, type LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import {
  resolveApplicationRecordOwnerUserId,
  resolveLeaseRecordOwnerUserId,
} from "@/lib/portal-record-share-authorize.server";
import { stripDisclosureReviewFromLeaseHtml } from "@/lib/property-lease-document-display";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type ServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

const RECORD_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export function applicationIdVariants(id: string): string[] {
  const trimmed = id.trim();
  const normalized = normalizeApplicationAxisId(trimmed);
  return [...new Set([trimmed, normalized].filter(Boolean))].filter((value) => RECORD_ID_PATTERN.test(value));
}

/**
 * Pick the row the caller actually named.
 *
 * `applicationIdVariants` deliberately queries both the raw id and its normalized `AXIS-…` form,
 * so when BOTH exist as rows an ordering-based pick shares a different application than the one
 * the manager asked for: prefer the exact id, and fall back to a deterministic order only when
 * it is absent.
 *
 * NOTE: currently has no callers — `authorizePortalRecordShare`
 * (`portal-record-share-authorize.server.ts`) now fronts the mint, revoke, and send paths and
 * repeats this pick inline. Two copies of the rule is exactly how those paths drift apart again;
 * route the authorizer through this function rather than adding a third copy.
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
  /**
   * Deliberately NOT the PDF itself.
   *
   * The uploaded PDF used to travel inside this JSON as a base64 `data:` URL, uncacheable and
   * ~33% larger than the bytes, re-sent in full on every single page load. A multi-MB lease
   * shared with a handful of people is then a measurable egress cost on the free plan, paid over
   * and over for a document that never changes.
   *
   * The viewer fetches the bytes from the token's own `/pdf` endpoint instead, which streams them
   * binary and revalidates cheaply. `contentType` alone tells the page which branch to render.
   */
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
    .maybeSingle();
  if (error || !record?.row_data) return null;

  const ownerUserId = await resolveApplicationRecordOwnerUserId(db, record);
  if (ownerUserId !== recordOwnerUserId) return null;
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
    .maybeSingle();
  if (error || !data) return null;

  const ownerUserId = await resolveLeaseRecordOwnerUserId(db, data);
  if (ownerUserId !== access.recordOwnerUserId) return null;

  const row = normalizeLeasePipelineRow(data.row_data) as LeasePipelineRow;
  const residentName = row.residentName?.trim() || row.residentEmail?.trim() || "Resident";
  const propertyLabel = row.unit?.trim() || row.propertyId || "Lease";
  const title = `${residentName} · ${propertyLabel}`;
  const subtitle = row.status ? `Lease · ${row.status}` : "Lease document";

  const uploadedPdf = row.managerUploadedPdf?.dataUrl;
  if (uploadedPdf && isSafeLeasePdfDataUrl(uploadedPdf)) {
    return { kind: "lease", title, subtitle, contentType: "pdf" };
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

  // Public shares render an allowlisted summary that deliberately excludes all
  // identity fields. Keep the envelope opaque; decrypting here would widen key
  // use without restoring any permitted output. The stored row is never returned.
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

/**
 * The uploaded lease PDF's bytes, for the token-scoped `/pdf` endpoint.
 *
 * Re-runs the SAME ownership filter as `loadSharedLeasePayload` rather than trusting that the
 * caller already did: this endpoint is separately reachable, so an authorization that lived only
 * on the sibling route would not apply to it.
 *
 * Returns null unless the stored value is a `data:application/pdf;base64,` URL. That is an
 * allowlist, not a sanitizer — `row_data` is writable by the row's own resident, so an
 * unrecognised value is refused rather than decoded and served under a PDF content type.
 */
export async function loadSharedLeasePdfBytes(
  db: ServiceClient,
  recordId: string,
  access: ShareLinkAccessContext,
): Promise<Buffer | null> {
  if (!RECORD_ID_PATTERN.test(recordId.trim())) return null;
  const { data, error } = await db
    .from("portal_lease_pipeline_records")
    .select("id, manager_user_id, row_data")
    .eq("id", recordId.trim())
    .eq("manager_user_id", access.recordOwnerUserId)
    .maybeSingle();
  if (error || !data) return null;
  if (String(data.manager_user_id) !== access.recordOwnerUserId) return null;

  const row = normalizeLeasePipelineRow(data.row_data) as LeasePipelineRow;
  const dataUrl = row.managerUploadedPdf?.dataUrl;
  if (!dataUrl || !isSafeLeasePdfDataUrl(dataUrl)) return null;

  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  try {
    const bytes = Buffer.from(base64, "base64");
    return bytes.length > 0 ? bytes : null;
  } catch {
    return null;
  }
}
