/**
 * Applicant identity never lives on a lease record.
 *
 * An application keeps SSN, date of birth and driver's license sealed in
 * `_applicantIdentity` (`src/lib/security/applicant-identity.ts`). A lease row
 * carries a COPY of the application answers, and that copy used to be built from
 * the manager's decrypted view, so the plain values were persisted on
 * `portal_lease_pipeline_records.row_data.application` and readable by every
 * lease reader (resident, teammates with Leases access, admin).
 *
 * Nothing on a lease needs them, so they are removed at every boundary: the
 * normalizer (client store, sessionStorage, server readers), the
 * `POST /api/portal-lease-pipeline` write, the GET mapping and every server
 * writer. Pure on purpose, so a client bundle can import it.
 */

/** Keys that must never be present on a lease's copy of the application. */
export const LEASE_APPLICATION_IDENTITY_KEYS = [
  "ssn",
  "dateOfBirth",
  "driversLicense",
  "_applicantIdentity",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Returns the application without identity keys. Returns the SAME object when
 * nothing needs removing, so callers can cheaply preserve referential equality.
 */
export function stripApplicantIdentityFromLeaseApplication<T>(app: T): T {
  if (!isRecord(app)) return app;
  let dirty = false;
  for (const key of LEASE_APPLICATION_IDENTITY_KEYS) {
    if (key in app) {
      dirty = true;
      break;
    }
  }
  if (!dirty) return app;
  const next: Record<string, unknown> = { ...app };
  for (const key of LEASE_APPLICATION_IDENTITY_KEYS) delete next[key];
  return next as T;
}

/**
 * Applies the strip to a lease row's `application` and to the `application` of
 * each `signedLeaseSnapshots[*]`. Never touches `generatedHtml` or any other
 * field (the signed document and its hash stay byte-identical).
 */
export function stripIdentityFromLeaseRow<T>(row: T): T {
  if (!isRecord(row)) return row;
  let next: Record<string, unknown> | null = null;
  if ("application" in row) {
    const stripped = stripApplicantIdentityFromLeaseApplication(row.application);
    if (stripped !== row.application) next = { ...row, application: stripped };
  }
  const snapshots = row.signedLeaseSnapshots;
  if (Array.isArray(snapshots)) {
    let changed = false;
    const mapped = snapshots.map((snapshot) => {
      if (!isRecord(snapshot) || !("application" in snapshot)) return snapshot;
      const stripped = stripApplicantIdentityFromLeaseApplication(snapshot.application);
      if (stripped === snapshot.application) return snapshot;
      changed = true;
      return { ...snapshot, application: stripped };
    });
    if (changed) next = { ...(next ?? row), signedLeaseSnapshots: mapped };
  }
  return (next ?? row) as T;
}
