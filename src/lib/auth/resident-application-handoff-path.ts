/** The bucket path avoids the bare applications redirect, which drops the query. */
export function residentApplicationHandoffPath(applicationId: string): string {
  return `/resident/applications/pending?open=${encodeURIComponent(applicationId)}`;
}
