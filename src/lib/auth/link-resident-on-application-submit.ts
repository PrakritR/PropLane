import type { DemoApplicantRow } from "@/data/demo-portal";
import {
  LISTING_NOT_ACCEPTING_APPLICATIONS_ERROR,
  resolvePropertyApplicationTarget,
} from "@/lib/auth/guest-application-upsert";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import type { SupabaseClient } from "@supabase/supabase-js";

function readPropertyId(row: DemoApplicantRow): string {
  return (
    row.propertyId?.trim() ||
    row.assignedPropertyId?.trim() ||
    row.application?.propertyId?.trim() ||
    ""
  );
}

export type ResidentApplicationSubmitResult =
  | { ok: true; row: DemoApplicantRow }
  | { ok: false; status: number; error: string };

/**
 * Enriches an application row and links the resident profile to the manager workspace on submit.
 * Attribution is derived from the listing (or the already-stored value on an edit) — never from
 * the request body, since `managerUserId` alone decides who sees the row in the manager portal.
 */
export async function linkResidentOnApplicationSubmit(
  db: SupabaseClient,
  params: {
    userId: string;
    row: DemoApplicantRow;
    isNewSubmit: boolean;
    existingManagerUserId?: string | null;
    /** When false, only stamps the application row — never overwrites profiles.manager_id. */
    linkProfile?: boolean;
  },
): Promise<ResidentApplicationSubmitResult> {
  const propertyId = readPropertyId(params.row);
  const target = propertyId
    ? await resolvePropertyApplicationTarget(db, propertyId)
    : { managerUserId: null, status: null, acceptsApplications: false };
  const managerUserId = target.managerUserId || params.existingManagerUserId?.trim() || null;

  if (!managerUserId && params.isNewSubmit) {
    return { ok: false, status: 400, error: "This listing cannot accept applications yet." };
  }

  // A NEW application against a listing the manager has taken down is refused
  // before anything is written or charged. An application already in flight is
  // not — this path also stamps updates, and stranding work already done is a
  // worse outcome than one late application.
  if (params.isNewSubmit && !target.acceptsApplications) {
    return { ok: false, status: 409, error: LISTING_NOT_ACCEPTING_APPLICATIONS_ERROR };
  }

  const normalizedRow: DemoApplicantRow = {
    ...params.row,
    id: normalizeApplicationAxisId(params.row.id),
    propertyId: propertyId || params.row.propertyId,
    managerUserId,
    residentUserId: params.userId,
    axisId: normalizeApplicationAxisId(params.row.id),
  };

  const axisId = normalizeApplicationAxisId(normalizedRow.id);
  const { data: existingProfile } = await db
    .from("profiles")
    .select("manager_id")
    .eq("id", params.userId)
    .maybeSingle();

  const existingAxisId = typeof existingProfile?.manager_id === "string" ? existingProfile.manager_id.trim() : "";
  const linkProfile = params.linkProfile !== false;
  if (linkProfile && (params.isNewSubmit || !existingAxisId)) {
    await db.from("profiles").update({ manager_id: axisId }).eq("id", params.userId);
  }

  return { ok: true, row: normalizedRow };
}
