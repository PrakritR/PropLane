/**
 * Whose identity may pre-fill a PUBLIC prospect form (tour request, message). Only a person asking for
 * themselves: a resident or a prospect with no staff role. A manager, admin or vendor session is looking at the
 * page on someone else's behalf (testing, sharing, support), so their own name, email and phone must never land
 * in a form that files a request under it.
 */
export function prospectContactMayPrefill(roles: readonly string[]): boolean {
  return !roles.some((role) => role === "manager" || role === "admin" || role === "vendor");
}
