import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { DemoApplicantRow } from "@/data/demo-portal";
import { authorizeResidentRole } from "@/lib/auth/resident-role-access";
import { openApplicantRow } from "@/lib/security/applicant-identity";

export type ApplicantScreeningContext =
  | {
      ok: true;
      row: DemoApplicantRow;
      managerUserId: string;
      propertyId: string | null;
    }
  | { ok: false; status: number; error: string };

/**
 * The signed-in applicant's own application, re-derived server-side: the authenticated resident role, and the
 * application's stored resident email equal to the session's confirmed email (and, when the row is already bound to
 * an Auth subject, that subject). An application id in a request is a name, never a grant.
 */
export async function loadApplicantScreeningContext(
  db: SupabaseClient,
  user: { id: string; email?: string | null },
  applicationId: string,
): Promise<ApplicantScreeningContext> {
  const email = user.email?.trim().toLowerCase() ?? "";
  if (!email) return { ok: false, status: 403, error: "Forbidden." };

  const { data: profile, error: profileError } = await db.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (profileError || !(await authorizeResidentRole(db, { userId: user.id, legacyRole: profile?.role }))) {
    return { ok: false, status: 403, error: "Forbidden." };
  }

  const { data, error } = await db
    .from("manager_application_records")
    .select("id, manager_user_id, resident_email, property_id, assigned_property_id, row_data")
    .eq("id", applicationId)
    .maybeSingle();
  if (error) return { ok: false, status: 503, error: "Screening is unavailable." };
  if (!data?.row_data || String(data.resident_email ?? "").trim().toLowerCase() !== email) {
    return { ok: false, status: 404, error: "Application not found." };
  }

  let row: DemoApplicantRow;
  try {
    row = openApplicantRow(data.row_data as DemoApplicantRow, String(data.id));
  } catch {
    return { ok: false, status: 409, error: "Your saved application could not be read." };
  }
  if (row.residentUserId && row.residentUserId !== user.id) {
    return { ok: false, status: 404, error: "Application not found." };
  }
  const managerUserId = String(data.manager_user_id ?? "").trim();
  if (!managerUserId) return { ok: false, status: 400, error: "Application has no assigned manager." };
  const propertyId = String(data.assigned_property_id ?? data.property_id ?? "").trim() || null;
  return { ok: true, row, managerUserId, propertyId };
}
