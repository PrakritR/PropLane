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
  own owner. A Viewer / Custom / Property manager seat the CLIENT wrote (no `is_service_seat`) is never staff - on a workspace
  PropLane created or an attached one, and being a platform admin does not change that; such a seat keeps only its per-house
  grants. A seat PropLane issued (`is_service_seat`, the Admin team below) of ANY non-owner role is staff of the shell: the shell
  only decides which workspaces the holder sees, what they read and change inside stays the seat's own houses and module
  levels. On an attached workspace an operator seat also needs PropLane's own provenance (`is_service_seat`) unless the
  holder is a PropLane person. The client who owns an attached workspace is **not** staff: they keep the view-only Property portal.
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
- **Work email** (`service-work-email.server.ts`): a service workspace mints `<name>homes@` (service rule: "1. Ambika" ->
  `ambikahomes@proplane.ai`, `serviceWorkspaceMailboxLocalFor`) when it is added or attached, not gated on the owner's plan;
  a failed mint is a warning on create, never a failure. An attach only MINTS: a workspace that already has an address
  keeps it, because a client's address is already on listings, in syndication posts and in the public listing payload. A
  rename moves the address only while it still follows the SERVICE rule for the old name (`mailboxLocalIsDerivedFrom`) -
  a customized one, and a self-serve `{workspace-slug}@` minted before the takeover, stay put; the old local is a 30-day
  alias, held by its WORKSPACE rather than its owner user
  ([`inbound-email-inbox.md`](inbound-email-inbox.md) § Custom work email local part); a rename that moves the address also writes the
  `admin_service_work_email` audit row. Staff with member rights (the rename standing,
  `authorizeServiceWorkEmailEdit`) change it from the Communication "Work email" card Edit icon; the write is audited
  (`admin_service_work_email`) first. Existing workspaces: `scripts/backfill-workspace-mailbox-locals.mjs --service` (dry run;
  `--apply` writes; production needs `--allow-production`) is MINT-ONLY - it fills in a workspace with no address and
  never moves one that has one, so it cannot undo the invariant above; `--rename-workspace=<workspaceId>`
  (or space-separated; repeatable, UUID required, exits non-zero on a bad value) is the explicit opt-in to move
  that one workspace onto its service-rule local.
- **Dashboard** (`/admin/dashboard`): each slow source (Stripe earnings, Subscribers, expenses, signups, feedback) has a
  9s budget (`withBudget`); a source that misses it is `null` and its card is left out, so one hung read cannot hold the
  page on Loading. The browser still gives up at 20s with a "took too long" error and Try again.

## Admin team (Oct 27: Overall admins and workspace admins)

Who can open PropLane admin, and as what. **Overall admin** = the `admin` row in `profile_roles` (`auth/admin-role.ts`): every
PropLane-wide section. **Every other role** is a PropLane-issued service seat (`account_link_invites` with `is_service_seat`) on
one or more service workspaces: the manager Team invite's roles (`TEAM_ROLE_INVITE_OPTIONS`, `Admin` reads "Workspace admin"),
houses and per-module levels. A workspace admin signs in and lands in the service shell under `/portal` (rail: only their
workspaces, no PropLane logo, no `+`); `/admin` pages redirect them there and the PropLane sidebar rows are
`adminNavRowsForViewer` (none for them). Code: `src/lib/admin-team/*`, routes `src/app/api/admin/team/*`, Settings > Admin team.

- **Who may grant what.** Only an Overall admin invites or promotes to Overall admin (decision 1). A workspace admin invites only
  into workspaces where their own seat carries member rights, never above their own role, and only houses of that workspace
  (`adminTeamGrantVerdict` + `checkAdminTeamSeatGrant`, the same `resolveServiceSeatGrant` the Team invite runs). An Overall admin
  stands as the owner of every service workspace for these verbs (`OperatorOpts.overall`, derived from the role, never a body).
- **The invite is a link, never a pending row.** `manager_invite_links.kind = 'admin'` (one use, 7 days, `invitee_email` bound,
  grant stored in `admin_grant`); the email is "You're invited to PropLane admin". `/invite/<token>` shows "Create your admin
  account" (name, mobile with the usual text code, Google or a password) or, signed in, Accept. The kind is never accepted from a
  request body (`normalizeInviteLinkKind` still falls back to `manager`), admin links are excluded from every share-link list,
  rotate, reveal and revoke, and an admin link with no bound email redeems as nothing.
- **A new account proves the inbox.** This pane owns its own mailbox proof — a 6-digit code, not the
  emailed link the generic sign-up now uses — because the redeem is bound to the address on the link and must
  prove THAT inbox inside this flow rather than wherever a verification link was opened. The
  invite page mails a 6-digit code to the address stored on the link (`/api/pro/invite-links/admin-account`, stateless HMAC
  challenge) and the server creates the confirmed account only when it verifies, stamping
  `app_metadata.admin_invite_proof = <link id>`. Five code attempts per link, across every challenge (a fresh code buys no
  fresh guesses; the limiter's longest window is a day, so the cap renews daily); then "This invite is locked - ask for a new
  one", and Resend mints a new link. Five codes may be SENT per link per hour, so the mailing itself is not a megaphone.
  The redeem requires that stamp of any account created after the invite, or a Google/Apple
  identity whose own verified email IS the bound address (`identities[].identity_data.email`, `email_verified`; the providers
  list alone proves nothing). An account that pre-dates the invite signs in as itself, but its email must be confirmed.
  Residual: an attacker who pre-registered AND confirmed the invitee's address before any invite existed still holds that login.
- **Invites are rate limited and cleaned.** 20 invites + resends per hour per inviter (`admin-team-invite:<user>`); the inviter's
  profile name in the email loses URLs and angle brackets and is cut to 60 characters (`sanitizeInviterName`).
- **Change never seats a stranger.** `changeAdminTeamMember` works only on someone who already holds an Overall role or a
  PropLane-issued seat inside the actor's reach (otherwise 404, "Invite them instead"); a seat the workspace's own owner issued
  (not `is_service_seat`) is refused, never converted.
- **A demotion or removal is ONE transaction** (`demote_admin_team_role`, migration `20261030145100`). Under the exclusive
  account-lifecycle advisory lock it re-checks the actor, re-derives durable ownership of every named workspace and property
  from the database, and compares the caller's seat set against what is actually stored: stale seat or property context answers
  `stale` and nothing moves, so the Overall role is never deleted against a plan that has since drifted. Do not reintroduce a
  validate-then-delete sequence in application code. The `p_plan` it takes is the server's own normalized grant, never a request
  body. A `p_check_only` retry succeeds only if the requested final state already exists, and writes no audit row.
- **The audit row says what happened.** Written `applied: false` before the change, stamped `applied: true` after it took
  effect and `applied: false` (+ `error`) on every refused or handed-back path, the redeem undo included.
- **Redeem** (`applyAdminInviteGrant`): the session's confirmed email must equal the bound one; the inviter is re-derived at that
  moment (still an Overall admin for an Overall grant; still able to make the workspace grant); the audit row (`admin_team_grant`,
  `admin_team_seat`) is written BEFORE the role; any failure hands the spent use back. Every change writes `admin_team_*` audit rows
  first and is refused without them. `admin_team_grants` (server-only, RLS on, no client grants) is the list/trail row.
- **Last Overall admin** cannot be removed or demoted (`lastOverallAdminVerdict`). An admin that comes from the primary-admin
  email is never removed by this pane (founders@ keeps admin, Oct 27); legacy `profiles.role` does not grant admin.
- **Routes** (`/api/admin/team`, `/invite`, `/change`, `/resend`, `/remove`) gate on `requireAdminTeamActor` (Overall admin or a seat
  with member rights; the verbs re-check every target). Every PropLane-wide `/api/admin/*` route keeps `requireAdminRoute()`, so a
  seat holder gets 403 there.
- **Settings** is one page with a scope dropdown (`SettingsScopeSwitcher`): PropLane (Overall admins: Profile, Preferences,
  Login & security, Admin team, Feedback, Account) and each workspace the viewer can open (that workspace's manager panes).
  Switching runs the authorized open (cookie) and stays in Settings.

## Managed by PropLane (Accounts > Managers, Oct 27)

Accounts > Managers > row ⋯ has **Managed by PropLane...** between Copy PropLane ID and Disable (hidden when the account has no
owned workspace left that is neither `is_service` nor archived: `unmanagedWorkspaceCount`). It opens
`ManagedByProplaneSheet` (the Add-property pop-up frame): the account's workspaces, City, Management fee, and the owner's role
fixed at **Property owner (view-only)** (the owner owns the workspace, so they are its owner of record by ownership and no
membership row is written for them). A workspace row on the account record opens the same sheet on that one workspace
(`initialWorkspaceId`, ignored when it is not one of the account's unmanaged workspaces —
[`admin-accounts.md`](admin-accounts.md) § Money actions and workspace rows).

- Verbs `account-workspaces` and `manage-by-proplane` on `/api/admin/service-workspaces` (`requireAdminRoute()` first;
  `src/lib/service/managed-by-proplane.server.ts`). A body id only NAMES a row: the account's workspaces and houses are re-read
  from the database, each id must be one of that account's own active, unmanaged workspaces, and any failed read refuses with
  nothing written. The service owner's own account is refused.
- **Choose workspaces** = `attachWorkspaceToService` once per workspace (audit first, never moves `owner_user_id`), then the fee
  through `setServiceWorkspaceFee` (audited). It stops at the first refusal and says how many were attached before it.
- **Combine all into one** = the OTHER workspaces' houses move into the chosen target through the
  `combine_portal_workspaces` RPC (`20261027030000_portal_workspaces_archived_combine.sql`), ONE transaction that changes only
  `manager_property_records.workspace_id` (never an owner, lease, charge or application) and then archives the emptied
  workspaces, and the target is attached AFTER that move. One `admin_service_combine_move` audit row per source (the houses it
  holds) is written BEFORE the move and the attach, then stamped applied or not. The move goes first on purpose: a refused move
  leaves every workspace unmanaged and still listed, so the same combine can simply be tried again (the sheet lists only
  unmanaged workspaces, and an already-managed one is refused by name). An owner's default workspace is where a house with no
  workspace lands, so an emptied default one is kept listed rather than archived. Teammates' seats on an emptied workspace stay
  pinned to it.
- **Archived** = `portal_workspaces.archived_at`. `loadWorkspaces` leaves an archived workspace out (and reads without the
  column when the database has not run the migration, `src/lib/workspaces/archived.ts`). Reversible: clear `archived_at`.
- **Owner of record in Team**: a platform admin edits the owner's role and houses like a teammate (`team-access`, audited with
  `ownerOfRecord: true`); `is_owner_of_record` is never touched by that verb. Role Owner is re-stamped server-side (every house,
  owner keys only); any other role stops the derived view-only reach, and the managed read-only lock (every accepted
  `property_owner` seat) no longer applies to that seat.
- **New workspace** sheet: Owner's role is fixed at Property owner; the server refuses any other `ownerRole` before creating
  anything. Owner email invites exactly as the Team Owner role does (existing account: pending membership + notice; new email:
  one-use link bound to that email).
