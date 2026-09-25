import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { manualResidentSignedLeasePdf } from "@/lib/existing-resident-onboarding";

/**
 * Whether `body` is exactly the already-executed lease the MANAGER filed onto the
 * application record (`manualResidentDetails.signedLeaseDataUrl`).
 *
 * `syncApprovedApplications` seeds the existing-resident onboarding lease from
 * that PDF, and it runs in the RESIDENT's browser too, so a resident's ordinary
 * sync legitimately posts a document body the server has not stored on the lease
 * row yet. Admitting that shape by believing the row's own
 * `externallySignedLease` flag would be trusting a field the request supplied —
 * and the same POST could then carry arbitrary bytes into the property owner's
 * document library. The bytes are the trust signal, so they are compared against
 * the copy the manager filed.
 *
 * The seeded row is PDF-ONLY (`needsPdf` requires no existing `generatedHtml`),
 * so a body that also carries HTML is refused rather than let the matching PDF
 * wave arbitrary markup through beside it.
 *
 * What is actually load-bearing: the lookup is pinned to `managerUserId`, which
 * the caller reads from the lease record's stored `manager_user_id` COLUMN, and
 * the verdict is byte equality against that manager's own filed PDF. `axisId`
 * only selects which of that manager's applications to compare against — it is
 * NOT server-derived (it comes from stored `row_data`, which is client-written on
 * every prior upsert), so treat it as caller-influenced. That is harmless while
 * the verdict is byte equality; if this is ever loosened to a hash, a filename,
 * or mere presence, `axisId` becomes load-bearing and must be re-derived server
 * side first.
 *
 * Fails CLOSED: an unreadable application record corroborates nothing.
 */
export async function leaseBodyMatchesManagerFiledLease(
  db: SupabaseClient,
  axisId: string | null | undefined,
  managerUserId: string | null | undefined,
  body: { html: string | null; pdf: string | null },
): Promise<boolean> {
  if (body.html) return false;
  const candidate = String(body.pdf ?? "").trim();
  const applicationId = String(axisId ?? "").trim();
  const owner = String(managerUserId ?? "").trim();
  if (!candidate || !applicationId || !owner) return false;

  const { data, error } = await db
    .from("manager_application_records")
    .select("id, row_data")
    .eq("id", applicationId)
    .eq("manager_user_id", owner)
    .limit(1);
  if (error) {
    console.error("Manager-filed lease corroboration failed:", { applicationId, message: error.message });
    return false;
  }

  const applicationRow = (data?.[0]?.row_data ?? null) as DemoApplicantRow | null;
  if (!applicationRow || applicationRow.bucket !== "approved" || applicationRow.manuallyAdded !== true) return false;
  const filed = manualResidentSignedLeasePdf(applicationRow);
  const filedPdf = String(filed?.originalDataUrl ?? filed?.dataUrl ?? "").trim();
  return Boolean(filedPdf) && filedPdf === candidate;
}

/** Resolve a first-write onboarding lease from the stored application. */
export async function managerFiledLeaseScopeForNewRow(
  db: SupabaseClient,
  axisId: string | null | undefined,
  actor: { role: "manager" | "resident"; id: string; email: string | null | undefined },
  body: { html: string | null; pdf: string | null },
): Promise<{ managerUserId: string; residentEmail: string; propertyId: string | null } | null> {
  if (body.html || !body.pdf || !axisId) return null;
  const { data, error } = await db
    .from("manager_application_records")
    .select("id, manager_user_id, resident_email, property_id, assigned_property_id, row_data")
    .eq("id", axisId)
    .limit(1);
  if (error || !data?.[0]) return null;
  const application = data[0];
  const owner = String(application.manager_user_id ?? "").trim();
  const applicantEmail = String(application.resident_email ?? "").trim().toLowerCase();
  if (!owner || !applicantEmail) return null;
  if (actor.role === "manager" && owner !== actor.id) return null;
  if (actor.role === "resident" && applicantEmail !== actor.email?.trim().toLowerCase()) return null;
  const applicationRow = application.row_data as DemoApplicantRow;
  if (applicationRow.bucket !== "approved" || applicationRow.manuallyAdded !== true) return null;
  const filed = manualResidentSignedLeasePdf(applicationRow);
  const filedPdf = String(filed?.originalDataUrl ?? filed?.dataUrl ?? "").trim();
  if (!filedPdf || filedPdf !== body.pdf.trim()) return null;
  return {
    managerUserId: owner,
    residentEmail: applicantEmail,
    propertyId: String(application.assigned_property_id ?? application.property_id ?? "").trim() || null,
  };
}
