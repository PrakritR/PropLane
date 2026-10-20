# Admin > Service (PropLane Service workspaces)

PropLane Service is a FLAG on a workspace plus memberships, never ownership.

- `portal_workspaces.is_service` / `city` / `owner_of_record_name` mark a workspace as PropLane Service; the admin
  Service tab (`/admin/service`) lists every flagged workspace, whoever owns it.
- `platform_service_settings` (singleton) names the service owner. It owns the workspaces PropLane creates itself
  (the `+`) and is exempt from the 10-workspace ceiling (DB trigger only).
- Attach (admin-only, audit row written first) flags an existing workspace, sets city and label, and seats the
  service owner and the operator as accepted Admin members. It never changes `owner_user_id` and writes no property,
  lease or charge row.
- The owner of record is the person who owns an attached workspace (no membership needed) or the member flagged
  `account_link_invites.is_owner_of_record` (a Property owner). `src/lib/property-owner/access.server.ts` gives them
  owner access; sign-in and "Property portal" land in the Property portal, view-only (`workspace.readOnly`).
- Opening a workspace sets the portal workspace cookie after `authorizeOpenServiceWorkspace` re-derives membership.
- Every `/api/admin/service-workspaces` verb starts with `requireAdminRoute()`; a body id is a name, never a grant.
- Work number column: the workspace's own active work number, else nothing.
- Vendors tab (the roster) and Manager phone: [`one-number.md`](one-number.md) § W27. `platform_service_settings.manager_phone_e164` /
  `manager_phone_verified_at` are the service manager's identity; `profiles.phone` is never consulted for it.
- Network tab (`?tab=network&bucket=leads|managers|roster`, `admin-service-network.tsx`): Vendor leads (`sms_vendor_leads`; Add to roster =
  `convertVendorLead`, the roster rules unchanged, lead marked approved only after the roster write; Dismiss = decline), Free managers
  (the Subscribers "Free" bucket, `GET /api/admin/service-network`; Message opens the account record, Invite as helper = the usual
  `team-invite`), Roster (read view). Rows are glyph facts, never pills.
