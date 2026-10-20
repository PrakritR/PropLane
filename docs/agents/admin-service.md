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

## Service mode (the admin-style shell under /portal)

The **Property portal is only for managers who bought the software and run their own properties.** The workspaces
PropLane manages (`is_service`) open in **service mode** instead: the same manager panels and routes
(`/portal/...`, scoped to the workspace cookie), a different rail. Manager panels are never mounted under `/admin`
(`isAdminPortalPath` there means the all-owners oversight view).

- **Rail** (`ServiceRailTiles`, in the admin portal and in service mode): PropLane logo (admins; goes to
  `/admin/dashboard`, the software overview: paid users, MRR), a hairline, one tile per service workspace the viewer
  can open (creation order), then `+` (admins; the existing `AdminNewServiceWorkspace`, then it opens the new one).
  A tile = the admin `open` action (sets the cookie), `set-active-portal manager` with `keepWorkspace`, then
  `/portal/dashboard`. A helper (not an admin) sees only their workspaces, no logo, no `+`, and opens through the
  ordinary workspace switch.
- **Who is staff** (`loadServiceStaffWorkspaces`): the platform service owner for the workspaces they own, or an
  accepted team seat on the workspace that is not the Property owner role (granted by the workspace's own owner). The
  client who owns an attached workspace is **not** staff: they keep the view-only Property portal.
- **The gate** (`decideServiceMode`, used by the `/portal` layout and `GET /api/workspaces`): service mode iff the
  ACTIVE workspace (the cookie's, else the first, exactly what the scope readers narrow to) is a service workspace the
  viewer is staff of. The top bar reads `Admin · <workspace>`, the sidebar subtitle `PropLane Service`, the plan banner
  is off and nav locks follow the service, not the viewer's own plan.
- **Property portal list**: `GET /api/workspaces` leaves staff service workspaces out of its payload (and re-resolves
  `activeWorkspaceId`) unless the portal is in service mode. `loadWorkspaces` itself is untouched (about ten scope readers
  use it). A plain switch to the manager portal (`set-active-portal`, no `keepWorkspace`) repoints a cookie that still
  names a service workspace at the account's own workspace (cleared when it has none), so the rail and the data never
  disagree. The account menu has **Switch to Admin portal** (admins) and **Switch to Property portal** (accounts that
  own a non-service workspace); a helper in the Property portal gets **Open `<workspace>`** rows.
- **Team** (Settings > Workspaces, service workspace): the admin invites helpers by **email or PropLane ID**
  (`team-invite`, `inviteServiceClient`): an Admin seat pinned to that workspace, pending until accepted, no platform
  admin grant, no Pro / Business owner-plan gate (the workspace is PropLane's managed service). Removing is
  `team-remove`. Both are admin-route verbs; a helper sees the team read-only.
- **Dashboard** (`/admin/dashboard`): each slow source (Stripe earnings, Subscribers, expenses, signups, feedback) has a
  9s budget (`withBudget`); a source that misses it is `null` and its card is left out, so one hung read cannot hold the
  page on Loading. The browser still gives up at 20s with a "took too long" error and Try again.
