import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { DemoApplicantRow } from "@/data/demo-portal";
import { isResidentSetupTokenValid } from "@/lib/auth/resident-setup-token";
import {
  selectOpenApplicationMatch,
  type OpenApplicationCandidate,
} from "@/lib/rental-application/application-draft-dedupe";
import { STORED_APPLICATION_SELECT, type StoredApplicationRecord } from "@/lib/rental-application/signed-in-application-write.server";

export type OpenApplicationLookup =
  | { ok: true; match: { record: StoredApplicationRecord; row: DemoApplicantRow } | null }
  | { ok: false };

/**
 * Reads the applicant's open applications for one house and picks the one a new draft folds into
 * ({@link selectOpenApplicationMatch}). A failed read answers `ok: false`; the caller then writes the
 * draft as it always did - a duplicate row is recoverable, a refused autosave loses typing.
 *
 * Scoped by the house and by who the applicant is (the Auth subject, else the guest's email), so the
 * read never touches another person's rows.
 */
export async function findOpenApplicationForApplicant(
  db: SupabaseClient,
  input: {
    subject: string | null;
    email: string;
    propertyId: string;
    excludeId?: string | null;
    incomingRoom?: string | null;
    /** Guests only: proof the browser already holds the kept row (its current setup token). */
    guestTokens?: readonly string[];
  },
): Promise<OpenApplicationLookup> {
  const propertyId = input.propertyId.trim();
  const email = input.email.trim().toLowerCase();
  if (!propertyId || (!input.subject && !email)) return { ok: true, match: null };
  let query = db.from("manager_application_records").select(STORED_APPLICATION_SELECT).eq("property_id", propertyId);
  query = input.subject ? query.eq("row_data->>residentUserId", input.subject) : query.eq("resident_email", email);
  const { data, error } = await query.limit(50);
  if (error) return { ok: false };
  const records = (data ?? []) as StoredApplicationRecord[];
  const candidates: OpenApplicationCandidate[] = records
    .filter((record) => record.id && record.row_data)
    .map((record) => ({
      id: String(record.id),
      row: record.row_data as DemoApplicantRow,
      residentEmail: record.resident_email,
      updatedAt: record.updated_at,
    }));
  // A guest's email is typed, not proven. Folding a stranger's draft into a row that merely shares the
  // email would let anyone overwrite it (and learn its id), so a guest merge needs the row's own token.
  const eligible = input.subject
    ? candidates
    : candidates.filter((candidate) =>
        (input.guestTokens ?? []).some((token) => isResidentSetupTokenValid(candidate.row, token)),
      );
  const picked = selectOpenApplicationMatch(eligible, input);
  if (!picked) return { ok: true, match: null };
  const record = records.find((r) => String(r.id) === picked.id);
  return record ? { ok: true, match: { record, row: picked.row } } : { ok: true, match: null };
}
