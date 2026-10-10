> Moved out of AGENTS.md to keep every-session context lean. This file is the
> source of truth for its area — READ IT BEFORE changing code in this area.

# Co-manager access (module scoping + granular levels)

**A co-manager never has a work number of their own.** The workspace's one
number is the owner's; a co-manager sends and reads on it within their inbox
grant. See `docs/agents/sms-system.md` "One work number per WORKSPACE".

**A membership is one row per (owner, manager, WORKSPACE).** Since
`20260920180000_workspace_memberships.sql`, `account_link_invites` is unique
per pair per workspace (`account_link_invites_unique_active_pair_ws`), every
row carries `workspace_id`, a `team_role`, and a `house_scope`:

- `all` — every house in the workspace, now and later. The database keeps
  `assigned_property_ids` current: `sync_workspace_membership_houses` on the
  row's own write, `propagate_workspace_houses_to_memberships` when a house
  joins, leaves or changes hands on `manager_property_records`. A house that
  joined after the row was written has no per-house map entry yet;
  `readPropertyPermissionsFromRow` fills an EMPTY entry from the row's flat
  `co_manager_permissions` (the role stamp) on an `all` row only. Every
  reader must select `house_scope` (`INVITE_PERMISSION_COLUMNS`).
- `selected` — the listed houses. A house that leaves the workspace is pruned
  from the row and its map by the same trigger.

The same person can be Admin in one workspace and Viewer in another; removing
them from one workspace (`PATCH … action: revoke`) touches that row only.
Pure rules live in `src/lib/workspaces/membership.ts`; server lookups
(`actorWorkspaceStanding`, `workspaceAdminCount`, `previewHouseMove`) in
`membership.server.ts`. Coverage: `tests/unit/workspace-membership.test.ts`.

**A teammate is reached through the workspace, never with a line of their own.**
Every PropLane Assistant notice for a house goes to the owner and each teammate
granted that module on it (`notifyPropertyScopedManagersFromAgent`), in the
teammate's own Assistant, texted from the OWNER's work number and billed to the
OWNER, emailed from the workspace work email. The Team chat is the workspace's
membership (owner plus accepted, non-property-owner rows for THAT workspace,
regardless of house; a Viewer reads only), `account_link_invites.workspace_id`
being the source, and a property owner is never a member. With no workspace to
resolve (an unplaced work number, or a failed default-workspace read) the roster
is the OWNER ALONE — an empty workspace id used to mean "no filter", which
admitted every workspace's teammates to the chat the line lands in.
Coverage: `tests/unit/work-number-notices.test.ts`,
`tests/unit/team-chat-workspace.test.ts`.

**Workspace rights follow the role, never a per-link flag.** Owner and
**Admin** (new; `full` is the legacy stamp and lists as Admin) invite, edit and
remove members and add or move houses in THAT workspace; Property manager may
add houses; every other role acts only inside its modules
(`workspaceRightsForRole`). An Admin may stamp up to Admin, never touch the
owner, and never remove or demote the last Admin (`canActOnMember`,
`roleAssignableBy`). A delegate whose own membership is `selected` cannot mint
an `all` link either: `mintInviteLink` caps the houses to the ones they hold
AND stores the link as `selected`, because an `all` row would auto-fill a
house that joins later from the role stamp with no cap re-applied
(`tests/unit/mint-invite-link-delegate-house-cap.test.ts`). Editing a membership
is capped the same way: `PATCH /api/pro/account-links/[inviteId]` re-applies the
module cap (`capTeamInvitePermissionsForDelegate`) over every house the write
leaves behind (the ones already on the row as much as the ones it adds, since
restamping a role rewrites the map for all of them) and refuses (403) a house
the delegate's own membership does not reach
(`tests/unit/property-owner-selected-houses-only.test.ts`). The pre-migration
on-by-default flags were moved to `legacy_workspace_permissions` and shown to
the owner as a review note on the member row; the next save clears them.
`workspace_permissions` survives only on a Custom row.
`resolveCreateListingOwner` reads the membership OF THE TARGET WORKSPACE; a
membership elsewhere grants nothing there.

**The team is shown per workspace, never as its own list.** Settings →
Workspaces renders "Members" inside every workspace card the viewer runs (their
own, and any where they are Admin): the owner, each membership row of that
workspace with Role · Houses ("All houses" / "3 of 10 houses") · Joined, that
card's pending invites, and that card's Invite. Row actions are **Edit** (the
member sheet: role, house scope, houses, Custom grid, "Also in") and **Remove
from <workspace>**. `ProAccountLinksPanel`'s `renderWorkspaces` owns this on
Settings → Workspaces (`/portal/profile?tab=workspaces`); there is no standalone
Teams page. Moving a house asks the server (`move-preview`) who loses, keeps and
gains it and says so before the click; an Admin may move between workspaces they
administer.

**A co-manager link grants nothing until a module is granted.** Assignment is
NOT the grant: an accepted `account_link_invites` row whose per-property
permissions entry is absent or `{}` confers **no access** (an `all` row's
empty entry is filled from its stamp, see above). Grants are
per-property, per module, and carry LEVELS: legacy `true` = read+edit+delete;
the granular form is `{ read, edit, delete }` (`edit`/`delete` imply `read`).
Model + level helpers live in `src/lib/co-manager-permissions.ts`
(`hasCoManagerPermissionLevel[ForProperty]`).

**Team role is a stamp + a label, never authorization.** The invite sheet's
one access control sets Role and Houses (All houses in this workspace, the
default, or Only selected) and shows a read-only "Role can" table; the
13-module grid appears only on Custom. Roles: Property owner, Viewer, Leasing,
Property manager, Bookkeeper, Maintenance, Admin, Custom
(`TEAM_ROLE_INVITE_OPTIONS`). Property owner is the one role the Houses select
offers no "All houses" for (§ Property owner).
A named role writes the permission map; Custom keeps the current map. Gates
still read `property_co_manager_permissions`. A forged `teamRole: "admin"`
with an empty map grants nothing. Catalog: `src/lib/co-manager-team-roles.ts`.
Column: `account_link_invites.team_role` (copied from
`manager_invite_links.team_role` on redeem, with `house_scope`).

**Shareable invite links do not need a PropLane ID.** Houses default to every
house currently in the workspace. See `docs/agents/send-message-compose.md`
for how Send resolves a channel. The accept screen is titled **Invite to
workspace**, names the workspace, and offers Message the inviter.

**The invite sheet (`workspace-invite-sheet.tsx`) is the one manager invite
surface** — opened by `ProAccountLinksPanel.openLinkModal`, no separate
chooser step or "Continue" page. It is ONE view, the same width and field kit
as the member sheet's "Edit permissions" (`max-w-2xl`): a recipient field,
then Role (`CoManagerRoleSelect`) and Houses (`HouseScopeSelect`) — the same
components the member sheet uses, exported from `pro-account-links-panel.tsx`
— then the effective grant (`RoleCanTable` for a named role, the full
`CoManagerPermissionsEditor` + `WorkspaceGrantFields` for Custom). It holds
exactly one active manager link per workspace, but **opening the sheet and
changing Role or Houses never mint anything**: on open it only READS the
workspace's active link (`GET /api/pro/invite-links?workspaceId=`) to hydrate
Role, Houses, and (for Custom) the workspace-level grant, and changing any of
those only updates local state. Minting happens ONLY when an action is
pressed. "Copy invite link" always mints a NEW link with `replaceActive: false`
(the earlier link keeps its own terms), copies it and closes the sheet; the
link then lists under Invite links. Send goes through
`resolveLinkForCurrentTerms`: when the on-screen terms still match the held
link, it reuses that link's URL (revealing it if not already in hand);
otherwise it mints a fresh one with `replaceActive: true` so a URL already
sent can never gain more power than whoever holds it agreed to, and the
previous link is revoked in the same call (`mintInviteLink`,
`docs/agents/co-manager-access.md` "Mint stores a hash..." above). The reveal
call is `POST /api/pro/invite-links/[linkId]/link` with no body, which
**reveals** the stored ciphertext rather than rotating (rotate is the
separate `{ rotate: true }` call two sections below).
Pressing "Invite link" does not copy or navigate anywhere — it resolves the
URL through `resolveLinkForCurrentTerms` and an inline link box appears
UNDER the form (`linkUrl && termsMatchHeldLink`): the read-only URL, a "This
link joins as <role> · <reach>" line, and Copy (a `PortalIconAction` icon,
per the icon-chrome rule) / Share in the box's own header. The box is gated
on the SAME terms comparison the mint/reuse decision uses, so the moment Role
or Houses changes after a link was shown, the box disappears and is replaced
by one line — "Access changed — press Invite link again for a link with
these terms." — rather than leaving a URL on screen that no longer describes
what pressing Send would hand out.
Sending by email goes out through the manager directory message path
(`deliverManagerDirectoryMessage`) with the auto-formatted body from
`formatInviteMessageBody`; that path only ever resolves an existing account or
an email address, so phone instead texts straight from the manager's own work
number (`POST /api/pro/invite-links/send-sms`, the same
`sendFromManagerWorkNumber` transport `record-share-link/send` and
`send-lead-invite` use for an ad hoc phone recipient) and fails with the real
reason (most commonly no work number provisioned yet) rather than pretending
to send. The client sends only `linkId`, never the text: the route re-reads
the link, proves it belongs to this workspace, and composes the body itself
with `formatInviteMessageBody` — a workspace admin is not a licence to send
arbitrary text from a PropLane-owned number
(`tests/unit/invite-link-send-sms-route.test.ts`). A PropLane code recipient
instead POSTs directly to `/api/pro/account-links` as an addressed invite (no
message step) and is the ONLY one of the three that creates an
`account_link_invites` row before redemption — it alone stamps `invited_via`
("code") and `invited_at` (`20260920190000_invite_delivery.sql`). Phone and
email sends carry no such row — the invite lives entirely in the link until
redeemed — and the sheet itself no longer lists who was sent what; that stays
on the workspace card's own Members list once a link is redeemed or a pending
row exists. The old three-path chooser (`PortalInvitePaths`, "how to send it"
step) is **gone from the manager invite**; it is kept only for the vendor
invite modal (`pro-vendor-form-modal.tsx`), which still owns its own
Continue → New message flow. Coverage: `tests/unit/workspace-invite-sheet.test.tsx`.

**Transfer ownership (`transfer-ownership-dialog.tsx`)** hands the WHOLE
workspace to an accepted member — there is no per-house picking. A workspace
has exactly one owner (`portal_workspaces.owner_user_id`), so transferring it
moves every house it holds, now and any added later, opened from the member
row's ⋯ menu or the member sheet's footer (owner only, `pro-team-blocks.tsx` /
`renderDetailFooter`). It issues ONE
`POST /api/pro/workspaces/[workspaceId]/transfer-ownership`, backed by the
database routine `transfer_portal_workspace_ownership`
(`20260921000000_workspace_ownership_transfer.sql`), which atomically:
reassigns the workspace row itself, moves every house's `manager_user_id`
(the workspace-reassign-to-default and membership-propagation triggers are
held off for the call via a session-local GUC so a house's `workspace_id`
stays put instead of bouncing to the new owner's default workspace — see the
migration header), rewrites `manager_user_id` on the same related tables
`transferPropertyOwnership` rewrites per house, and rewires memberships: the
new owner's own membership row is dropped, every other member's row now
answers to the new owner (their per-house grants are untouched), and the
former owner is added back as a member under whatever role they chose to
keep — Admin, Property manager, Viewer, Custom, or **Nothing** (an empty
grant, same "empty means no access" rule as everywhere else in this file;
choosing Nothing leaves them out of the workspace entirely rather than adding
a membership row). Submit is gated on typing the workspace's name to confirm.
The **per-property** transfer (`POST /api/pro/properties/[propertyId]/transfer-ownership`,
`transferPropertyOwnership` in `src/lib/property-ownership-transfer.ts`)
still exists for its own callers; the dialog above no longer uses it.

Mint stores a hash plus encrypted ciphertext so **Copy returns the same live
URL**. Rotate is a separate action (`POST /api/pro/invite-links/[linkId]/link`
with `{ rotate: true }`). Links minted before ciphertext existed fail closed
on copy — rotate or create a new link. Redeem
(`POST /api/pro/account-links/redeem`) is compare-and-swap on
`status = pending` and `invitee_user_id is null`. The inviter still needs Pro
or Business; she can join on Free as a pure co-manager and inherit the owner's
paid modules on assigned houses. One unused open link per owner. Migration:
`20260906010000_account_link_open_invite_token.sql` plus
`20260917010000_invite_workspace.sql`.

**Co-managers may send team invites when granted Team edit.** The `teams`
module (shown as "Team" in the permissions editor) gates minting shareable
invite links, copying an active link, revoking a link, and addressed
PropLane-ID invites. Delegation is resolved in
`src/lib/auth/co-manager-team-invite.server.ts`: the link is stored under the
property owner's id, and every selected property must belong to that owner
with `teams` at **edit** on the actor's grant. The client mirrors eligibility
via `teamInviteEligiblePropertyIds` in `manager-portfolio-access.ts`. Copy on
an active link returns the same URL through `POST /api/pro/invite-links/[linkId]/link`
unless the body sets `rotate: true`. Coverage: `tests/unit/co-manager-team-invite.test.ts`
and `tests/unit/invite-link-copy-does-not-rotate.test.ts`.

**Payment setup answers to the OWNER, and a property has exactly one payee.**
Deciding what a resident owes is the owner's call, so `payments` gates create as
well as edit and delete — and the money always lands in the property owner's
account no matter who filed the charge.

- **Creating a charge used to be the one unguarded door.** Every check on
  `POST /api/portal-household-charges` keys off an EXISTING row, so an id nobody
  had seen before fell through to "it's mine": stamped with the CALLER as owner
  and whatever property the body named, with no permission read in the path. A
  co-manager with no `payments` grant could bill an owner's resident. A new
  charge (and a new recurring rent profile, which mints future charges) now
  resolves the owner of the property it NAMES, requires `payments` at **edit**
  when that owner is not the caller, and stores `manager_user_id` = that owner.
  Checking the grant on the same property whose owner is stamped is what makes
  relabeling pointless.
- **`resolvePropertyPayoutOwner`
  (`src/lib/payments/property-payout-owner.server.ts`) is the ONE answer to
  "whose bank account does this property's rent go to".** The charge writer and
  `createHouseholdChargeCheckout` both read it, so the two cannot disagree.
  Checkout used to take the destination Connect account from the charge row's own
  `manager_user_id`, which meant a co-manager-created charge paid the
  CO-MANAGER — a property had as many bank accounts as it had managers. The
  property's owner now wins whenever the property names one, so rows written
  before the create gate existed are paid correctly with no migration.
- **A failed property read is never "no owner".** Both paths refuse (503) rather
  than fall back to the caller, the same rule `resolveStripePayoutContext` uses.
  Two residual gaps, both deliberate: a charge filed under NO property (a manual
  one-off) has no owner to attribute to and stays with its author, and an
  ownerless property row (`manager_user_id` is `on delete set null`) likewise
  falls back to the row.
- **The client must ask for the level it is about to use.**
  `collectLinkedPropertyIdsForModule` takes a `level` (default `read`) — that
  default is the set a LIST may show, never the set a control may act on. The
  Add payment picker asks for `edit`; the Payments panel passes `canEditRow` /
  `canDeleteRow` predicates built from `hasLinkedPropertyModuleLevel` into
  `ManagerPaymentsLedgerPanel`, so a view-only co-manager keeps the list and
  loses Add, Edit and Delete. Coverage:
  `tests/integration/portal/co-manager-charge-create-permission.test.ts`,
  `tests/unit/household-charge-payout-follows-property-owner.test.ts`.

Linking the bank account itself was already owner-scoped: Stripe Connect
onboarding refuses a co-manager without `bankAccount` at edit and always
onboards the OWNER's account
(`src/lib/auth/co-manager-bank-account-access.ts`,
`manager-stripe-payout-access.server.ts`). **READ used to be exempt from
that grant entirely** — `assertCoManagerBankAccountAccess` passed any `read`
request unconditionally for ANY accepted co-manager, so a "Leasing"-role
co-manager (whose stamp never touches `bankAccount`) could see the owner's
full Stripe Connect readiness/balance/identity state via `GET
/api/stripe/connect/status` (which called nothing here at all before this
fix) and `GET /api/stripe/payouts/balance`. Both levels now check the real
grant through `coManagerHasOwnerBankAccountAccess`
(`manager-stripe-payout-access.server.ts`), `edit`/`delete` implying `read`
as usual. `resolveStripePayoutContext`'s `canViewBankAccount` carries this to
the client (`pro-payment-setup-modal.tsx` hides the Payouts row entirely,
rather than only disabling its edit controls, when a co-manager lacks even
`read`). Coverage: `tests/unit/co-manager-bank-account-access-gate.test.ts`,
`tests/unit/stripe-connect-status-readonly.test.ts`,
`tests/unit/manager-stripe-payout-context.test.ts`.

**Communication is granted per HOUSE, not per owner.** A Communication grant
on one house shows the conversations about that house — never the owner's
whole inbox, never their PropLane Assistant thread, never a house the
co-manager was not given, and never a conversation about no house. Moving a
house between workspaces carries its grants (the Move dialog names who keeps
access); a brand-new workspace holds no house, so nobody but the owner is in
it. One resolver decides: `src/lib/communication/conversation-visibility.server.ts`
(see `docs/agents/communication-inbox.md`). `describeCoManagerPermissions`
says so on the invite.

**Calendar shows the stay; the money needs Residents.** The Bookings /
occupancy snapshot answers with who is where and when for every house in scope,
but a viewer without `residents` at `read` on a house reads none of its
residents' money or contact: `withoutResidentFinancials`
(`src/lib/channel-calendar/property-bookings.ts`) strips the monthly rent,
security deposit, lease term, resident phone and the room's rate off every
resident-backed entry — application holds, leases, and a manager's block held
for a named resident alike. A channel stay's own nightly rate is not a
resident's money and stays. The houses that keep the figures are resolved
server-side in `occupancySnapshotForManager`, never from the request.

The snapshot's own resident payload is stripped the same way, by the same
house set: `occupancyStayResidentWithoutIdentifiers`
(`src/lib/occupancy/snapshot.ts`) also drops the resident's **contact email**
and the **record ids** (application / lease) off every stay on a house the
viewer lacks `residents` read on, because those ids are what opens the
resident's records. Who, where, when and the status label remain — that is the
calendar. Coverage: `tests/unit/occupancy-cross-tenant-plant.test.ts`,
`tests/unit/occupancy-stay-resident-identifiers.test.ts`.

**`coManagerModuleAllowed` is the ONE answer to "may this co-manager use this
module".** The server scope (`src/lib/auth/co-manager-module-scope.ts`) and the
client portfolio mirror (`src/lib/manager-portfolio-access.ts`) both delegate to
it, so the two sides cannot drift.

**Empty used to mean FULL, and that was the bug (PRP-199).** An empty map read
as "no restrictions" — every module at every level, including delete on leases,
financials and documents — and a manager reached it two ways without ever
opening the permissions editor:

- checking a property in the invite modal seeded `{}`, so check-two-properties →
  Send invite was the widest possible grant; and
- turning every level off DELETED every module key, which also produced `{}` —
  so the gesture that restricts a co-manager to nothing granted them everything.

Now: the invite modal seeds an explicit read-only grant
(`buildAllModulesGrant("read")`), the editor's empty state says "No access", and
the invite modal states the effective grant per property in words
(`describeCoManagerPermissions`) before it is sent. Full access is stored
explicitly as every module `true`. Existing links that were relying on the old
sentinel are rewritten to that explicit full grant by
`20260904150000_co_manager_permissions_explicit_grant.sql`, so no live
co-manager loses access — **that migration must be applied (`npm run db:push`)
in any environment running this code.** Coverage:
`tests/unit/co-manager-empty-permissions-deny.test.ts`.

**`assigned_property_ids` is still authorization, not a request field.** It
bounds which properties a grant can even name. Every route that sets it
validates it against real ownership
with `findPropertyIdsNotOwnedByManager`
(`src/lib/auth/co-manager-invite-scope.ts`) and rejects the whole request (403)
if any id is not the inviter's — a non-existent id counts as unowned, and a
lookup failure fails closed. This applies on `POST /api/pro/account-links` and
on the post-accept `PATCH`, where the property scope is additionally
**inviter-only** (the invitee may still edit the payout split, but widening
their own scope was a self-service takeover of any publicly-listed property id).
Coverage: `tests/unit/co-manager-invite-scope.test.ts`,
`tests/integration/portal/co-manager-invite-property-scope.test.ts`.

**Ownership is re-derived at every WRITE, and deliberately not at read.** Invites
forged before the ownership gate shipped are still pending, so the accept branch
of `PATCH /api/pro/account-links/[inviteId]` re-runs
`findPropertyIdsNotOwnedByManager` against the *inviter's* current ownership and
refuses with 403 — never a silent narrowing, since a silent partial grant is the
failure mode being closed. Do **not** add the same filter to the read path
(`collectLinkedPropertyIdsForUser`, `linkedOwnerScopeForModule`,
`getShareablePropertyForUser`, …): `transferPropertyOwnership` only rewires the
A↔B pair, so a property transferred to B leaves an unrelated co-manager C's link
naming an owner who no longer holds it. A read-time filter reads that as forgery
and silently revokes C while the co-manager card still lists the property —
"shows granted, behaves denied". Residual, accepted knowingly: an
already-accepted forged link is not re-checked at use, so the invite table must
be audited per environment before release.

**Shareable invite links (`/invite/[token]`) Join in one click.** Redeem creates
an **accepted** workspace membership, returns `workspaceId`, and the client
selects that workspace so it appears in the top-left switcher. Only the
**workspace owner** needs Pro/Business; a Free manager invitee may join and uses
the owner's plan/credits inside that workspace. An opener without a manager
portal role gets `manager_role_required` and is prompted to create a manager
account (then returned to the same invite URL).

**Direct PropLane-ID linking is a PAID capability on both sides.**
`POST /api/pro/account-links` refuses with 403 unless the inviter AND the invitee
are each on Pro or Business (`managerPlanAllowsCoManagerInvites`, which counts the
signup trial). That is checked before the per-tier link cap, so a Free account
gets "upgrade" rather than "at your limit".

Open-link invitees may stay Free: the server stamps `invitee_plan_inherited`
on the row, retaining that provenance after the one-time token hash is cleared.
Shareable `/invite/[token]` links likewise only gate the **owner** on Pro/Business;
redeem accepts in one step so the workspace appears in the invitee's switcher.
Redemption rechecks the owner's paid eligibility and compares both the current
token hash and assigned-property snapshot when claiming the row; a rotation or
scope edit during redemption requires a fresh attempt.

When a manager drops to Free, access must not outlive the plan:
`disconnectCoManagerLinksForPlanDowngrade`
(`co-manager-plan-reconcile.server.ts`) cancels every `manager` link they
participate in — inviter or invitee — and deletes the matching relationship rows.
The exception is an incoming `invitee_plan_inherited` open link whose owner
remains paid; an unreadable owner plan also does not trigger irreversible
revocation. An owner positively on Free still loses all outgoing links.
It is called from `syncManagerPurchaseTierState`, i.e. on ordinary portal reads,
and wrapped in a `try`/`catch` so a failure never blocks the read. Because
revocation is irreversible it runs ONLY on a tier positively read as free:
`getManagerPurchaseSku` reports `tier: null` both for "no committed SKU" and for
a failed read, so `readFailed` and an unresolvable tier are no-ops, never a
downgrade. Same reasoning as the property cap in
[`plan-entitlements.md`](plan-entitlements.md) — a plan that cannot be read is
never treated as Free. Coverage: `tests/unit/co-manager-plan-reconcile.test.ts`,
`tests/unit/manager-access.test.ts`.

**Server scoping** — `src/lib/auth/co-manager-module-scope.ts`:
`linkedPropertyIdsForModule` (property-keyed tables),
`linkedOwnerScopeForModule` (owner-keyed tables like the vendor directory),
`fetchRowsForManagerWithLinked` (owned+linked merge, deduped). Wired into the
GET paths of work orders, service requests, household charges, vendors, and
manager documents; leases/applications/property-records already had their own
(`fetchLeasesForManagerUser` etc.). A caller that acts on the **absence** of a
grant — a delete, like the orphan-housing sweep behind the manager Applications
GET — passes `{ strict: true }`, so a lookup that failed throws instead of
reading as "no linked properties"; the fail-open default is only for a read that
may safely narrow. Which errors legitimately mean "no links" is
`looksLikeMissingTableError` (`manager-lease-scope.ts`), matched on the
PostgREST / Postgres codes, never on the table name appearing in a message —
which also matches a permission error and a schema-cache mismatch. Coverage:
`tests/unit/co-manager-link-lookup-strict.test.ts`.

Write enforcement goes through `assertCoManagerModuleAccess(..., { level: "edit" })`
(`src/lib/auth/co-manager-access.ts`) — bills POST is the exemplar. That is the
ONE gate: it resolves through `linkedOwnerScopeForModule` → `coManagerModuleAllowed`
(so `{}` denies), and it pairs the grant with the row's owner. Never add a second
same-shaped gate beside it — the next route author picks the obvious name.

It admits a manager as "primary owner" two ways: the row owner a caller passes
in, AND a lookup of the property's own `manager_user_id`. Both are load-bearing.
`linkedOwnerScopeForModule` reads `account_link_invites` by `invitee_user_id`,
and an owner is the inviter — so without the property lookup an owner is refused
on their own house. Bills POST passes no owner on purpose (passing the caller
would make the gate a no-op) and depends on exactly that.

Routes that scope a single property without the module wrappers call
`managerHasCoManagerPermissionForProperty` (household charges, vendors,
applications, team invites). It shares the same rule — `{}` grants nothing —
so there is one semantics, not two. Coverage:
`tests/unit/co-manager-module-gate.test.ts`,
`tests/unit/co-manager-empty-grant-write-routes.test.ts`,
`tests/unit/co-manager-property-permission-primitive.test.ts`. Filing a
lease under a property is the per-property equivalent
(`managerMayFileLeaseUnderProperty`, `leases` at EDIT); see
[`lease-generation.md`](lease-generation.md).

**Active-workspace narrowing runs BESIDE module scoping, never instead of it.**
A manager's rows — owned and linked alike — are additionally filtered to the
houses the ACTIVE workspace holds, resolved server-side from the selection
cookie: the rule Communication already states as its rule (3)
([`communication-inbox.md`](communication-inbox.md)), now also on bills,
budgets, owner distributions, expenses, documents, work orders, service
requests, household charges, deposit returns, applications/residents, leases
and reports. Three resolvers, one contract: `resolveActiveWorkspaceRowScope`
with `applyWorkspaceRowScope` / `rowAllowedInWorkspaceScope`
(`src/lib/workspaces/row-scope.server.ts`) for a manager's own money and
library tables, `resolveManagerWorkspaceRowScope` with
`workspaceRowFilterClause` (`co-manager-module-scope.ts`) for the owned+linked
merge, and `activeWorkspacePropertyScope`
(`src/lib/workspaces/scope.server.ts`) for property-id lists. `null` means do
not narrow (no workspace, or the load failed — a scope that cannot be read
narrows nothing and widens nothing); an EMPTY ARRAY is a real answer, not "no
filter"; a row tied to NO house is visible only when the active workspace is
the viewer's own default. **One workspace narrows exactly like several** — the
account still reaches another owner's houses through a grant, so "a single
workspace IS the account" was a leak, not a shortcut. Where a grant and the
workspace both narrow, they compose by intersection
(`intersectPropertyScopes`, `src/lib/reports/workspace-scope.ts`), never by
one replacing the other. Coverage: `tests/unit/workspace-row-scope.test.ts`,
`tests/unit/manager-workspace-row-scope.test.ts`, plus the per-surface
`manager-*-workspace-scope` tests.

**Client mirrors** — `collectLinkedPropertyIdsForModule` /
`collectLinkedOwnerIdsForModule` / `moduleRowVisibleToPortalUser` in
`src/lib/manager-portfolio-access.ts`. Storage libs (household-charges,
manager-vendors-storage, service-requests) stay dependency-free: panels pass
the precomputed sets as OPTIONAL PARAMS (avoids the
portal-data-store↔household-charges import cycle). Copy that pattern.

**Every client visibility mirror is attribution-first, then property-scoped.**
`moduleRowVisibleToPortalUser`, `applicationVisibleToPortalUser`, and
`leaseVisibleToPortalUser` all return true immediately on
`row.managerUserId === userId`, and only fall through to the owned/linked
property sets otherwise. That ordering is load-bearing, not a shortcut: those
sets come from a module-level cache React cannot see, so a row whose property
has not hydrated yet (or an archived/unlisted own listing) is otherwise dropped
from the manager's OWN list — that race is what hid a resident's freshly
submitted application from its manager. It cannot widen a co-manager's scope,
because a linked row is attributed to the OWNER and still takes the
property-scoped path, so unlink/delete scoping stays intact. Do not "tighten"
the check by removing the attribution branch. Panels that filter with these
helpers must also depend on their portfolio tick
(`MANAGER_PORTFOLIO_REFRESH_EVENTS`) so the list re-filters once that cache
hydrates. Coverage: `tests/unit/manager-portfolio-access.test.ts`,
`tests/unit/manager-applications-cold-cache.test.tsx`.

**Attribution itself is server-derived.** `managerUserId` decides whose
Applications tab a row lands in, so no `POST /api/manager-applications` branch
takes it from the request body: applicant submits (guest and signed-in resident)
resolve it from the listing record (`resolveManagerUserIdForProperty`, shared by
`guest-application-upsert.ts` and `link-resident-on-application-submit.ts`) or
from the already-stored value on an edit, and manager/admin writes take it from
the ownership gate. A new applicant submit whose listing resolves to no manager
is refused rather than stored unattributed. Placement is server-derived the same
way, and which houses a row may NAME is owned by
[`shared-room-capacity.md`](shared-room-capacity.md) (occupancy author trust).
Coverage: `tests/unit/link-resident-on-application-submit.test.ts`,
`tests/unit/guest-application-upsert.test.ts`.

**Hard-won gotcha:** the account-links API selects BOTH
`property_co_manager_permissions` and legacy `co_manager_permissions`; a 2026-06
migration RENAMED the legacy column away, so every select errored and the panel
silently fell back to localStorage-only mode ("Save link (local)") — that was
the entire "co-manager does nothing" bug. `20260716120000` restores the column.
The panel now defaults to remote mode and only downgrades on a confirmed
missing table (`migrationRequired`), never on transient errors.

**Work numbers and Communication.** Provisioning eligibility for a manager's
own number and assistant address, including pure co-managers, is described in
[`sms-system.md`](sms-system.md#a-manager-texting-a-work-number-gets-the-ai).
Product-sent SMS *for a house* still goes from the house owner's
number; a co-manager's own number and address are how people reach **them**, and
resolve to the houses assigned to them across every owner. A co-manager with Communication
(`inbox`) on ≥1 assigned property of that owner can view those threads
(`read`), reply and send (`edit`), and delete (`delete`) in PropLane
Communication — `viewerAndLinkedOwnerIdsForModule(..., "inbox", level)`.
Communication access, like every other module, must be granted explicitly — an
empty permissions entry reaches nothing.

The SMS assistant follows the number that was texted, not the portal session:
texting their **own** work number answers about owned houses plus assigned
co-managed houses (`combined`); texting an **owner's** work number is scoped
only to that owner's assigned houses (`delegated`) and never includes the
co-manager's personally owned houses. Identity is
`resolveManagerSmsInboundIdentity` — details in
[`sms-system.md`](sms-system.md#a-manager-texting-a-work-number-gets-the-ai).

**Shareable invite links are co-manager only.** `mintInviteLink` / `redeemInviteLink`
(`src/lib/invite-links/invite-links.server.ts`) both refuse any `kind` other than
`manager`, and the redeem refusal happens **before** a use is spent. A redemption can
only ever produce an `account_link_invites` row — a table whose `tab_kind` CHECK admits
`'manager'` alone — so a "vendor" link had no honest destination: it fell through to the
same insert, carrying the link's `assigned_property_ids` and `property_permissions`, with
neither side's Pro/Business plan checked (the gate was `kind === "manager"`-guarded). The
vendor add flow therefore offers only the email invite; `PortalInviteChoiceStep` draws no
invite-link card when a surface passes no `onCreateInviteLink`. Vendors join through
`sendVendorInvite`, which binds a token to one directory row and one address.

That insert also has to set `tab_kind: "manager"` explicitly — the column is `not null`
with no default, so omitting it made every first redemption a 23502 that had already
burned the link's only use. A failed insert now hands the use back and removes the
redemption row it recorded. Coverage: `tests/unit/invite-link-redeem-behavior.test.ts`
drives the real function; the grep-based `invite-link-security.test.ts` could not see it.

**`bankAccount` is a module like any other, but it is scoped to the OWNER, not to
a property.** It is a `CO_MANAGER_PERMISSION_OPTIONS` entry granted per property
like the rest, yet a Connect account belongs to the owner's profile rather than
to one listing, so `coManagerCanEditOwnerBankAccount` asks only whether the
co-manager holds `bankAccount` at `edit` on **any** property assigned by that
owner. `assertCoManagerBankAccountAccess`
(`src/lib/auth/co-manager-bank-account-access.ts`) is the route-level wrapper:
acting on your own account is always allowed, `read` is always allowed, and only
an `edit` against someone else's account consults the grant. That same `edit`
also authorizes initiating a payout (Standard or fee-bearing Instant) and
changing the automatic payout schedule (`/api/stripe/payouts/{create,schedule}`,
and an `account_onboarding` / `account_management` embedded session), so the
module option is labelled **Bank account & payouts**
(`CO_MANAGER_PERMISSION_OPTIONS`); the balance read (`/api/stripe/payouts/balance`)
and the `notification_banner` session are `read`.

**Payouts never guess an owner.** `resolveStripePayoutContext`
(`src/lib/auth/manager-stripe-payout-access.server.ts`) decides whose
`stripe_connect_account_id` `/api/stripe/connect/{status,onboard}` acts on, so every
uncertain answer is a refusal rather than a default: a failed property-count or
link read returns `unresolvedReason: "lookup_failed"` (it used to read as "owns
nothing", which re-classified an owner as somebody's co-manager mid-outage), and a
co-manager accepted by TWO owners returns `"ambiguous_owner"` instead of the first row
of an unordered query. A manager with no listings and no accepted link still resolves to
their OWN account, so a brand-new account can onboard. Clearing a stale Connect id on
the status route needs `canEditBankAccount`, because it rewrites the owner's profile. So does
`ensureConnectAccountTransfersRequested`: despite sitting in a GET handler it PATCHes the
Connect account whenever the transfers capability has never been requested, so a read-only
co-manager loading the payments page was mutating the owner's Stripe account. That caller
now reports on the account `retrieveManagerConnectAccountOrNull` already returned.

A refused status answers `{ error }` and nothing else, so the client reads that body only
AFTER the `!res.ok` guard: reading `canEditBankAccount` first resolved `undefined !== false`
to `true` and left the bank control enabled while discarding the only sentence that says
why it cannot work. Coverage: `tests/unit/manager-stripe-payout-context.test.ts`,
`tests/unit/manager-payment-setup-refusal.test.tsx`,
`tests/unit/stripe-connect-status-readonly.test.ts`.

## Property owner

A **Property owner** is the investor who owns a house the manager runs. It is a
team role in the manager's workspace (`property_owner`, first in the Role
dropdown), not a portal: the invite, house picker and Edit permissions flow are
the ones every other role uses. Plan: `property-owner-role-1006` (lane claude-2).

**What the role is.** A stamp plus a label, with its own permission vocabulary:
four owner keys, `ownerPerformance` (Overview and Properties figures),
`ownerStatements`, `ownerDocuments` (only files marked *Shared with owners*) and
`ownerMessages` (default off). The keys are `OWNER_PERMISSION_OPTIONS`, NOT part
of `CO_MANAGER_PERMISSION_OPTIONS`, so no module loop (stamps, presets, the module
editor) can ever stamp or show one on another role. An owner holds none of the
module keys; `workspaceRightsForRole('property_owner')` is explicitly
`{ members: false, houses: false }`, so an owner cannot invite, edit or remove a
member (`tests/unit/property-owner-no-members.test.ts`).

**Writes are role-shaped.** `applyRoleToPropertyPermissions` runs on every write
path (mint link, direct invite, edit member, redeem): an owner keeps owner keys
only (a forged module grant is dropped), every other role loses any owner key.
`stampTeamRoleOnProperties` keeps the owner keys the manager set and defaults
(Messages off) only when none is set. "No access" is stored explicitly as
`{ notification: false }`, because a missing key means *unset*. The role is
never inferred from a map (`inferTeamRoleFromPermissions` skips it): an empty map
must not read as an owner.

**Owner rows are not teammate rows.** An accepted owner row looks exactly like a
teammate row to code that checks `status = 'accepted'`, so every such reader
wraps its read in `withoutOwnerLinks` (`src/lib/co-manager-team-roles.ts`) and
selects `team_role`. The filter runs on the rows, not as a query predicate, so a
legacy NULL role still passes. `tests/unit/property-owner-link-readers.test.ts`
fails a new reader that neither filters nor is reviewed on its list. The only
code that reads owner rows is `src/lib/property-owner/*`.

**Owner-only account (captain decision, plan #5).** An owner invite is redeemed
without a manager account: `redeemInviteLink` provisions a profile and the
`manager` `profile_roles` row (the property portal hosts the owner routes) and
nothing else, with no `manager_purchases` row, so no plan, workspace, Add
property or billing (`provisionOwnerOnlyAccess`). `getOwnerAccessState` decides
`ownerOnly`: owner memberships and no houses of their own, no teammate seat, no
plan, not an admin. An owner-only account:

- gets the owner shell (`OwnerPortalShell`: rail on desktop; bottom bar plus More
  sheet on a phone) from `src/app/portal/layout.tsx`, and every other `/portal/*`
  path, hard-loaded or through `renderPortalSection`, redirects to `/portal/owner`;
- is refused by every manager API: `getReportsAuthContext` and
  `requireManagerRouteUser` return no context (401), and the module readers
  exclude its rows. The menu is not the security boundary
  (`tests/unit/property-owner-reports-auth.test.ts`,
  `tests/unit/property-owner-server-exclusion.test.ts`). A route that decides a
  manager role **for itself** instead of through one of those helpers — the shape
  `/api/portal-vendors` had when it leaked shared vendor contact rows — must call
  `refuseOwnerOnly` (403) on its own. `tests/unit/owner-only-manager-routes.test.ts`
  walks `src/app/api/**` and fails a new route that neither refuses nor carries a
  reviewed `EXEMPT` reason, so that list is the enumeration — do not re-copy it here.

**Owner APIs** (`/api/owner/*`, one gate: `requireOwnerRoute`). The owner and the
manager come from the authenticated membership (`loadOwnerGrants`), read fresh on
every call, so a revoked owner is refused on the very next request. A request may
only narrow to a granted house (anything else is a 404). Output is an explicit
allowlist projection (`src/lib/property-owner/projection.ts`), checked with
`assertOwnerPayloadRedacted`: totals per house and month (rent collected and due,
other income, fees, repairs and services as ONE total, net), units, occupied, and
per-unit status, rent and lease end, with no resident, applicant, vendor, ledger
line or message field. Net equals the manager's Profitability report for the same
house and month because it is read back from the same rows
(`queryProfitability` with `groupBy: "month"`). Statements use `queryOwnerStatement`
and the formal PDF builder, without the unpaid-bills line. Documents list only
`manager_documents.shared_with_owners` files on granted houses and serve bytes
through server-minted signed URLs (a deleted OR superseded version mints
nothing). The Statements house filter is built from the Statements grant itself —
the unfiltered response's `houses` — never from the performance-scoped summary.
Months default to the PACIFIC calendar month, like every other money view. The
owner's copy of the statement PDF names the manager but carries no street
address: `manager_tax_profiles` holds a W-9 address and an address is not in the
allowlist.

Messages (when on) are the owner's own thread with the manager of their own
membership; the recipient is never taken from the request. It is TWO-WAY: because
`withoutOwnerLinks` removes the owner from every teammate source, the manager's
reply has its own allowance in `filterRecipientsBySenderScope`
(`ownerInviteeIdsForManagers` + `managerMayMessageOwner`), which holds only while
that owner's membership has Messages on for a house of that manager's. The
owner's reader takes the counterparty from `row_data.email` (the person the
thread is WITH on both copies), not from `participant_email`, which is the
owner's own address on a received row. The owner's COPY of that reply is scoped
from the membership too (`applyOwnerMessageInboxScope` →
`OWNER_MESSAGE_INBOX_SCOPE`, on both send paths): `scopeForRole` reads the
legacy singular `profiles.role`, so an owner whose account was created as a
resident would have had the reply filed in their resident inbox, where the
owner portal never looks. The re-scope runs for an `admin`-labelled sender too
— the scope belongs to the RECIPIENT, and the inviting manager of a membership
can be a multi-role account — and the membership reads behind it are memoized
per client (`loadOwnerGrantsOnce`), so the filter and the re-scope do not each
pay for `loadOwnerGrants`.

**A membership that cannot be read denies.** `getOwnerAccessState` throws
`OwnerAccessUnavailableError` rather than answering "no owner row": that answer
would hand an owner-only account the manager shell and wave it past
`refuseOwnerOnly`, which turns the error into a 503. Every manager-side caller
asks `withholdManagerSurface` instead of reading `ownerOnly`, so the error
denies (no manager context) rather than throwing into a render, and logs
`[security] owner_membership_unreadable` with the error class and the user id
so a sustained outage is not a silent 401 everywhere; the two page
shells (`src/app/portal/layout.tsx`, `renderPortalSection`) show
`PortalAccessUnavailable` — neither portal — and `requireOwnerPage` stays on the
owner page with Messages shut. The layout redirects to `/portal/owner` when it
cannot see the requested path at all.

**A delegate may not share what they cannot see.** Owner keys are not module
grants, so the module cap carries neither a check nor a value for them and both
write paths re-derive them from the request. `capOwnerKeysForDelegate` caps that
re-derive by the module each key reads from (Performance / Statements ←
Finances, Documents ← Documents, Messages ← Communication), so a co-manager with
nothing but `teams: edit` cannot hand an investor the books. The cap runs on
every write path a delegate can reach — `POST /api/pro/account-links`, the mint,
and `PATCH /api/pro/account-links/[inviteId]`, which caps the houses already on
the membership as well as the ones the write adds, because restamping a role
rewrites the map for all of them. An owner invite also never starts from
"All houses": the investor's houses are picked on purpose, and every editor
coerces the scope through `houseScopeForRoleChange` so a member switched to the
role carries their current houses over instead of saving a shape the server
refuses. The server is the one that decides: an explicit `houseScope: "all"` on
the invite POST, the mint or the PATCH is a 400 (`OWNER_SELECTED_ONLY_ERROR`), a
defaulted scope is coerced to `selected`, and an owner row with no house is a 400
(`OWNER_NEEDS_HOUSE_ERROR`). A legacy link stored as `all` redeems as `selected`
over the houses it names, or refuses when it names none.
Accepting an owner invite does not rewrite `profiles.role` — an existing
resident or vendor keeps the role their account was created as.

**The flat grant is the keys the manager set.** `readPropertyPermissionsFromRow`
falls back to the flat `co_manager_permissions` column for a house an "all
houses" row picks up later, so a Property owner's column is
`flatTeamRoleGrant` (one place, used by invite, mint redeem and edit) — the
link's own owner keys, with "No access" kept EXPLICIT as
`{ notification: false }` — never the role default, which would hand
Performance, Statements and Documents back on every new house. For an owner that
column is now display and legacy shape only: an owner row is selected-houses-only
on every write path, and `loadOwnerGrants` pins `house_scope: "selected"` so the
flat fallback never fires — a house with no per-house entry is simply not a
grant. No owner reach decision reads the flat column.

**Manager side.** Documents row ⋯ menu: *Share with owners* / *Stop sharing*
(`PATCH /api/manager-documents/[id] { sharedWithOwners }`, owner-only like every
sharing change, and only for a document with a house). The flag is read through
`loadSharedWithOwnersIds`, never `DOCUMENT_SELECT_COLUMNS`, so a database that has
not run `20261007100000_property_owner_role.sql` lists documents normally.

**Deliberate deviations (captain-approved, plan `property-owner-role-1006`).**
Do not "fix" these without asking:

- **No management fee anywhere in the owner's numbers.** The by-month table's
  **Fees** column is the *processing* fees Profitability already reports
  (`summary.ts` `processingFees` → `feesCents`), not a management fee, and
  `queryOwnerStatement` keeps `managementFee = 0`. That is what lets the owner's
  net equal the manager's Profitability net for the same house and month. A
  management-fee model has to land in Profitability first.
- **An owner invite consumes a plan link like any teammate invite.** Owner keys
  are their own vocabulary, but the row is still an `account_link_invites` row,
  so `seatCapWithAddons` counts it — there is no owner exemption from the
  per-tier link cap.
- **`POST /api/pro/account-links/redeem` is not on `refuseOwnerOnly`'s list.**
  Redeem is how an owner-only account accepts a *second* owner membership; the
  manager surfaces it would unlock are each refused on their own route.
- **Transfer ownership refuses an owner target** (409, "A Property owner can't
  take over a workspace.") in `transferWorkspaceOwnership`, before the RPC — the
  role is a read-only statements reader, never a manager.
- **A revoked owner is not an error.** `loadOwnerGrants` returns no houses on the
  next request and the shell shows *No properties are shared with you*
  (`owner-overview.tsx`), so losing the last grant reads as an empty state, not
  a lockout.
