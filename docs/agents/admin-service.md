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
- **A service workspace texts on the PropLane line (206), always (Oct 25).** Every `is_service` workspace sends from the PropLane
  line in BOTH line modes, even an attached client workspace that still holds a live number of its own (Ambika's +1 (814) 679-3694,
  Vinod's). The decision is `resolveServiceLine` (`src/lib/one-number/service-line.server.ts`); the dispatcher's readiness check, the
  number resolvers and Settings > Communication > Work identity (the "PropLane line" row, no request or release) all read it, and an
  unresolvable line refuses the send rather than using the old number. Inbound on the old number still routes to the workspace. Nothing
  here releases or buys a number: retiring the old one is an operator step. Detail: [`one-number.md`](one-number.md) § W29.
- Opening a workspace sets the portal workspace cookie after `authorizeOpenServiceWorkspace` re-derives membership.
- Every `/api/admin/service-workspaces` verb starts with `requireAdminRoute()`; a body id is a name, never a grant.
- **One sidebar row (Oct 25).** Service is ONE row under Software (`ADMIN_SECTION_TABS.service`): tabs Workspaces
  (`/admin/service`, today's panel with its inner Workspaces · Vendors · Network tabs) · PropLane line · Unassigned leads.
  The rest of the admin nav — the retired "Property management" heading and all-owners Properties list, the redirects and
  the phone bottom bar — is [`one-number.md`](one-number.md) § W15 (Admin navigation).
- Work number column: a service workspace is always on the PropLane line, so the row states `resolveServiceLine`'s number as
  "(206) 678-1909 · PropLane line" (`workNumberFactLabel`), never a number the workspace once held; an unresolvable or unreadable line
  shows "No number". A live number the workspace still holds besides the line is its **old number**: it keeps receiving (a text to it
  lands in that workspace, the reply leaves from the 206, send paths refuse the old row) and the row carries one more fact,
  "Old (814) 679-3694 kept since Oct 25" (`oldNumber`, the date of the attach audit row). There is no automatic release. The per-row
  **Release old number** action (`action: "release-old-number"`, `releaseServiceWorkspaceOldNumber`) is platform-admin only
  (re-derived), writes its `admin_service_release_old_number` audit row BEFORE the release and refuses without it, calls
  `releaseManagerNumber` (database state only; handing the number back to the carrier stays an operator step), verifies the row is
  gone, and refuses a workspace that holds the PropLane line itself.
- Management fee: every service workspace gets PropLane's automatic fee, never signed; attach and create ask for it,
  and a workspace created before it has an owner of record gets it the first time anything needs one. The row states
  the rate in force and the per-row **Management fee** action (`action: "fee"`, audit row written before the change)
  moves it. The rule, the range and what a change does to payments in flight:
  [`owner-management.md`](owner-management.md) § Automatic management fee.
- Vendors tab (the roster) and Manager phone: [`one-number.md`](one-number.md) § W27. `platform_service_settings.manager_phone_e164` /
  `manager_phone_verified_at` are the service manager's identity; `profiles.phone` is never consulted for it.
- Network tab (`?tab=network&bucket=leads|managers|roster`, `admin-service-network.tsx`): Vendor leads (`sms_vendor_leads`; Add to roster =
  `convertVendorLead`, the roster rules unchanged, lead marked approved only after the roster write; Dismiss = decline), Free managers
  (the "Free" plan bucket of the subscriber classifier, `GET /api/admin/service-network`; Message opens the account record, Invite as helper = the usual
  `team-invite`), Roster (read view). Rows are glyph facts, never pills.

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
- **Account menu** (the rail's bottom-left avatar, `PortalAccountMenu`): Settings opens from here, not the sidebar
  ([`ui-page-structure.md`](ui-page-structure.md) § Shell; `/admin/profile`, `/portal/profile` stay routable). In service
  mode (`service.activeId` set) the menu is ONLY Settings, Help & feedback, Sign out - no Switch to Admin / Resident /
  Property portal rows (the phone's profile menu drops its role switcher the same way). A client owner viewing their
  own workspace view-only is not in service mode and keeps the ordinary Property-portal menu.
- **Phone** (the rail is hidden below `lg`): `PortalMobileNavBar` takes a `service` prop and shows `ServiceWorkspaceMenu`
  in its left slot - current name + chevron, rows PropLane (admins), each workspace (city as a plain fact), New
  workspace (admins). There is no Property portal row: service mode is still the admin portal and PropLane is the way
  back to the admin home. It shares the rail's open/create/switch logic (`useServiceWorkspaceOpen`); the server authorizes every
  open. The menu takes the slot that held the section title, so the label stays as an `sr-only` `h1` beside it.
- **Who is staff** (`loadServiceStaffWorkspaces`, decided per seat by `serviceSeatVerdict`): the platform service owner
  for the workspaces they own, or an accepted team seat at an OPERATOR role (Admin / Full), granted by the workspace's
  own owner. A Viewer / Custom / Property manager seat is never staff - on a workspace PropLane created or an attached
  one, and being a platform admin does not change that; such a seat keeps only its per-house grants. On an attached
  workspace an operator seat also needs PropLane's own provenance (`is_service_seat`) unless the holder is a PropLane
  person. The client who owns an attached workspace is **not** staff: they keep the view-only Property portal.
- **The gate** (`decideServiceMode`, used by the `/portal` layout and `GET /api/workspaces`): service mode iff the
  ACTIVE workspace (the cookie's, else the first, exactly what the scope readers narrow to) is a service workspace the
  viewer is staff of. The top bar reads `Admin · <workspace>`, the sidebar subtitle `PropLane Service`, the plan banner
  is off and nav locks follow the service, not the viewer's own plan.
- **Bookings are the workspace's, not the viewer's.** A booking the workspace owner typed by hand is stamped to the OWNER,
  so `/api/portal-schedule-records` showed staff only their own rows. In service mode the route (opt-in
  `resolveServiceScope`, `loadServiceStaffScope`, pure `serviceStaffScope`) lets staff read, edit, cancel and delete the
  room blocks of the open workspace's houses and nothing else: the scope is re-derived server-side from membership and the
  cookie (never a body id), is null for a stranger, a client owner and staff on their own non-service workspace, and fails
  closed on a read error. The occupancy, channel and lease reads were already by property grant (the Admin seat carries one).
  Coverage: `tests/unit/schedule-records-service-staff.test.ts`.
- **Property portal list**: `GET /api/workspaces` leaves staff service workspaces out of its payload (and re-resolves
  `activeWorkspaceId`) unless the portal is in service mode. `loadWorkspaces` itself is untouched (about ten scope readers
  use it). A plain switch to the manager portal (`set-active-portal`, no `keepWorkspace`) repoints a cookie that still
  names a service workspace at the account's own workspace (cleared when it has none), so the rail and the data never
  disagree. The account menu has **Switch to Admin portal** (admins) and **Switch to Property portal** (accounts that
  own a non-service workspace); a helper in the Property portal gets **Open `<workspace>`** rows.
- **Team** (Settings > Workspaces, service workspace; `ServiceTeamSection`): the round blue + opens the Invite sheet
  (`ServiceInviteSheet`, built from the shared `WorkspacePermissionsFields` / `CoManagerPermissionsEditor` /
  `WorkspaceGrantFields`): **email or PropLane ID**, Role (the team roles plus **Owner**), Houses, per-module View / Edit.
  Each seat's ⋯ has **Edit access** (the same sheet, prefilled; `team-access`) and Remove (`team-remove`). All are
  admin-route verbs; a helper sees the team read-only. A service seat carries the permissions the sheet chose, validated by
  the SAME functions `POST /api/pro/account-links` uses (`src/lib/co-manager-invite-grant.ts`: role parsed from the
  allow-list, "all houses" resolved to THIS workspace's houses, a house of another workspace refused, a role above the
  operator's own refused, the operator capped to the modules they hold). Every seat is pinned to that workspace, stamped
  `is_service_seat`, grants no platform admin role and needs no Pro / Business plan (the workspace is PropLane's managed
  service). A bare email or ID with no role is the original invite: Admin, every house.
  - *Delivery.* An account that exists gets a pending membership and the co-manager notice
    (`notifyCoManagerInviteSent`: email + inbox, a text from the workspace owner's work number only to a verified phone).
    An email with **no account** gets a **one-use invite link** by email (`manager_invite_links`, 30 days,
    label `Service invite · <email>`; bound to that email through `manager_invite_links.invitee_email`, so only the confirmed
    account with that address can redeem it; shown in Team as "Invited"; Remove turns it off). The person opens
    `/invite/<token>`, creates their account there and the redeem writes the seat (`redeemInviteLink`). In a workspace
    PropLane itself owns (`isPropLaneOwnedServiceWorkspace`: `is_service` and owned by the platform service owner) that
    redeem skips the owner-plan gate and stamps `is_service_seat` (or, for an Owner link, `is_owner_of_record`); on a
    client-owned attached workspace every ordinary rule still applies and no service flag is set.
  - *Owner.* Role Owner stamps `team_role = property_owner` + `is_owner_of_record`, read-only by role, and the Team list
    labels the row "Owner" ("Invited · Owner" while pending). One per workspace, and only an accepted / pending owner
    membership or a LIVE Admin › Service owner invite holds that slot (`liveServiceInviteLinks`; an ordinary owner
    share link cannot make an owner of record, so it never stands in the real owner's way either): a second invite
    answers 409 `owner_exists` (the sheet asks "Replace the owner?"); confirming (`replaceOwner: true`) cancels the first owner's
    membership (audited `admin_service_owner_replaced`) or turns their unspent link off, then invites. The client who
    OWNS an attached workspace is its owner of record and cannot be replaced. Owner copy: email subject "PropLane manages
    <Workspace> for you", body "Hi <First>, PropLane has set up <Workspace> for your homes. Create your account to see rent,
    payouts and services: <link>", text "PropLane: <Workspace> is ready. Create your account to see your homes: <link>"
    (`co-manager-link-email.ts`). Accepting opens the workspace view-only (`workspaces/server.ts` `readOnly`,
    `managed-read-only.server.ts`) and sees every house and module of the workspace at view, derived at read time
    ([`co-manager-access.md`](co-manager-access.md) § The owner of record of a PropLane Service workspace).
  - *New workspace* asks Name and City, then an **Owner** heading with Name and Email or PropLane ID (both optional). Name
    still fills `owner_of_record_name`; a filled-in email or ID sends the same owner invite after create (the workspace
    exists whatever happens to the invite; the pop-up says so).
- **Fee split** (Settings > Balance & payouts on a service workspace; `ServiceFeeSplitCard`): PropLane % stepper (0 to 30),
  owner % derived, a bar and "On $1,000 rent" example. Save writes `action: "fee"` through `setServiceWorkspaceFee`
  (new version, audit row). Only a platform admin edits (`requireAdminRoute` on the write; `canEdit` is derived in
  `GET /api/workspaces/service-fee`, never sent by the client); the owner and other seats see it read-only ("PropLane 10% ·
  You 90%"). The same control stays in Service > Workspaces > ⋯ > Management fee. See
  [`owner-management.md`](owner-management.md) § Automatic management fee.
- **Dashboard** (`/admin/dashboard`): each slow source (Stripe earnings, Subscribers, expenses, signups, feedback) has a
  9s budget (`withBudget`); a source that misses it is `null` and its card is left out, so one hung read cannot hold the
  page on Loading. The browser still gives up at 20s with a "took too long" error and Try again.
