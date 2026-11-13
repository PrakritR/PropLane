# Resident ratings

> Source of truth for manager-to-resident star ratings. READ IT BEFORE changing
> `src/lib/resident-ratings/`, the Rate sheet, the ratings card or the resident's
> Ratings section.

Captain's spec (Nov 12, 2026), after PadSplit: a manager who has housed someone
rates them from the resident's record with 1-5 stars and an optional written
review. Future managers see it when that person applies, with the rating.

## What a rating is

`public.resident_ratings` (migration `20261112160000_resident_ratings.sql`, dev
first, then the promote rungs): `resident_user_id`, `rater_user_id`,
`workspace_id`, `residency_ref`, `house_city`, `stars` 1-5, `review` (max 1000),
`resident_response` (max 500) + `response_at`, `disputed_at` +
`dispute_resolved_at`, timestamps. **Unique on `(residency_ref, workspace_id)`:
one rating per residency per workspace.** `residency_ref` is the stay's
application record id (the lease or booking hangs off it).

RLS is on, there is no policy, and every privilege is revoked from `anon` and
`authenticated`. Nothing in the browser reads or writes the table: only
`ratings.server.ts` does, behind the routes below. The table is in the
credential-table list of `tests/unit/role-grant-surface.test.ts`.

## Who may rate (server-derived, never from the body)

`saveManagerRating` takes `{ stars, review }` and nothing else from the request.
The application id is a path segment authorized against the record
(`managerCanAccessApplicationRecord`, then the house re-derived from the stored
row without the record's frozen `manager_user_id`, as the housemates route does).

- **Real residency in the rater's workspace**, `assessResidency`: an approved,
  not withdrawn application AND an executed lease on that house (read from
  `portal_lease_pipeline_records`, `leaseIsFullyExecuted`), or a manager-onboarded
  tenant (`manuallyAdded`), or an approved guest booking (`bookingResidency`).
  Current or ended both count; a move-in date still ahead does not. An approved
  application alone is not a stay.
- **The rater edits Residents on that house**: `managerHasCoManagerPermissionForProperty(
  …, "residents", "edit", { strict: true })`. A direct owner passes; a Viewer seat
  (read only) and a Leasing seat (Residents at view) do not. A platform admin
  reading as oversight cannot rate.
- **The resident is the account the record is proven to belong to**:
  `row_data.residentUserId` counts only when that profile's email is the
  record's email (the field is writable by the record's manager, so on its own
  it is a claim). A record with no proven account cannot be rated and shows no
  ratings.
- **One per residency.** A second save by the rater edits the row (the resident's
  response survives). A teammate cannot overwrite it; the house owner can, and an
  authorized rater can take over a rating whose rater's login was deleted. A
  concurrent insert loses to the unique index with a 409.

## What a future manager sees

`GET /api/manager-applications/<id>/ratings` -> `loadManagerRatingsView`, drawn by
`ManagerResidentRatingsSection` (a "Ratings" card on the record's Overview and
Application tabs): average, count, then per rating the stars, review, month and
year, the **house city only**, the resident's response, and **"Disputed by
resident"** while a dispute is open. Plain facts with a star glyph, no pills.

It answers only for (a) an application the person **submitted** to that manager's
workspace (`isSubmittedApplicantRow`: not manager-entered, not an SMS placeholder,
not an unfinished draft, not withdrawn, a real application on file) and (b) this
workspace's own residents (a real residency). The payload is an allowlist
(`toManagerFacingRating`): never the rater, the workspace, the other house's name or
address, an id, or the resident's email. `own` marks the viewer's own workspace's
rating so the Rate sheet can edit it. A rater who is later deleted
(`rater_user_id` nulled) leaves the rating in place; nobody is ever shown who rated,
so it reads as "A previous manager" by construction.

## The resident's side

Profile (Settings) -> **Ratings** (`ResidentRatingsSettings`, hidden while there are
none): stars, review, month and year, city. Per rating:

- **Respond / Edit response**: one public response, max 500, `PUT
  /api/resident/ratings/<id>/response`; shown beside the review to future managers.
  An empty response clears it. Ownership is the session (`resident_user_id = auth.uid()`).
- **Dispute**: `POST /api/resident/ratings/<id>/dispute` opens a thread in the shared
  admin inbox (`deliverPortalMessageToAdminSharedInbox`, no email or text is sent),
  then marks the rating disputed. Idempotent while open; the thread goes first so a
  rating is never marked disputed with nobody told. Staff close it with
  `POST /api/admin/resident-ratings/<id>/resolve` (`{ action: "keep" | "remove" }`,
  `requireAdminRoute`). There is no admin screen for it yet.

## Purge

Classified in `account-purge-manifest.ts`: the **resident's** deletion deletes every
rating about them (`ids: resident_user_id`, FK cascade); the **rater's** deletion
keeps the rating and nulls `rater_user_id` (`detachIds`, FK set null), because the
row is the resident's record and no reader ever sees who rated.

## FCRA / Washington tenant-screening: NEEDS COUNSEL REVIEW

These are safeguards in code, not legal sign-off. Counsel must review before live
rollout:

1. **Disclosure.** The applicant-screening disclosure (`FCRA_DISCLOSURE_TEXT`) now
   carries one line, `RATINGS_DISCLOSURE_LINE`: "Managers you apply to can see
   ratings from your past PropLane stays." The version was bumped
   (`2026-11-12.1`). It is shown only where an applicant authorizes screening
   (pre-apply gate, applicant card); a listing that requires no check shows no
   disclosure, so counsel should decide whether the line also belongs on the
   application itself.
2. **Is PropLane a consumer reporting agency?** Assembling and furnishing
   third-party-sourced ratings to landlords for rental decisions may be CRA activity.
   The dispute path and "Disputed by resident" label are the minimum; accuracy,
   reinvestigation timing and adverse-action duties are counsel's call.
3. **Adverse action.** The decline question built for screening
   (`adverse-action-decline.tsx`, `application_adverse_actions`) is gated on a
   completed Checkr report and stores `based_on_report`. It does not yet cover "based
   on screening **or ratings**": extending it means changing the gate, the stored
   answer and the notice copy, not a label. Not done here.
4. A manager who reads ratings and declines should be able to say so the same way;
   until the question covers ratings, nothing records that a decline relied on one.

## Known limits

- A rating needs the resident's PropLane account (the record's proven account). A
  manager-entered resident with no login yet cannot be rated; the Rate sheet says why.
- Record `row_data` is manager-writable, so a manager who forges both an email and a
  matching account id on a record they own could open ratings for that person. The
  profile-email binding narrows it; closing it fully needs the application's
  submitter id stored server-side, not in `row_data`.

## Tests

`tests/unit/resident-ratings.test.ts` (permission, one per residency, future-manager
visibility and no identity leak, response and dispute, purge classification, RLS
and grants, surfaces), plus `account-purge-coverage.test.ts` and
`role-grant-surface.test.ts`.
