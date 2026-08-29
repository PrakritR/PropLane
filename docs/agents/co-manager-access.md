> Moved out of AGENTS.md to keep every-session context lean. This file is the
> source of truth for its area — READ IT BEFORE changing code in this area.

# Co-manager access (module scoping + granular levels)

**A co-manager link grants module access; the permissions editor restricts it.**
An accepted `account_link_invites` row with an EMPTY permissions object grants
every module on its assigned properties (assignment IS the grant); once any
module is checked, the set becomes a restriction. Grants are per-property, per
module, and now carry LEVELS: legacy `true` = read+edit+delete; the granular
form is `{ read, edit, delete }` (`edit`/`delete` imply `read`). Model + level
helpers live in `src/lib/co-manager-permissions.ts`
(`hasCoManagerPermissionLevel[ForProperty]`).

**`assigned_property_ids` is authorization, not a request field.** Because an
empty permissions object is a FULL grant, the assigned list alone decides what a
co-manager reaches. Every route that sets it validates it against real ownership
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
