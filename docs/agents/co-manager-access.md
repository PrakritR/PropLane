> Moved out of AGENTS.md to keep every-session context lean. This file is the
> source of truth for its area — READ IT BEFORE changing code in this area.

# Co-manager access (module scoping + granular levels)

**A co-manager link grants nothing until a module is granted.** Assignment is
NOT the grant: an accepted `account_link_invites` row whose per-property
permissions entry is absent or `{}` confers **no access**. Grants are
per-property, per module, and carry LEVELS: legacy `true` = read+edit+delete;
the granular form is `{ read, edit, delete }` (`edit`/`delete` imply `read`).
Model + level helpers live in `src/lib/co-manager-permissions.ts`
(`hasCoManagerPermissionLevel[ForProperty]`).

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

**Co-manager linking is a PAID capability, on both sides.**
`POST /api/pro/account-links` refuses with 403 unless the inviter AND the invitee
are each on Pro or Business (`managerPlanAllowsCoManagerInvites`, which counts the
signup trial). That is checked before the per-tier link cap, so a Free account
gets "upgrade" rather than "at your limit".

When a manager drops to Free, access must not outlive the plan:
`disconnectCoManagerLinksForPlanDowngrade`
(`co-manager-plan-reconcile.server.ts`) cancels every `manager` link they
participate in — inviter or invitee — and deletes the matching relationship rows.
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
(`fetchLeasesForManagerUser` etc.). Write enforcement goes through
`assertCoManagerModuleAccess(..., { level: "edit" })`
(`src/lib/auth/co-manager-access.ts`) — bills POST is the exemplar. Filing a
lease under a property is the per-property equivalent
(`managerMayFileLeaseUnderProperty`, `leases` at EDIT); see
[`lease-generation.md`](lease-generation.md).

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
is refused rather than stored unattributed. Coverage:
`tests/unit/link-resident-on-application-submit.test.ts`,
`tests/unit/guest-application-upsert.test.ts`.

**Hard-won gotcha:** the account-links API selects BOTH
`property_co_manager_permissions` and legacy `co_manager_permissions`; a 2026-06
migration RENAMED the legacy column away, so every select errored and the panel
silently fell back to localStorage-only mode ("Save link (local)") — that was
the entire "co-manager does nothing" bug. `20260716120000` restores the column.
The panel now defaults to remote mode and only downgrades on a confirmed
missing table (`migrationRequired`), never on transient errors.

**Work numbers and Communication.** Every manager account that clears the plan
check provisions its **own** PropLane number and its **own** `assist-…@`
assistant address — a pure co-manager included, inheriting plan eligibility from
an inviter. Product-sent SMS *for a house* still goes from the house owner's
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

**Payouts never guess an owner.** `resolveStripePayoutContext`
(`src/lib/auth/manager-stripe-payout-access.server.ts`) decides whose
`stripe_connect_account_id` `/api/stripe/connect/{status,onboard}` acts on, so every
uncertain answer is a refusal rather than a default: a failed property-count or
link read returns `unresolvedReason: "lookup_failed"` (it used to read as "owns
nothing", which re-classified an owner as somebody's co-manager mid-outage), and a
co-manager accepted by TWO owners returns `"ambiguous_owner"` instead of the first row
of an unordered query. A manager with no listings and no accepted link still resolves to
their OWN account, so a brand-new account can onboard. Clearing a stale Connect id on
the status route needs `canEditBankAccount`, because it rewrites the owner's profile.

A refused status answers `{ error }` and nothing else, so the client reads that body only
AFTER the `!res.ok` guard: reading `canEditBankAccount` first resolved `undefined !== false`
to `true` and left the bank control enabled while discarding the only sentence that says
why it cannot work. Coverage: `tests/unit/manager-stripe-payout-context.test.ts`,
`tests/unit/manager-payment-setup-refusal.test.tsx`.
