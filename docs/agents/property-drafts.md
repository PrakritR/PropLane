# Property drafts (save add-property progress)

Moved out of the root `AGENTS.md` to keep it loadable; this is the
authoritative copy. Read it before changing code in this area.

## Property drafts (save add-property progress)

A manager can save an in-progress "add property" wizard and finish it later. This
is a `"draft"` value on the existing `ManagerPropertyRecordStatus`
(`src/lib/persisted-property-records.ts`) — **NOT** a parallel drafts store, and
**NOT** `"unlisted"` (which means a previously-live listing the manager took
*down*; a draft has never been published). Key invariants:

- **Drafts never reach a prospect surface.** They have `status = "draft"` (never
  `"live"`) and no `property_data`, so `getPublicListings()`
  (`src/lib/public-listings.server.ts`, filters `status = "live"`) and the browse
  /search components exclude them with zero extra code. The record's RLS
  `select_own` policy keeps a draft private to its owner; co-managers never see
  another manager's drafts (they carry no linked-property grant).
- **Storage = the existing side-bucket pattern.** A draft is an `AdminPropertyRow`
  (carrying the full `submission` for resume) in a new `drafts` side bucket
  (`PropertyPipelineSnapshot`, `SideBuckets`, `AdminPropertyBucketIndex` 5). Save
  /publish/delete live in `demo-admin-property-inventory.ts`
  (`saveManagerPropertyDraftToServer` / `publishManagerPropertyDraftToServer` /
  `deleteManagerPropertyDraft`).
- **The draft's record id IS the eventual live `mgr-…` listing id.** Publishing
  (final "Submit listing") re-upserts the SAME id `draft → live` and drops it
  from the drafts bucket — no orphaned duplicate. A brand-new wizard that was
  closed mid-way also publishes-in-place via the remembered id (`draftIdRef`
  in `manager-add-listing-form.tsx`), never a second row.
- **That id is therefore a permanent public URL, so it is never minted from a
  blank name.** A save made before the manager typed a property name gets a
  neutral `mgr-listing-<rand>` id flagged `draftIdProvisional`, never a
  blank-slug `mgr---<rand>`. The first later save *in the same wizard session*
  re-keys it to the real `mgr-<building>-<unit>-<rand>` id — **write before
  delete**: the re-keyed row is upserted first and only then is the superseded
  row deleted, so a failed save can never leave the draft with *no* server
  record. If that delete fails the stale row deliberately stays visible in the
  Drafts list so the manager can remove it; a short-lived duplicate draft is the
  only tolerated intermediate state, never a missing one. A **resumed** draft
  keeps its id (`allowIdUpgrade: false`) — re-keying it would change the drafts
  table row key and unmount the open editor. Publishing is always in place, so
  the one-record invariant holds either way. Unnamed drafts render as "Untitled
  draft" in the list.
- **Closing the wizard also saves — there is no "Save draft" button.** Every
  close affordance (footer Close, header ✕, backdrop click) routes through
  `closeWizard` in `manager-add-listing-form.tsx`, which flushes any unsaved
  edits as a draft and only then calls `onClose`. While the wizard stays open,
  **background autosave** debounces (`LISTING_DRAFT_AUTOSAVE_DEBOUNCE_MS` in
  `manager-listing-draft-autosave.ts`) and persists in-progress work to Drafts
  without closing. Two guards make implicit save safe to leave: an UNTOUCHED
  wizard closes without writing anything (the baseline fingerprint captured on
  first render, `manager-listing-draft-autosave.ts`, compares the whole
  submission rather than an allowlist of fields, so a field added to the wizard
  tomorrow is covered), and every EDIT mode (pending / live listing /
  request-change / `preview` scope) is excluded, because those rows are already
  persisted elsewhere and drafting one would fork it. A failed draft write leaves
  the wizard OPEN with the work intact rather than closing on a lie. Coverage:
  `tests/unit/listing-wizard-draft-autosave.test.tsx` drives the real component
  through the real save path.
- **Draft saving is unvalidated** (partial-friendly, on every step) and does NOT
  count toward the plan property limit; **publishing** runs full validation +
  the limit gate like any new listing — so the wizard's `skuTier`/`skuLoaded`
  come from the one `/api/manager/subscription` load in `manager-properties.tsx`
  (a null tier reads as "no limit", so Continue editing waits for `skuLoaded`).
  Saving also persists the wizard position (`draftStepIndex` /
  `draftMaxStepReached`) so resuming reopens on the saved step with the earlier
  chips unlocked. The list surface is the "Drafts" stage in `MANAGER_STAGES`
  (`manager-house-properties-panel.tsx`) with Continue editing / Delete draft.
  Migration: `…_manager_property_records_draft_status.sql` adds `'draft'` to the
  status CHECK.
- **The wizard is the only editor of a draft.** The drafts row (bucket 5) hides
  every detail panel that persists through `houseSaveTarget` (House details,
  Application questions, Lease) — a draft is absent from the extras catalog, so
  those panels would resolve to `{mode: "listing"}` and their save would mirror
  the record `status: "live"`. **Unlisted rows (bucket 3) hide the same three
  panels for the same reason**: `unlistManagerListing` calls
  `removeExtraListing`, so an unlisted listing is likewise absent from the live
  catalog and saving one used to silently re-list it. Relist it to edit it.
  `updateExtraListingFromSubmission` (the local-store path) refuses an id it
  cannot find in the live catalog (searching every owner's key, so co-managed
  listings still save), which is the backstop for that whole class of "edit a
  non-live row into the public catalog" bug.
  **Its server twin is deliberately NOT a pure mirror of that rule.**
  `updateExtraListingFromSubmissionOnServer` — what
  `persistManagerListingSubmissionOnServer` calls for a `listing` save — upserts
  a `status: "live"` record when the id is in NO owner's local catalog, because a
  co-manager's browser legitimately has never loaded the owner's listing into
  that store. `resolvePropertySaveTargetById` is what keeps that narrow: an id
  reaches the `listing` mode only from a local catalog entry or from
  `collectLinkedPropertyIds(managerUserId)` — an accepted co-manager link — so an
  arbitrary id still resolves to no save target at all, and the route's own
  ownership and plan-quota gates still run on the upsert.
- **Deleting a draft reclaims its uploads.** `deleteManagerPropertyDraft` is
  async: it awaits the server delete and reports success only when the row is
  really gone (a failed delete leaves the draft visible instead of letting it
  reappear on the next sync), then removes the submission's `listing-photos`
  objects via `deleteSubmissionMediaObjects`
  (`src/lib/listing-media-storage.ts`). **A record does not own its uploads
  exclusively** — an object's URL lives on the submission, so the two draft rows
  a partially-failed re-key leaves behind reference the *same* bucket objects.
  `deleteSubmissionMediaObjects` therefore takes every surviving submission
  (`survivingSubmissions`: the other side-bucket rows, the live catalog and the
  pending queue) and skips any path still referenced; deleting the leftover
  duplicate must never strip the surviving draft's photos. Draft *count* is
  deliberately uncapped.
