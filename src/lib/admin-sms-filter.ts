/** The filter value for texts no service workspace holds yet; the same word the route accepts. Shared by server and client. */
export const ADMIN_SMS_UNASSIGNED_FILTER = "unassigned";

/**
 * The filter value for every thread a PropLane-managed (`is_service`) workspace holds: the admin's "All managed" scope. It
 * lists the placed threads of every managed workspace (Ambika, Vinod, ...) and none of the unassigned ones. Reading is a view,
 * never routing: a thread stays in the workspace that holds it.
 */
export const ADMIN_SMS_MANAGED_FILTER = "managed";
