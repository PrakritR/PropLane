/**
 * Is this signed-in session the applicant who owns the saved application row, for paying or waiving its fee?
 *
 * Two proofs, either one enough:
 *  - the session's mailbox is the row's applicant email (the original rule), or
 *  - the row is bound to this Auth subject (`row_data.residentUserId`, written server-side from the session by
 *    `prepareResidentSelfWrite` - never from the body). A phone sign-up account (captain, Nov 14: a proven phone is
 *    proof) has only the placeholder `@phone.proplane.invalid` mailbox, so the email rule alone refused every
 *    phone applicant's fee and they could not submit.
 *
 * The caller still checks the resident role. Pure, so both fee routes share one decision.
 */
export function applicationPayerSessionMatches(input: {
  sessionUserId: string | null | undefined;
  sessionEmail: string | null | undefined;
  residentEmail: string;
  rowData: unknown;
}): boolean {
  const userId = (input.sessionUserId ?? "").trim();
  if (!userId) return false;
  const email = (input.sessionEmail ?? "").trim().toLowerCase();
  const wanted = input.residentEmail.trim().toLowerCase();
  if (email && wanted && email === wanted) return true;
  const row = input.rowData && typeof input.rowData === "object" ? (input.rowData as Record<string, unknown>) : null;
  const boundUserId = typeof row?.residentUserId === "string" ? row.residentUserId.trim() : "";
  return Boolean(boundUserId) && boundUserId === userId;
}
