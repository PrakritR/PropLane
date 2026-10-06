import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { DemoApplicantRow } from "@/data/demo-portal";
import {
  applicantIdentityMissing,
  applyApplicantIdentityToRow,
  resolveApplicantIdentity,
  type ApplicantAuthUser,
  type ApplicantIdentity,
} from "@/lib/rental-application/applicant-identity";

/** The signed-in viewer's own identity: the auth user plus their profile row (service-role read pinned to `user.id`). */
export async function loadApplicantAccountIdentity(
  db: SupabaseClient,
  user: ApplicantAuthUser & { id: string },
  answers?: { fullLegalName?: unknown; email?: unknown } | null,
): Promise<ApplicantIdentity> {
  let profile: { email?: string | null; full_name?: string | null } | null = null;
  try {
    const { data } = await db.from("profiles").select("email, full_name").eq("id", user.id).maybeSingle();
    profile = (data as typeof profile) ?? null;
  } catch {
    // The auth user alone still identifies the applicant; a profile read failure must not fail a submit.
    profile = null;
  }
  return resolveApplicantIdentity({ answers: answers ?? null, authUser: user, profile });
}

/**
 * Fill a signed-in applicant's own row from their ACCOUNT where the template no longer asks (see
 * `applicant-identity.ts`). Reads the profile only when something is actually missing, so a template that
 * still asks costs no extra query and the row comes back untouched.
 *
 * Only call for a row the viewer is already authorized to write as the applicant.
 */
export async function fillApplicantIdentityFromAccount(
  db: SupabaseClient,
  user: ApplicantAuthUser & { id: string },
  row: DemoApplicantRow,
  opts: { submitted: boolean },
): Promise<DemoApplicantRow> {
  if (!applicantIdentityMissing(row, opts)) return row;
  // The answer is passed so a (rare) answered name still wins over the account's.
  const identity = await loadApplicantAccountIdentity(db, user, {
    fullLegalName: row.application?.fullLegalName || row.name,
    email: row.application?.email,
  });
  return applyApplicantIdentityToRow(row, identity, opts);
}
