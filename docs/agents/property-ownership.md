# Property ownership & the records route

Moved out of the root `AGENTS.md` to keep it loadable; this is the
authoritative copy. Read it before changing code in this area.

## Property ownership: only Properties reads it, so drift is nearly invisible

`/portal/properties` is the ONLY manager surface scoped by
`manager_property_records.manager_user_id` (owned + accepted co-manager links,
`GET /api/property-records`). Residents, Applications, and the Communication
property filter read **denormalized** property labels off application/lease rows
(`propertyOptionsFromContacts` in `src/lib/manager-inbox-contacts.ts` builds the
house list from `manager_application_records`, never from the property record).

So a property row that changes owner takes Properties to `0 / 0 / 0` while every
other surface keeps listing the same houses — which reads as "the Properties
page is broken" or "the seed has no properties" when the data is fine and the
OWNER moved. When those surfaces disagree, diff the two sources before touching
either.

- **`POST /api/property-records` never MOVES an owned row from the request body
  — not even for an admin.** Every client posts `managerUserId` straight out of a
  browser-local pipeline bucket (`mirrorLocalPropertyPipelineToServer`,
  `mirrorAdminPropertyRecord`, `promoteLegacyPendingListingsToLive`), so honoring
  it let a stale local bucket keyed by another user id silently hand live
  listings to that account. Ownership changes have exactly one door:
  `transferPropertyOwnership` (requires an accepted co-manager link, audited,
  notifies both sides). Only a MISSING row on an UPSERT is a create, and only
  there does the body's `managerUserId` win (the admin inventory publishes on a
  manager's behalf; a non-admin naming anyone else gets 403). A **DELETE of a
  missing row is 404, refused before owner resolution — never a create.** The
  create branch has no stored owner to authorize against and only 403s a caller
  who NAMES someone else, so a delete that fell into it was unchecked, and the
  delete branch then ran `clearHousingAccessForDeletedProperty` with the
  SERVICE-ROLE client — a globally scoped helper that strips co-manager grants
  and scrubs residents' housing fields to "Moved out" across EVERY manager. That
  helper matches property ids EXACTLY for the same reason (a normalizing token
  folded one manager's id onto another's, so deleting a listing you legitimately
  own reached a victim's rows). Deliberately a 404 rather than a silent 200
  no-op; the client reads it as "already gone"
  (`deletePropertyRecordFromServer`) so the refusal cannot strand an unclearable
  local draft. A FAILED owner lookup is a 500, never an absent row — falling
  through would 404 a delete whose row is still there, which the client reports
  as success. An EXISTING row whose
  `manager_user_id` is blank — the column is `on delete set null`, so an
  OWNERLESS row is a real production state — is still an edit, not a create: an
  admin may adopt it onto a manager, and every other caller goes through the
  same co-manager gate as an owned row, so knowing a public listing id never
  adopts an orphan. The co-manager branch preserves that absence as `null` and
  never writes `""` (not a uuid — Postgres rejects the whole upsert, which
  surfaced as a 500 on an ordinary save) and never `user.id` (that would be the
  silent adoption this route was hardened against). Coverage:
  `tests/unit/property-records-owner-not-reassignable.test.ts`,
  `tests/unit/property-records-delete-missing-row.test.ts`,
  `tests/unit/clear-property-housing-access-exact-id-match.test.ts`.
- **Portal record share links resolve an OWNERLESS row's owner through the property
  record.** A lease / application row whose own `manager_user_id` is blank still has to
  name a portfolio for the share link to be stored and scoped under, so
  `resolveLeaseRecordOwnerUserId` / `resolveApplicationRecordOwnerUserId`
  (`src/lib/portal-record-share-authorize.server.ts`) fall back to
  `manager_property_records.manager_user_id` for the row's property, and
  `loadSharedLeasePayload` / the application payload re-derive the SAME answer and refuse
  the read unless it matches the token's stored owner. Consequence of the drift above: if
  that property later changes owner, outstanding share links for the record 404 ("Lease not
  found.") rather than serving the previous owner's copy — the link has to be re-minted.
- **The seed reclaims drifted owners before anything else reads ownership.**
  `tests/helpers/reclaim-canonical-property-owners.mjs` (called from
  `seed-test-db.mjs`, also runnable as `npm run test:seed:reclaim-properties`)
  is not the only writer — the canonical catalog upsert earlier in the seed also
  rewrites `manager_user_id` for those ids — but it is the only step that
  *verifies*: it re-reads after writing and throws if a row is still mis-owned,
  and it runs before the account prune, which deletes property rows BY stray
  owner (a canonical id still mis-owned at prune time is deleted rather than
  reclaimed). Every other cleanup check scopes
  `.in("manager_user_id", testManagerIds)` and therefore cannot see a canonical
  id parked on a stranger's account at all. Standalone, it always reclaims to
  the canonical demo manager and refuses to run when `E2E_MANAGER_EMAIL` names
  a different account.
