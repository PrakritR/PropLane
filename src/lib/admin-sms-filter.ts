/**
 * The Workspace filter value for texts no service workspace holds yet; the same word the route accepts. Its own module
 * so server code (`manager-sms-messages.server.ts`) can read it without pulling in the client store in
 * `admin-sms-workspaces.ts`.
 */
export const ADMIN_SMS_UNASSIGNED_FILTER = "unassigned";
