# Lease generation — agent notes

The lease-generation spec lives in `leases/`:

| File | What it is |
| --- | --- |
| `leases/lease-generation-manifest.json` | Master data manifest — document blueprint, merge fields, derived fields, fee validators. The spec. |
| `leases/disclosure-clause-rules.json` | The rules catalog. `trigger_field_dictionary` names every input a rule may read; each rule's `trigger_logic.field` refers to one of those names. |
| `leases/seattle/`, `leases/san-francisco/` | Sample leases per jurisdiction. |

Neither file is parsed at runtime yet. They are the contract the eventual rules
engine (`src/lib/lease-templates/`) will be built against.

## Disclosure trigger fields (shipped)

A disclosure rules engine cannot fire on data the product does not collect. The
manifest's `implementation_checklist` calls this out directly ("Add property
fields: year_built, rrio_registration_number, certificate_of_occupancy_date"),
and three `derived_fields` entries are annotated "not yet in PropLane".

Five building-level compliance inputs now exist on `ManagerListingSubmissionV1`
(`src/lib/manager-listing-submission.ts`). They are camelCased versions of the
`trigger_field_dictionary` names, so the rules engine can map a
`trigger_logic.field` onto a submission property with a single case conversion
and no translation table.

| Submission field | Type | `trigger_field_dictionary` name | Rules that read it | Trigger |
| --- | --- | --- | --- | --- |
| `yearBuilt` | `number \| undefined` | `year_built` | `fed-lead-paint` | `year_built < 1978` |
| `sharedUtilityMetering` | `boolean \| undefined` | `shared_utility_metering` | `ca-shared-utility` | `shared_utility_metering == true` |
| `hasPeriodicPestService` | `boolean \| undefined` | `has_periodic_pest_service` | `ca-pest-control` | `has_periodic_pest_service == true` |
| `certificateOfOccupancyDate` | `string \| undefined` (`YYYY-MM-DD`) | `certificate_of_occupancy_date` | `sf-coverage-determination` (input), `ca-ab1482-notice` (input) | not read directly — feeds the `is_rent_ordinance_covered` and `ab1482_exempt` decision trees |
| `rrioRegistrationNumber` | `string \| undefined` | `rrio_registration_number` | `seattle-rrio` | rule is `{"always": true}`; the number is the merge value, not the gate |

Naming note: the manifest's `merge_fields.premises` entry sources the RRIO number
from `property.rrioNumber`, while `trigger_field_dictionary` and
`implementation_checklist` both call it `rrio_registration_number`. The two
authoritative-name lists agree with each other, so the field is
`rrioRegistrationNumber`; treat `property.rrioNumber` in `merge_fields` as stale.

### Storage

No migration. `manager_property_records.property_data` is `jsonb`
(`supabase/migrations/20260428110000_manager_property_records.sql`) and the
submission rides inside it as `MockProperty.listingSubmission`, so an additive
optional field needs no schema change.

### UNKNOWN IS NOT "NO" — the load-bearing invariant

`normalizeManagerListingSubmissionV1` resolves every one of these to `undefined`
when unset or unparseable. It must stay that way.

`fed-lead-paint` gates the federal lead-based paint disclosure, which carries
civil and criminal exposure. A normalization that defaulted `yearBuilt` to any
number would make an unknown-age building evaluate as post-1978 and silently
suppress a legally required disclosure. The same reasoning applies to the two
booleans: they record only an affirmative `true`, because a defaulted `false`
asserts a fact about the property that the manager never told us.

**The rules engine must therefore treat an absent value as unknown and fail
toward disclosing, not toward silence.** `year_built < 1978` evaluated against
`undefined` is `false` in JavaScript — that is exactly the wrong answer, and the
engine has to handle it explicitly rather than relying on the comparison.

Normalization is also deliberately narrow: `yearBuilt` accepts only an integer in
1600..2100, `certificateOfOccupancyDate` only `YYYY-MM-DD`. Anything else becomes
`undefined` (unknown) rather than a stored value nobody can trust.

Coverage: `tests/unit/manager-listing-submission.test.ts` ("disclosure trigger
fields"), plus `tests/unit/listing-wizard-draft-autosave.test.tsx`, whose
fingerprint hashes the whole submission and therefore covers these fields
automatically.

### UI

The add-listing wizard no longer collects compliance inputs (year built, occupancy
date, utility metering, pest service, RRIO). The submission fields remain on
`ManagerListingSubmissionV1` for drafts, imports, and a future rules-engine surface.

These are internal compliance inputs, not marketing copy. Do not render them on
the public listing page.

### ⚠️ They DO reach the public payload today (pre-existing, not fixed here)

`src/lib/public-listings.server.ts:12-16` `asProperty` spreads `property_data`
with no allowlist, and the whole `ManagerListingSubmissionV1` is embedded on it
as `listingSubmission`. Verified against a running dev server:
`GET /api/property-records/public` already returns `wifiPassword`,
`wifiNetworkName`, `generalHouseInfo`, and the manager-only `houseDescription`
to anonymous callers. The five new fields will land in that same payload the
moment a listing is published with them.

That is a pre-existing allowlist gap owned by another workstream, not something
this change introduced, and it was left alone deliberately. It matters here
because `rrioRegistrationNumber` and `certificateOfOccupancyDate` are
public-record facts (low sensitivity) but `yearBuilt` plus the two booleans are
compliance posture — worth naming in that fix's allowlist decision.

## Manifest-named trigger fields deliberately NOT added

`trigger_field_dictionary` names 18 fields. Five are now collected. The rest were
left out on purpose:

**Derived from data PropLane already has — collecting them would create a second
source of truth.**

- `city` — `resolveLeaseJurisdiction()` already derives it from the address.
- `collects_deposit`, `has_nonrefundable_fee` — the manifest itself gives the
  expressions (`security_deposit_amount > 0`, etc.) over existing listing and
  application fields.
- `lease_start_date` — already on the application (`application.leaseStart`).
- `is_rent_ordinance_covered`, `ab1482_exempt` — outputs of decision trees, not
  raw inputs. `certificateOfOccupancyDate` is one of their inputs and is now
  collected; the trees themselves are still unimplemented.

**Not a building fact, so the listing submission is the wrong home.**

- `lease_negotiated_language` — per applicant/lease, belongs on the application
  or lease record. Gates `ca-translation`.
- `rent_increase_pct` — computed per rent-increase notice, not stored.

**Landlord actual-knowledge booleans — same shape as the two shipped booleans,
but out of scope for this change.** These are the obvious next batch:

- `in_flood_zone` — gates `ca-flood` and `wa-flood-disclosure`. Note the manifest
  wants `wa-flood-disclosure` gated on `lease_start_date > 2026-12-31`.
- `known_mold_hazard` — gates `ca-mold` / `wa-mold`.
- `known_ordnance_within_mile` — gates `ca-ordnance`.
- `death_within_3yr` — gates `ca-death-on-premises`.

If they are added, they must follow the same rule as the shipped pair: record an
affirmative `true` only, and never normalize an unanswered question to `false`.

## Execution evidence (P4)

A lease is binding because it was validly executed, and the electronic part was
already fine: a typed name plus the certificate satisfies ESIGN and state UETA.
What was missing was evidence of **what** was signed. The certificate recorded a
name and a timestamp; nothing tied a signature to a specific document, so there
was no way to prove which version a party agreed to. Everything below exists to
close that.

Owner files: `src/lib/lease-execution-evidence.ts`,
`src/lib/lease-pipeline-storage.ts`, `src/lib/lease-pdf-signing.ts`, and the
guard in `src/app/api/portal-lease-pipeline/route.ts`.

`lease-execution-evidence.ts` is deliberately PURE. Its only import from the
storage module is a type, so a server route can enforce the same rules without
pulling in 1700 lines of browser store. Keep it that way.

### Fields (fixed contract)

`portal_lease_pipeline_records` is
`(id, manager_user_id, resident_user_id, resident_email, property_id, status, row_data jsonb, created_at, updated_at)`.
The whole row lives in `row_data`, so **none of this needed a migration.**

On `LeasePipelineRow`:

| Field | Type | Written by |
| --- | --- | --- |
| `documentSha256` | `string \| null` | DERIVED (see below), never stored independently |
| `executedJurisdiction` | `string \| null` | a later agent. `"US-CA"` or `"US-CA/san_francisco"` |
| `templateVersion` | `string \| null` | a later agent. Template id plus semver, e.g. `"ca-residential@1.2.0"` |

On `LeaseSignature` (per party):

| Field | Type | Meaning |
| --- | --- | --- |
| `documentSha256` | `string \| null` | SHA-256 of the document **this** party was shown |
| `consentVersion` | `string \| null` | version of the consent text they accepted (`esign-consent-v1`) |

`row.documentSha256` is **derived on every normalize** from the first signature
that recorded one (`residentSignature ?? managerSignature`), never carried
forward from storage. It has to be: every path that resets a lease spreads
`...row` and nulls only the signature fields, so a stored copy survived the
document being replaced and the row re-signed, and the certificate then printed
a fingerprint matching no document anyone signed. A row with no signature has no
executed document, so the value is `null`.

Precisely, it is the hash recorded by the earliest signature that recorded one.
For a lease whose resident signed before this change (no hash) and whose manager
countersigns today, that is the manager's hash, not the first execution.

All five are optional, and `normalizeLeasePipelineRow` resolves an absent value
to `null`. A per-signature hash is validated as a real SHA-256 digest
(`asDocumentSha256`) before it is stored or rendered. `row_data` is
client-writable and the value is printed on a legal certificate, so
`"CAFEBABE"` must never render as a fingerprint. Likewise a `consentVersion`
only asserts consent when it matches the current constant.

A lease signed before this change has none of these fields and renders,
downloads, and displays exactly as before. **Do not backfill a guessed value.**
Absent means unknown, and unknown is honest.

`executedJurisdiction` and `templateVersion` are defined, threaded through
normalization and persistence, and left `null`. This agent does not resolve
jurisdiction; the fields are ready for the agents that will.

### When the hash is computed, and over what bytes

At **signature time**, never at generation time, in `residentSignLease` and
`managerSignLease` (`lease-pipeline-storage.ts`) via `leaseDocumentSha256`.
Each party's hash is taken from the pre-signature row.

That is the document the signer was shown, with one deliberate exception worth
stating plainly: on the PDF path the countersigning manager previews
`managerUploadedPdf.dataUrl`, which by then is the base document plus the
resident's certificate page, while the hash covers `originalDataUrl`. Both
parties therefore hash the same comparable bytes.

| Document | Bytes hashed |
| --- | --- |
| Generated lease | `row.generatedHtml`, UTF-8 encoded |
| Uploaded PDF | `managerUploadedPdf.originalDataUrl`, base64-decoded |

**The uploaded-PDF hash covers the ORIGINAL upload, not
`managerUploadedPdf.dataUrl`.** That field holds the copy with the signature
certificate page appended, which changes as each party signs, and a
certificate cannot contain a hash of itself. The certificate page is a platform
artifact; the agreement is the base document. The certificate says this in
plain words. Practical consequence: to verify independently, hash the
**original** PDF (or the generated HTML), not the merged download.

`sha256Hex` returns `null` when WebCrypto is unavailable (a plain-http dev
host has no `crypto.subtle`). A signature must never fail because hashing did;
an absent hash is recorded as absent.

### A document that changed between the two signatures

**Represented as a per-signature hash, not one row-level value.** Each
`LeaseSignature` carries its own `documentSha256`, so if the two parties signed
different bytes both facts survive instead of the second silently overwriting
the first. `row.documentSha256` reads the earliest of them, so the row-level
field never has to pick a winner between two disagreeing signatures.

When the two differ, `signedDocumentHashesDiverge(row)` is true and both the
HTML certificate block and the PDF certificate page print a warning naming each
party's own fingerprint. Through the portal this is now impossible (a signed
row's body is immutable, below), so it means an out-of-band edit reached the
record, exactly the case where the certificate must not pick a winner.

### Consent to transact electronically

`LeaseSigningModal` already required an affirmation that the typed name is a
binding signature, but not ESIGN's consent to **do business electronically and
receive records in electronic form**. `LEASE_ESIGN_CONSENT_TEXT` /
`LEASE_ESIGN_CONSENT_VERSION` (`lease-execution-evidence.ts`) are now the single
source: the modal renders that constant as its required checkbox, signing
records the version on the signature, and both certificates quote the text back
but only when the recorded version matches the current constant, so bumping
the wording can never make a certificate misquote an older signer.

**Not captured: IP address and user agent.** Attribution metadata needs a
server-side capture point; signing runs entirely in the browser through the
client storage layer, and a browser-reported IP is worthless as evidence.
Capturing it means routing signature writes through a route handler, which is
outside this agent's files. Flagged, not attempted.

### A consent tick must not outlive what it consented to

Both lease gates — the e-signature affirmation (`lease-signing-modal.tsx`) and the
uploaded-lease review attestation (`uploaded-lease-review-modal.tsx`, below) — are
mounted **without a `key` at a stable position** by every call site
(`resident-lease-panel.tsx`, `manager-residents.tsx`,
`manager-leases-pipeline-panel.tsx`). A new `row` / `parse` prop therefore
RE-RENDERS rather than remounts, and `useState` initializers do not re-run:
nothing resets on its own. That allowed two ways to agree to something you never
saw — a retried parse carrying the weaker "I have read the original PDF myself"
tick onto the stronger "I have compared this against the original PDF. The terms
above are correct", and a live `row` swapping the document under an already
ticked signing affirmation. **The evidence layer structurally cannot catch this:**
`lease-execution-evidence.ts` hashes whatever is current AT signature time, so it
records the substitution faithfully. The reset is the control.

Rules for any new consent/attestation control here:

- Reset the tick — and anything else staged against the old subject, such as the
  review modal's `drafts`/`note`, which are submitted as human-confirmed
  overrides and badged "Manager entered" — whenever a **content-derived**
  identity of what is being attested to changes. Each component has a documented
  `…Subject()` helper; extend that rather than adding a second scheme — **unless
  the new trigger must reset the tick ALONE**. The review modal's
  `attestationWording` is that case: the checkbox reads "The terms above are
  correct" with no disagreements and "I accept the differences listed above"
  with them, so a manager's own edit that introduces or clears a disagreement
  changes which statement they are signing. Folding it into `attestationSubject`
  would re-seed `drafts`/`note` too and wipe their typing on every keystroke, so
  it is a separate render-time guard that resets `attested` and nothing else.
- **Never key on object identity.** The pipeline re-syncs on a cadence and hands
  back an equal-but-new object; clearing the box under a manager's fingers on a
  background refresh is its own bug. Equally, keep the identity narrow enough
  that an unrelated field (a new thread message) does not clear it — the signing
  modal's subject is only the fields that decide WHICH document renders.
- **Reset during render**, not in an effect — an effect runs after paint, so the
  new subject would be painted with the old consent still ticked.
- A featureless parse is not a unique document: `pending`/`failed` carry
  `sourceSha256: null`, no `extractedAtIso` and no fields, so identity must also
  include the upload (`managerUploadedPdf` file name + `uploadedAt`).
- Coverage: `tests/unit/lease-signing-consent-carryover.test.tsx`,
  `tests/unit/uploaded-lease-attestation-carryover.test.tsx`,
  `tests/unit/uploaded-lease-mismatch-warning.test.tsx`.

### Signed documents are immutable in practice

**The server check is the one that matters.** `POST /api/portal-lease-pipeline`
stores whatever `row_data` the caller sends, so a browser-side guard on a
browser-owned store is advisory at best: anyone with devtools could POST a
rewritten executed lease. The route now loads the stored row and answers **409**
when the request would replace the document body of a row that already claims
execution. It refuses rather than silently restoring, because a legitimate
client never makes that request, and it does not exempt admins. The point is
that executed text cannot change, not that only strangers may not change it.

**"Claims execution" is one predicate, `leaseClaimsExecution`** — `fullySignedAt`
OR any signature. Guards used to key on one signal or the other, and every
disagreement was a bypass: a payload carrying `fullySignedAt` with no signature
object was "executed" to one guard and "unsigned" to the next, so neither
protected its body. Anything deciding what an executed row may do reads that one
function.

`preserveSignedLeaseDocuments(prev, next)` (`lease-pipeline-storage.ts`) is the
client-side second line, applied in `write()`, `materializeLeasePipeline()`, and
the merge inside `syncLeasePipelineFromServer` (so a tampered server row cannot
land in memory and then *become* the body every later write preserves). It
reverts rather than throwing, and logs when it does. `write()` rehydrates from
session storage before comparing, because `ensureLeasePipelineScope` blanks
`memoryRows` on a scope change and an empty baseline would disable the guard,
and resident-side writes pass no scope at all.

Both sides share one predicate, `replacesSignedLeaseDocument`, so they cannot
drift.

Three deliberate exemptions:

- **The certificate merge.** Comparison is on the *base* document
  (`generatedHtml` and `managerUploadedPdf.originalDataUrl`), so appending the
  certificate page into `dataUrl` at signing is allowed. `refreshUploadedPdfSignatures`
  now pins `originalDataUrl` before the first merge. Without that, a legacy row
  carrying only `dataUrl` would have the certificate appended to an
  already-merged copy on the second signature, and the guard could not tell a
  merge from a swap.
- **Clearing the execution claim.** Void, send-back-to-manager, renew, and amend
  all null the signatures and `fullySignedAt`; that is a superseding document,
  not a silent edit to an executed one, and it drops out of the guard by design.
- **Filling in an absent body on an `externallySignedLease` row.** That is how
  existing-resident onboarding files an already-executed off-platform PDF onto
  a row that never carried a document.

Coverage, both verified by deleting the guard and watching them go red:
`tests/unit/lease-pipeline-route-signed-document.test.ts` drives the real route
handler (manager and resident), and
`tests/unit/lease-signed-document-immutability.test.ts` drives the client store.

#### The sibling case: body and execution claim in the SAME write

`replacesSignedLeaseDocument` requires the STORED row to be executed already,
because it assumes the signature was applied to a body the server held. A caller
that supplies the body and the execution claim in one request never trips it, so
the "executed" text would be whatever that single POST said it was.
`introducesUntrustedLeaseDocument` (same pure module) is that shape: stored row
unexecuted, `next` executed, body changed.

It has **no flag carve-out**, deliberately. Apart from the four scope mirrors,
`row_data` is persisted verbatim from the client, so a stored
`externallySignedLease` is prior-request client input, not server-established
state — honouring it here would just move the attacker's write one request
earlier. (`replacesSignedLeaseDocument` may honour it, because it is only reached
once the stored row is executed, a state the evidence rules have already
protected.)

Two behaviours read that one decision, so the guard and the action it protects
cannot key on different signals:

- a **resident-scoped** write of this shape is refused **409** — a resident signs
  a lease, they never author one;
- **auto-file declines** to render such a body into the property owner's document
  library.

The one legitimate shape — the existing-resident onboarding lease
`syncApprovedApplications` seeds, which materializes in the RESIDENT's browser
too — is admitted by corroborating the BYTES, not a flag:
`leaseBodyMatchesManagerFiledLease`
(`src/lib/lease-manager-filed-document.server.ts`) requires byte equality with
the PDF the manager filed on the application record
(`manualResidentDetails.signedLeaseDataUrl`), looked up pinned to the lease row's
stored `manager_user_id` column, PDF-only (an accompanying HTML body is refused),
failing closed. `axisId` only selects which application to compare against and is
caller-influenced; that is harmless only while the verdict is byte equality — if
this is ever loosened to a hash, a filename, or mere presence, re-derive `axisId`
server side first.

#### Who may write a lease row, and whose row it becomes

The four scope columns (`manager_user_id`, `resident_user_id`, `resident_email`,
`property_id`) are what every scoped query keys on, so they are a **required,
server-resolved argument** to `buildUpsert` — never read off the client row. For
those four keys `row_data` is a MIRROR reconciled from the resolved columns, not
a second source: pinning the columns alone left the manager's own browser store
to read a tampered `row_data.residentEmail` back from GET and launder it into the
column on its next sync.

- **Resident-scoped actor:** may edit the body of a lease they can already see;
  scope is pinned to what the server stored, a row they create is pinned to
  themselves, and a `delete` / `deleteIds` action is refused **403** outright
  (it used to skip silently, reporting success).
- **Manager:** may re-point scope but never blank it by omission — a field the
  row does not NAME falls back to the stored column (a normalized `null` from the
  browser store is not a request to clear). A named `property_id` is honored only
  when they own it or hold the co-manager `leases` grant at EDIT level
  (`managerMayFileLeaseUnderProperty`); refusal is reserved for a property that
  provably belongs to someone else, since an absent record would 403 whole
  ordinary `replace` batches.
- **Creating a row that names another person as the resident requires the manager
  role** (`hasRole`), not merely "not admin, not resident".
- **Admin** keeps table-wide scope, with omitted fields still falling back to the
  stored column.

The whole batch is authorized and resolved BEFORE any row is written, so a
refusal on the last row of a `replace` no longer leaves the earlier rows upserted.
Coverage: `tests/unit/lease-pipeline-resident-upsert-scope.test.ts`,
`tests/unit/lease-pipeline-route-role-scope.test.ts`,
`tests/unit/manager-lease-scope.test.ts`.

One related fix in `syncApprovedApplications`: the off-platform PDF is filed only
onto a row carrying no document at all. It used to key on `!managerUploadedPdf`
alone, so a manually-added resident whose manager then generated and signed a
lease in-portal would have the paper lease swapped in on every materialize, be
reverted by the guard, and churn forever instead of converging.

### Removed: `regenerateAllLeaseHtml`

Deleted. It rebuilt a fully executed lease from current data and replaced the
signed text **without bumping the version**, and it had zero callers anywhere in
the repo including tests and scripts. Its only possible future was destroying
evidence. Its one helper, `refreshAllLeaseApplicationSnapshots`, and the stub
`recomputeLeaseSignedHtml` (which returned `true` and did nothing) went with it
as dead code. Do not reintroduce a bulk regenerator that can reach a row with a
signature.

### Known gaps, for the agents that come next

- **The lease-pipeline route is guarded; other service-role writers are not.**
  `amendLeaseMoveOutDate` / `renewLease` write with their own client (they clear
  the signatures, so they are exempt anyway), and
  `runExistingResidentOnboarding` now refuses to upsert onto a lease row owned by
  another manager. Its `leaseId` is derived from the application axis id, the
  same id space real leases use, and the route falls back to a client-supplied
  `row`, so a colliding id could otherwise have replaced another manager's
  executed lease and re-parented it. That client-supplied `row` fallback is
  still an unscoped input and belongs to the onboarding lane to remove.
- **`deleteLeasePipelineRow` wipes a fully executed lease behind one
  `window.confirm`**, with no status gate. It clears the signatures in the same
  write, so it is outside the guard by construction. Not silent, so not fixed
  here, but "Delete lease" destroying an execution record with no archive is a
  product decision someone should make deliberately.
- **A renewal or amendment discards the superseded executed document.**
  `amendLeaseMoveOutDate` and `renewLease` (`src/lib/lease-amendment.server.ts`,
  not this agent's files) overwrite `generatedHtml` on a fully signed row while
  clearing the signatures. The manager asked for it and the new document is
  correctly unsigned, but the previously executed text and its signatures are
  gone. An archive of prior executions on the row is the fix; it needs the
  amendment lane's owner.
- `executedJurisdiction` and `templateVersion` are null on every row until
  someone populates them at generation time.
- Rows seeded as `externallySignedLease` carry synthetic signatures and no hash.
  That is correct (nothing was executed through the portal), but it means a
  present signature does not imply a present fingerprint.

# Uploaded leases: parsed into PropLane format, held until a human confirms (Aug 2026)

A manager-uploaded lease (`managerUploadLeasePdf` → `LeasePipelineRow.managerUploadedPdf`)
used to be an opaque PDF: nothing was read out of it, and it was signable the
moment it landed. It is now read in full, mapped into PropLane's structure,
rendered in PropLane's own lease format, and **kept out of the signature flow
until a manager confirms the reading**.

**The upload is still the executed artifact.** The parse is a new, additive,
derived field (`LeasePipelineRow.uploadedLeaseParse`) that sits ALONGSIDE
`managerUploadedPdf`, never in place of it. Signing still appends the
certificate page to `originalDataUrl` and `leaseSignedDocumentBytes` still
hashes those bytes — a machine-derived document must never become the thing the
parties execute. Do not move the parsed HTML into `generatedHtml`.

Three rules, each with a test that goes red if it is broken
(`tests/unit/uploaded-lease-{extraction,proplane-format,confirm-gate,parse-server}.test.ts`):

- **Nothing invented.** `extractLeaseFields` emits a value only when the
  document states it exactly once. Two disagreeing readings →
  `status: "ambiguous"` with an EMPTY value and both candidates listed; no
  reading → `not_found`, also empty. There is no default and no best guess.
  `normalizeLeaseDate` refuses `03/04/2026` (two different days by convention)
  and keeps the document's own wording as the value.
- **Nothing authored.** Section bodies are the source's bytes. No clause is
  written, no wording tidied, and no statute cited — the same bar as
  `landlordMaintenanceStatuteRef` above.
- **Nothing lost.** `splitLeasePagesIntoSections` PARTITIONS the extracted text;
  `assertSectionsPartition` throws if the spans gap, overlap, or drop a
  character, so unmapped and unrecognized content still reaches the reader
  verbatim. An oversized or unreadable PDF fails LOUDLY (`status: "failed"`)
  rather than being truncated.

**The gate.** `managerUploadLeasePdf` writes a `pending` parse *synchronously*,
before any text is read, so a parse that fails or never returns still holds the
lease. `sendLeaseToResident` — the only path to signability — refuses via
`leaseSendGateBlocker`, and both manager surfaces (`manager-residents.tsx`,
`manager-leases-pipeline-panel.tsx`) offer "Review import"
(`UploadedLeaseReviewModal`). Confirming records who, when, and which values the
human typed (`review.overrides`), and every surface renders manager-entered
values differently from machine-extracted ones.

**"No parse" is NOT an exemption.** It used to be: the gate asked
`uploadedLeaseNeedsManagerConfirmation`, which answers `false` for an absent
parse, so every legacy and seeded upload — the widest cohort there is — was sent
with no review step, no attestation and no confirmation of its terms.
`normalizeLeasePipelineRow` now gives an upload with no stored reading an
explicit `unreadUploadedLeaseParse`, so absence means *unreviewed*, and the
review modal has something to render instead of stranding the row unsendable and
un-confirmable. `/demo` still stores no parse (it must not call the parse route)
and is gated all the same, with the read step simply absent. Still untouched:
generated leases, and executed filings (`externallySignedLease`, or any row
already carrying a signature) — normalize leaves those parse-less because a
filing is evidence of an executed lease, not a document waiting to be sent.

**The gate is on the transition, not on a button, so the agent layer is inside
it.** `send_lease_for_signature` performs the same transition from the assistant
that the Leases UI performs, so `sendForSignatureBlockerWithContext`
(`src/lib/tools/domains/leases.ts`) — the guard both its `preview` and its
`handler` run — calls `leaseSendGateBlockerAmong` over the landlord's own
applications, giving the same ordering and the same wording the manager gets.
`sendForSignatureBlocker` beside it is only the row-state half (no document, no
resident email, already signed or finalized); it is not the gate. Any future
path that writes `bucket: "resident"` must clear this gate too — greying out a
button is not the gate. The Send buttons are deliberately **not** disabled for a
gate reason: disabling makes the click handler, the only thing that states the
reason and opens the review that clears it, unreachable, and `title` is
invisible on touch. Because the whole assistant-side gate is one import, it can
vanish while everything still compiles — `tests/unit/tools/lease-vendor-writes.test.ts`
pins the tool's refusals (unapproved application, unreviewed upload) alongside
the library-level `tests/unit/lease-send-guards.test.ts`.

**Three ordered reasons, one ordering.** `leaseSendGateBlocker` answers in the
order that tells the manager the most: an unapproved application (a fact about
the person — see "A lease needs an approved application" below), then a
parties/terms mismatch (which names the exact terms that disagree), then the
generic review message. One function, so a refused click, a refused tool call
and any surface that explains itself cannot drift apart.

**Gate and CTA are different questions, and they are scoped differently.**

| Predicate | Question | Scope |
| --- | --- | --- |
| `leaseCanBeSentForSignature` | can this lease be sent at all? | the WHOLE gate — `leaseSendStillReachable` plus every reason `leaseSendGateBlocker` answers |
| `leaseSendHeldByUploadedLeaseReview` | is the review what stands between this row and a signature? | everything the send paths accept — `leaseSendStillReachable`: no signatures, not Fully Signed / Voided |
| `leaseNeedsUploadedLeaseReviewAction` | should the manager be pointed at the review? | only `leaseAllowsManagerDocumentEdits`, where confirming can actually succeed |

The gate is the wider one because `sendLeaseToResident` and
`send_lease_for_signature` both accept a row **already out for signature**
(`bucket: "resident"`, no signatures); scoping it to editable rows would let the
assistant re-send a lease whose record drifted after it went out. The CTA is the
narrower one because `confirmUploadedLeaseParse` refuses a row that no longer
allows document edits, so a wider CTA would be a primary button whose action
always fails and which nothing on screen can clear — a Fully Signed lease whose
rent is edited later would grow a permanent, unclearable nag. Rows in the gap
are reachable: "Move to manager review" restores edits, and the refusal says so
(`LEASE_MOVE_BACK_TO_REVIEW_MESSAGE`) instead of naming a button that is not on
screen.

**A surface reads the predicate for the claim IT makes.** A claim about
sendability ("this lease can be sent for signature") reads
`leaseCanBeSentForSignature`; an affordance saying *do something here* reads the
CTA. Mixing them is how a green "Confirmed … can be sent for signature" banner
ends up above a lease every send path refuses. **Read the whole gate, never a
subset of it** — that has drifted three times, most recently a banner that
covered only the review half and so stayed green over a lease whose applicant had
been moved back to Pending. `leaseCanBeSentForSignature` is the one call the
review modal's banner makes, so the row's own state (Fully Signed / Voided) and
all three ordered blocker reasons suppress it identically.

**One predicate decides "has a human confirmed this reading".**
`uploadedLeaseReviewIsConfirmed` (and its inverse
`uploadedLeaseNeedsManagerConfirmation`, wrapped row-side as
`leaseAwaitsUploadedLeaseReview`) is that decision, and it is the building block
the composite predicates above are built from — it answers "has this reading been
confirmed", never "may this be sent" or "should the CTA show". The review modal,
both "Review import" buttons, the rendered PropLane document,
`saveUploadedLeaseParse` and the send gate all reach it through one of those
three. **Never compare `review.status` to
`"confirmed"` at a call site** — that re-implements a weaker rule, and the last
time five sites did, a lease could render a green "Confirmed … can be sent for
signature" banner with no Confirm button while every send path refused it. A
manager cannot debug a Send button that is dead for a reason the UI denies.

**A lease needs an approved application.** A lease is a binding contract, so
`leaseSendGateBlocker` refuses one whose applicant was never approved. Reachable
in ordinary use, not just from seeded data: `syncApprovedApplications` creates
the lease row *on approval*, and moving the application back to Pending
afterwards leaves the lease behind. It fails **open** when no application row is
found — an existing resident onboarded off-platform has none, and the
applications store loads lazily, so refusing on absence would block real sends
and read exactly like "leases not sending". For the same reason the email-only
fallback in `applicationRowForLease` prefers an approved, non-withdrawn row:
someone can hold a pending application for a *different* property alongside the
approved one this lease came from, and picking that first would manufacture a
hard, override-less block out of an unrelated record.

**A parties/terms mismatch is named, not merely refused.**
`lease-document-mismatch.ts` compares the document's own words against the
record — and is deliberately conservative in both directions, because a FALSE
mismatch blocks a legitimate send and teaches managers to click past warnings.
It compares only terms the document actually **states** (`extracted`, or a value
the manager typed; `ambiguous` and `not_found` are already blank-and-flagged),
only in **comparable normalized form** (so `March 1, 2026` and `2026-03-01`
agree, and `01/02/2026` — which `normalizeLeaseDate` refuses because it means two
different days in two conventions — is not compared at all), and only for the
four terms with a counterpart on the record. `landlordName`, `propertyAddress`,
`rentDueDay` and `lateFee` carry `mapsTo: null`, so there is nothing to disagree
with; they stay review-only. Names are the loosest test on purpose — a real lease
names co-tenants, middle names and suffixes, so a disagreement is reported only
when the two names share **no word at all**. Names also compare in every script
by default, and a pair the module cannot judge honestly (one side Latin and the
other not, or a script that does not delimit words with whitespace) is skipped
rather than guessed at; `namesDisagree` in that module carries the reasoning and
is the place to change it.

**A confirmation is bound to BOTH sides of that comparison.**
`confirmUploadedLeaseParse` stamps the parse's `sourceSha256` onto
`review.confirmedDocumentSha256` *and* a fingerprint of the record's four
comparable terms onto `review.confirmedRecordFingerprint`
(`leaseRecordFingerprint`). The document digest alone is not enough: a manager
who accepts a document's differences and then edits the resident's rent or dates
has their acknowledgement carried onto terms they never saw — the document never
changed, so the digest still matches. `leaseMismatchAcknowledgementGap` returns
why a confirmation does not cover the record (`unconfirmed`, `record_changed`,
or `record_unknown`) and is asked **only when mismatches exist**, so an agreeing
lease is never re-gated by an unrelated record edit. It fails **closed** on a
missing fingerprint — every confirmation predating the field is in that state —
and the UI must say which of the two it is: telling that cohort "the record
changed" states a cause that is false for all of them.

The digest half's reach is narrower than it looks:

- It proves the confirmation matches the PARSE it was made against — a re-read
  producing a new digest, or a parse swapped for one describing other bytes,
  drops back to `needs_review`.
- It does NOT prove the parse matches the bytes now in `managerUploadedPdf`.
  Both values live inside the same `row_data.uploadedLeaseParse` blob, so this
  is an internal-consistency check. A byte-level check would have to hash the
  upload, which the synchronous render-path predicate cannot do.
- It does NOT close the `row_data` trust problem. A forged blob can satisfy it
  by naming its own digest on both sides. That belongs to the lease-pipeline
  route lane, not here.
- The ONE deliberate exception: a parse with no digest of its own — a `pending`
  parse written before any text was read, a `failed` one, a row from before the
  field existed, or a stored `sourceSha256` that failed the 64-hex check in
  `normalizeUploadedLeaseParse` and so normalized to null — has nothing to bind
  to and reads as confirmed on the who-and-when alone. Requiring a digest there
  would make those leases permanently unconfirmable: a dead end, not a gate.

**`pending` is not a one-way door.** The parse is written synchronously at
upload time, so a manager who closes the tab mid-read would otherwise own a row
that can never be sent. `retryUploadedLeaseParse`
(`src/lib/uploaded-lease-parse.client.ts`, surfaced as "Retry read" / "Read it
again" in `UploadedLeaseReviewModal`) re-reads `managerUploadedPdf.originalDataUrl`
— the bytes already on the row, never a re-upload — and stores the result
through the same `saveUploadedLeaseParse`. It never confirms: the fresh parse
lands `needs_review`, so the human step still happens. `saveUploadedLeaseParse`
refuses on the same predicate the gate uses, so a confirmation that no longer
binds cannot lock a re-read out. A retry also changes WHAT the manager is being
asked to attest to, so the modal's tick and staged overrides reset with it — see
[A consent tick must not outlive what it consented to](#a-consent-tick-must-not-outlive-what-it-consented-to).

**Every canonical term is always listed.** `normalizeUploadedLeaseParse`
backfills any `FIELD_MATCHERS` key a stored blob lost as `not_found` with an
empty value, in matcher order. An absent row reads as "this term does not apply
to this lease"; a blank flagged row reads as "nobody found this, go check". Only
the second is true of a reading that dropped a row.

**The reading is derived, so it may not outlive the upload.**
`normalizeLeasePipelineRow` drops `uploadedLeaseParse` whenever the row has no
`managerUploadedPdf.dataUrl`. Every path that swaps a generated document in for
the upload (`generateLeaseHtmlForRow`, and the packet and section edits behind
`update_lease_packet` / `update_lease_document_sections`) already writes
`managerUploadedPdf: null` through that function, so one choke point covers all
of them instead of a list to keep in sync — otherwise a manager is held forever,
asked to attest against a PDF the row no longer has. `residentUploadLeasePdf` clears it explicitly, because there
the upload is *replaced* rather than removed.

**`normalizeUploadedLeaseParse` fails CLOSED.** `row_data` is client-writable,
so the stored blob is untrusted: section titles/bodies and field values are
coerced, an unknown field status reads as `not_found` (blank and flagged, never
a term), unknown keys and uncoercible rows are dropped, and a `version` this
build does not know degrades the whole parse to `failed` with its confirmation
discarded. What it must never do is return `null` for a parse that is present
but unreadable — that would unblock signing. It still maps `null` → `null`, but
that no longer means the row ends up without a reading: the gate is closed one
level up, where `normalizeLeasePipelineRow` substitutes an
`unreadUploadedLeaseParse` for any upload this returns nothing for (see
**"No parse" is NOT an exemption** above).

Extraction is deterministic regex over `unpdf` page text, server-side
(`/api/portal/parse-uploaded-lease`, manager-authenticated + rate limited). No
new dependency, nothing added to the client bundle, and **no lease text leaves
the process** — sending private tenant documents to a third party is a decision
for a human, not for this path. Note that the older lease-*template* parser
(`lease-pdf-parse.server.ts`, used by the create-listing wizard) DOES call
Anthropic to split sections; that is a separate, pre-existing path.

Deliberately NOT done, for whoever picks this up:

- **Confirming writes nothing back into PropLane's records.** The review table
  shows PropLane's value beside the extracted one so a disagreement is visible,
  but rent, dates and deposits are not overwritten. Auto-applying an extracted
  money figure to the ledger is exactly the failure mode the blank-payment-terms
  defect warns about; it needs a deliberate product decision.
- **`landlordName`, `propertyAddress`, `rentDueDay` and `lateFee` map to
  nothing** — PropLane derives the landlord from the manager account, `unit`
  from the listing, due dates from the charge schedule, and late fees from
  automation settings. They are review-only and labelled as such.
- **Resident-side rendering still shows the raw PDF.** The PropLane-format view
  is manager-only; `lease-document-preview.tsx` was left alone.
- **Scanned/image-only PDFs produce a `failed` parse** (no OCR). The manager can
  still confirm after reading the original, so it is a gap, not a dead end.

# Lease templates are private (Jul 2026)

A manager-uploaded lease template is the manager's own legal document — often
their attorney's work product, carrying their entity details and their terms.
It is not listing marketing. Two independent things used to make it public;
both are closed.

## What was confirmed empirically, before any edit

Against the dev/test project, with the dev server running:

- `GET /api/property-records/public` returned **17 listings, every one carrying
  the full `listingSubmission` blob** — `getPublicListings()` spread
  `property_data` with no field allowlist. 64.5 KB of manager-owned JSON to
  anonymous callers.
- **5 of those listings published `wifiPassword`** (`AxisHome-5G` /
  `welcome-home-2026`) in that payload. The reported lease-template leak is one
  symptom of a wider "the whole submission is public" defect, not the whole bug.
- `listing-photos` is **public** and its objects are anonymously readable
  (`ANON GET 200 image/jpeg` on an existing object with no credentials). Note the
  live bucket has `allowed_mime_types: null` and `file_size_limit: null` — the
  values in `20260504120000_listing_photos_bucket.sql` never applied because the
  bucket pre-existed and the insert is `on conflict do nothing`. So the migration
  appears to restrict uploads to images/video, and in reality PDFs upload fine.
- **No live dev listing currently holds an uploaded template**, top-level or
  inside `propertyLeaseTemplates[]` — so the leak was structural and live, but
  had no realized instance in dev. Production was not checked (its credentials
  live only in Vercel, by design). See "Legacy objects" below.
- A second anonymous route, `GET /api/public/property-lead?propertyId=…`, reached
  the same stored blob the same way. Fixing only `getPublicListings()` would have
  been bypassable by asking for a property by id.

Also found while tracing, both fixed here:

- Only the create-listing wizard ever uploaded a template. The three lease
  modals (`manager-lease-editor-modal`, `property-lease-form-modal`,
  `property-lease-upload-modal`) persisted the **base64 `data:` URL straight
  into `manager_property_records.property_data`** — a multi-megabyte PDF inlined
  into the blob public surfaces read.
- Neither the wizard's uploader nor `collectSubmissionMediaUrls` walked
  `propertyLeaseTemplates[]`, so per-property templates were never uploaded and
  never garbage-collected.

## Part 1 — the public payload is an explicit allowlist

`publicListingProjection` in `src/lib/public-listings.server.ts` is now the ONE
projection every anonymous read runs through: `getPublicListings()` (which backs
both `/api/property-records/public` and the AI housing-search + leasing SMS
tools, so "what the search sees" still cannot drift from "what the AI sees") and
`/api/public/property-lead`.

Deny by default, at every depth: `PUBLIC_PROPERTY_KEYS` for `MockProperty`,
`PUBLIC_SUBMISSION_KEYS` for the submission, and per-row lists for rooms,
bathrooms, shared spaces, bundles, quick facts and custom fees. Each list is
`as const satisfies readonly (keyof T)[]`, so a renamed field fails the build
rather than silently dropping out of the payload.

The rule for adding a field: it belongs on a list when a prospect-facing surface
reads it, or it is pure listing marketing metadata. It stays off when it is
manager- or resident-internal — access credentials and instructions (wifi,
`moveInInstructions`), lease configuration, billing policy, add-on service
offers (which carry `residentEmails`), proration internals. A compliance field
like `yearBuilt` added next month is public only when someone adds it here.

**`listingSubmission` is still present in the payload, allowlisted, not
removed.** Removing it outright fails the "browse, listing detail and the apply
wizard still work" requirement: the public apply wizard reads its custom
application questions, fee sheet and lease terms from it, and
`listing-rich-from-submission.ts` calls `.trim()` / `.map()` on the required
fields unguarded — a missing one throws into `getListingRichContent`'s catch and
silently renders a **generic demo listing** in place of the real one. Every
required submission field is therefore on the allowlist (they are all benign
listing copy or pricing), and `tests/unit/public-listing-projection.test.ts`
asserts that.

## Part 2 — the object

New PRIVATE bucket `lease-templates`
(`supabase/migrations/20260728120000_lease_templates_bucket.sql`): 8 MB,
`application/pdf` only, **no storage policy at all**, copying
`application-documents` rather than `manager-documents`. Storage RLS default-denies
`anon`/`authenticated` when no policy grants them, so the shipped public anon key
cannot reach the objects even though the PostgREST surface is browser-reachable.
A folder-scoped `auth.uid()` policy would be strictly weaker here, because a
resident who may read their own lease template is not the folder owner. Like
`application-documents` there is no metadata table — the object path lives on the
submission, so it persists through the same autosave path as every other listing
field and ownership is re-derived at request time.

**Path convention:** `<manager user id>/<timestamp>-<rand>.pdf`. The folder is
the authenticated uploader's id, never a name from the request.

**Stored reference:** `leaseTemplateDocUrl` holds
`/api/portal/lease-template?path=<object path>` — a stable, root-relative URL
onto the authorizing route, **not** a signed storage URL. That is deliberate and
it is the one place this deviates from the documents module:
`buildManagerTemplateLeaseHtml` (`generated-lease.ts`) bakes the value into a
persisted `<object data=…>` inside `portal_lease_pipeline_records.row_data.generatedHtml`,
which outlives any signed-URL TTL by years. A stable URL that re-authorizes on
every request gives the same privacy guarantee without touching the lease
router, the signing modal, or the generated HTML. Root-relative so the same
stored value resolves on localhost, previews, production, and inside the
Capacitor WebView, including from the `srcDoc` iframes that render leases.

**`GET /api/portal/lease-template?path=…`** streams the bytes (service-role
`download()`, `Cache-Control: private, no-store`, `X-Content-Type-Options:
nosniff`), the same shape as `/api/portal/application-photos` — not a 302, which
the documents module already learned opens a new tab in the Capacitor WebView
instead of rendering. Authorization is by RELATIONSHIP, not portal role, so a
multi-role account is judged on each relationship it actually holds:

1. the manager who uploaded it, by the object's own folder;
2. the OWNING manager of a property whose submission references that exact path,
   re-derived from `manager_user_id` and deliberately NOT from the folder — the
   two genuinely differ, because a co-manager's upload lands in the co-manager's
   folder while the URL is stored on the owner's listing, and a transferred
   property changes hands without moving any object;
3. a co-manager with the `properties` module on such a property;
4. the APPROVED resident of such a property. Approval is checked explicitly
   (`residentHasApprovedResidency`) because `resolveResidentFilingScope` falls
   back to unapproved rows, which would hand the grant to anyone who merely
   applied to a live listing. `/api/portal/resident-property` draws the same
   line — it strips `listingSubmission` for an unapproved applicant — and the
   two routes must not disagree about one trust boundary;
5. either party to a lease document that already embeds the path. Required
   because the generated lease HTML bakes the URL in permanently and is never
   rewritten: when a manager REPLACES a property's template the listing stops
   referencing the old object, and without this branch every resident who
   already signed against it would 404 on their own lease — something the old
   public URL never did.

Membership is **two** conditions, and both are load-bearing: a property (or
lease row) must reference the path AND the object's FOLDER OWNER must be someone
who could have attached it there — the row's own manager, or a co-manager of it.
"A property I can see references this path" alone is not authorization, because
`leaseTemplateDocUrl` is a manager-editable blob field: a manager can write any
string onto their OWN listing and the wizard mirrors `property_data` verbatim,
so without the second condition they could paste another manager's path onto
their own property and read the document back. The folder id is not secret
either — `managerUserId` ships in the public listing payload — so the path is a
weak secret and never the gate. The same pair applies to the lease-row branch,
since a lease row is client-writable too. Every denial is a 404, never a 403, so
the route never confirms a path exists. `POST` (multipart) uploads into the
caller's own folder after a manager/admin role check and a per-user
`rateLimit` — an uploaded object carries no property association, so nothing
else bounds how many a manager can push into a free-plan storage budget.
`DELETE` removes only paths whose folder is the caller's id.

**Writes funnel through one function.** `readLeaseTemplateFile`
(`lease-config-form.tsx`) is the single picker all three lease modals use; it now
uploads and hands back the route URL instead of a `data:` URL, so fixing it
fixed all three. `/demo` keeps the in-memory data URL (it must never write real
rows). A failed upload surfaces a toast and stores nothing — base64 is never
persisted as a fallback. The wizard's `uploadSubmissionMedia` routes the
template (and every `propertyLeaseTemplates[]` entry) through
`uploadLeaseTemplateDataUrl` instead of the generic `uploadOne`, so a legacy
draft resumed with base64 lands in the private bucket rather than the public
photo bucket.

**Deletion still reclaims, and still skips.** `deleteSubmissionMediaObjects`
calls `deleteSubmissionLeaseTemplates` with the same `stillReferencedBy` set, so
a path a surviving submission references is left alone — the shared-object rule
from the property-drafts notes in AGENTS.md, which matters most for the two draft
rows a partially-failed id re-key leaves behind. `collectSubmissionMediaUrls`
still pushes `leaseTemplateDocUrl` and now walks `propertyLeaseTemplates[]`,
which is what reclaims a LEGACY template still sitting in `listing-photos`.

## The projection and the manager's own catalog share one localStorage map

`cachePublicExtraListings` (`demo-property-pipeline.ts`) writes every public
fetch into `axis_manager_extras_by_user_v1` keyed by `managerUserId` — the SAME
map the manager portal reads, edits, and mirrors back into `property_data` via
`updateExtraListingFromSubmission`. That was harmless while the public payload
equalled the stored blob. The allowlist made it lossy: one visit to
`/rent/browse`, or a native app launch (which hydrates the public catalog for
every role), would replace the owner's own row with the stripped copy, and their
next House-details save would persist it — silently destroying lease config,
wifi, add-on services, room move-in instructions, and the lease template this
whole change exists to protect.

The cache now **merges**: public scalar fields refresh, but an existing row's
`listingSubmission` is never downgraded. Residual, accepted: a listing cached
for the first time from the public route before the owner's authoritative sync
runs (TTL 15s) is a projection until that sync fires. Coverage:
`tests/unit/public-listing-cache-merge.test.ts`. If you add another consumer of
the public payload, ask whether it writes anywhere the owner later saves from.

## Legacy objects: read-through, knowingly, with a backfill plan

**Decision: read-through.** Templates already in `listing-photos` keep working;
only new uploads go private.

Why, rather than a backfill:

- Dev holds **zero** of them (verified above), so a backfill there is a no-op.
- The Part 1 allowlist already removes the only discovery path — a legacy URL is
  no longer emitted by any anonymous endpoint.
- A backfill cannot stop at the submission. Every already-generated lease has the
  old public URL **frozen inside `generatedHtml`**, so deleting the public object
  breaks the document residents already signed. A correct backfill must rewrite
  `portal_lease_pipeline_records.row_data.generatedHtml` too, which is the lease
  and signing flow this change deliberately does not touch.

Residual risk, stated plainly: a legacy object stays anonymously readable to
anyone who already has its URL. Check production before deciding it is empty:

```js
// service-role, against the target project
const { data } = await db.from("manager_property_records").select("id, property_data");
for (const r of data) {
  const s = r.property_data?.listingSubmission ?? {};
  for (const u of [s.leaseTemplateDocUrl, ...(s.propertyLeaseTemplates ?? []).map(t => t?.leaseTemplateDocUrl)])
    if (typeof u === "string" && u.includes("/object/public/listing-photos/")) console.log(r.id, u);
}
```

If that prints rows, the backfill is: copy each object into `lease-templates`,
rewrite the submission URL, rewrite every `generatedHtml` containing the old
URL, then remove the public object — in that order, so a failure never strands a
lease pointing at nothing.

## The agent tool could re-open the hole one property at a time

`update_property_lease_config` (`src/lib/tools/domains/properties.ts`) accepted
a model-supplied `leaseTemplateDocUrl` and wrote it to `manager_property_records`
verbatim, with no scheme or host validation. It is behind the write-tool confirm
gate, but the preview rendered only the file NAME — so the human approving it
could not see what they were attaching. Applicant-submitted text is untrusted
(AGENTS.md), so a prompt injection could steer the model into proposing a
third-party URL or a base64 `data:` PDF behind a benign label and substitute the
document residents sign.

`validateLeaseConfigInput` now accepts only a value that resolves to a stored
object — `leaseTemplateObjectPath()` (private bucket) or `listingMediaObjectPath()`
(a legacy `listing-photos` template a property may still carry and legitimately
re-apply) — and the preview carries the resolved path as a "Stored file" field.
`data:` URLs and arbitrary links are rejected. Switching a property to
`axis_default` / `custom_comments` is untouched.

`leaseTemplateObjectPath` is anchored (`startsWith`), not a substring match: a
loose match would let `https://evil.example/api/portal/lease-template?path=…`
resolve to a real object path, which both this validation and the read route's
membership check would then have treated as genuine.

Two mitigations that already held, so this was never XSS: `escapeHtml`
attribute-escapes the URL in `generated-lease.ts`, and every lease iframe is
sandboxed without `allow-scripts`.

## Coverage

- `tests/unit/public-listing-projection.test.ts` — secrets dropped at any depth,
  a newly added field is not published, every load-bearing field survives.
- `tests/unit/public-listing-cache-merge.test.ts` — caching the projection never
  downgrades the owner's stored submission, but still refreshes public fields.
- `tests/unit/lease-template-storage.test.ts` — path round-trip, traversal
  rejection, nested `propertyLeaseTemplates[]` collection, deletion skips a path
  a survivor references.
- `tests/integration/portal/lease-template-access.test.ts` — anonymous denied,
  folder owner served, property owner served when a co-manager uploaded it,
  co-manager served, approved resident served only when their property
  references the path, PENDING applicant denied, a resident whose signed lease
  embeds a no-longer-referenced template still served, a different manager
  denied, a manager who planted another manager's path on their own listing or
  in their own lease row denied, traversal rejected before storage is touched,
  `DELETE` scoped to the caller's own folder.
- `tests/unit/lease-template-storage.test.ts` also asserts a foreign URL merely
  containing the route resolves to null.

---


## The document is chosen client side, in one place

Generation is fully browser side. There is no API route in the path:

```
manager-leases-pipeline-panel.tsx  runGenerateLease(row)
  -> lease-pipeline-storage.ts     generateLeaseHtmlForRow()
       -> generated-lease.ts       leaseContextFromApplication()  (builds LeaseGenerationContext)
       -> generated-lease.ts       buildAiGeneratedLeaseHtml(ctx)
            -> buildManagerTemplateLeaseHtml   when the manager uploaded a template (returns FIRST)
            -> build{Seattle,SanFrancisco,California,Washington}LeaseHtml -> buildLeaseHtml(ctx, config)
```

`buildLeaseHtml` then picks the short-term agreement or the long-form lease.

## Stay pricing: one resolver, two consumers (Jul 2026)

### The bug

A manager reported that short-term / daily rentals were billed correctly but received the
wrong lease document, or none. There were **four** unrelated "daily rate" fields and no two
of them agreed:

| Field | Read by |
| --- | --- |
| `room.rentBasis:"daily"` + `room.dailyRentPrice` | charges, and only for **non**-short-term applications |
| `sub.shortTermDailyCost` (string) | the short-term **document** and the short-term **charges** |
| `bundle.shortTermNightlyRent` | the listing price label only. Never charges, never the lease |
| `room.prorateMethod:"daily_rate"` + `dailyRentRate` | proration of the edge months of a MONTHLY room. Unrelated, do not conflate |

### Reproduction observed (scripted, `tests/unit/stay-pricing-repro.test.ts`)

Driving the real `recordApprovedApplicationCharges` and `buildAiGeneratedLeaseHtml` on one
fixture (a $55/day room in Fremont CA, an 11-day stay), before the fix:

1. Daily room, short-term rentals **unticked**: the ledger billed **$605.00** correctly, but
   the document was the long-form residential lease quoting `$1200.00 / month` in Exhibit A.
   Right charge, wrong number. Such a placement still takes the long-form lease (see the
   `shortTermRentalsAllowed` gate below) — it now quotes `$55.00 / day`.
2. Room `$55/day` vs listing `shortTermDailyCost` `$40`, explicit short-term application: the
   ledger billed **$440.00**, the listing rate. Both sides ignored the room.
3. Listing short-term fields blank: the document rendered `— per day` and `—` for both totals.
4. Uploaded template + daily room: `<th>Monthly rent</th>` above the value `$55.00 / day`.
5. Fremont CA: the header claimed "City and County of San Francisco" and the document carried
   the SF Rent Ordinance paragraph, because any bare `ca` resolved to `san_francisco`.
6. Monthly room: unchanged. This is the regression baseline and it passed before and after.

### `resolveStayPricing` (`src/lib/room-pricing.ts`)

The single decision point. The lease document and the charge ledger both call it, so they
cannot quote different numbers for the same resident.

Precedence, in order:

1. **`rentalType === "short_term"` wins the kind outright.** Short stay, daily basis. The ROOM
   the applicant selected supplies the rate; `sub.shortTermDailyCost` is the fallback.
   A negotiated monthly rent deliberately does **not** apply here: the short-term charge branch
   does not consult `managerRentOverride` either, and letting the document do so would recreate
   the disagreement this resolver exists to remove.
2. **Negotiated monthly rent** (`managerRentOverride`, then `signedMonthlyRent`) beats the
   room's daily basis, exactly as it already beat the room's listing monthly rent. Mirrors
   `residentNegotiatedMonthlyRent` in `household-charges.ts`.
3. **A room priced by the day is a short stay ONLY when BOTH gates pass**: the listing's
   `shortTermRentalsAllowed` is ticked, AND `isIntraMonthStay(leaseStart, leaseEnd)`
   (`intraMonthStaySpan`, `short-term-stay-pricing.ts` — the same function the ledger uses),
   which is exactly when the charges settle as ONE up-front stay total.

   **Both gates are load-bearing, do not remove either.**

   - *The duration bound.* `rentBasis:"daily"` is a BILLING BASIS, and AGENTS.md defines it as
     a supported way to bill a normal tenancy (first month, each recurring month, partial last
     month). Gating the document type on the basis alone handed a 12-month daily-priced
     resident a lodger agreement that disclaims tenancy, drops the federally required
     lead-paint disclosure, deposit-return terms, entry notice and Addenda A-E, and states a
     single up-front total the ledger never bills. With unknown or open-ended dates the
     resolver returns `"long"`: the expensive mistake is giving a real tenant a document that
     denies their tenancy.
   - *The `shortTermRentalsAllowed` tick.* The short-term document asserts
     `Owner-Occupied Residence` in its header and `Owner/Host lives on or controls the
     property` in Section 10, and disclaims tenancy. A billing-basis flag plus two dates
     establishes none of that, so an EXPLICIT manager signal is required before the lodger
     document can render. **This deliberately overrides the original task brief**, whose
     acceptance criterion said an unticked listing should still produce the short-term
     agreement; the user reviewed the finding and chose the override, because asserting
     owner-occupancy on the strength of a pricing flag is a legal claim the data does not
     support. An unticked daily-priced listing now gets the full residential lease, which is
     safe because that lease quotes the daily rate (see "The long form is daily-aware" below).
   - `rentalType === "short_term"` is itself an explicit declaration, so clause 1 above still
     wins outright regardless of either gate.

   `basis` stays `"daily"` in every outcome, so rent labels follow the real rate either way.
4. Otherwise the room's monthly rent. Byte-identical to legacy behavior.

**`stayKind` chooses only the DOCUMENT; it never moves a charge.** The ledger's `dailyBasisRate`
path is keyed on the room, not on `stayKind`, so flipping the tick changes which agreement
renders and nothing about what the resident owes. `tests/unit/daily-rent-charges.test.ts` is the
guard and passes unmodified.

### The long form is daily-aware

Because a daily-priced room is now routed to the residential lease far more often, that branch
consumes `stay` too. When `stay.basis === "daily"`:

- the rent figure is the daily rate (`$55.00 / day`), and every rent label follows the basis
  (`Daily base rent`, never `Monthly base rent` over a per-day figure), in Section 4 and in
  Exhibit A;
- the **Total monthly payment** row is omitted. Adding a per-day rate to a monthly utilities
  figure is meaningless, and `DAILY_RENT_MONTH_ESTIMATE_DAYS` is display/sort-only and must
  never reach a lease. A prose sentence states the real rule instead: each month bills the
  actual days of the term in that month × the daily rate, and utilities are prorated for a
  partial month;
- Section 5 renders as **Prorated Utilities**, not **Prorated First Month**. Only the RENT half
  is suppressed (prorating a monthly rent would read `55` as a monthly figure, and every month
  already bills by real days). Utilities are still a monthly estimate that the ledger prorates,
  so suppressing the whole section left that undisclosed while the Section 4 prose asserted the
  opposite. `proratedBlock` has one implementation with two modes (`utilitiesOnly`), and the
  utilities mode mirrors `leaseFirstPeriodProration` exactly — including the intra-month
  collapse (an intra-month daily lease prorates across the WHOLE term, not from lease start to
  month end) and the `daily_rate` / `dailyUtilitiesRate` branch. The amount is passed in as the
  ledger's billable monthly utilities, never parsed back out of the display label.
  Coverage: `stay-pricing-repro.test.ts` case 15;
- a month-to-month surcharge is NOT folded into the rate (that would print a daily rate $25 too
  high); it stays its own monthly line.

**When a billing snapshot exists, the prorated block PRINTS the ledger's own
numbers.** `proratedBlock` still computes days-remaining × rate for the table's
rate and day columns, but `ledgerProratedRent` / `ledgerProratedUtilities` (from
`ctx.leaseBilling`) override the amounts and the total when present — so the
document cannot quote a first-month figure the ledger will not charge, which is
the same rule as `resolveStayPricing`. It also makes the section render for a
lease starting on the 1st, which the day-based math alone would have suppressed:
a snapshot with a prorated amount means there IS something to disclose.

**The deposit keys on `rentalType`, not on the resolved `stayKind`.** That asymmetry is
deliberate and load-bearing: only an explicit short-term application is charged
`sub.shortTermDeposit`; a daily-priced room on a standard application is charged
`sub.securityDeposit`. The document has to quote whichever one the ledger will actually bill,
so it follows the same key. The move-in fee in the short-term document follows the same rule
(`shortTermMoveInFee` vs `moveInFee`), and utilities are added to the stay total only for a
standard application, because an explicit short-term nightly rate is all-in.

`managerSecurityDepositOverride` beats both, and a NON-EMPTY override wins even when it parses
to zero (`overrideMoney`, mirroring the ledger's `savedAmount`). Treating "0" as absent made a
waived deposit fall back to the listing default, so the document printed a deposit the ledger
never charged.

**`leaseStart` / `leaseEnd` are REQUIRED, not decorative.** They feed `isIntraMonthStay`, which
is half the gate in clause 3, so a new call site that omits them silently resolves `"long"` and
renders the full residential lease for a real short stay — with no test failure, since every
existing test passes dates. Failing to `"long"` is the safe direction, not a correct one.

Night counting stays in `shortTermStayNightCount` (`short-term-stay-pricing.ts`), the one
implementation the ledger bills from. `build-lease-html.ts` used to re-implement it inline with
bare `new Date("YYYY-MM-DD")`, which parses as UTC and could land a day away from the charges.

`room-pricing.ts` must **never** import `generated-lease.ts`, which imports it. It may import
`parse-money` and `short-term-stay-pricing` (both verified acyclic).

### One rule, one implementation — the three dedups

A resolver that both sides call is worthless if either side can feed it different inputs, so
the inputs are shared too. Never re-add a second copy of any of these.

| Rule | The ONE implementation | Was duplicated in |
| --- | --- | --- |
| Is this lease a single intra-month billing span? | `intraMonthStaySpan` (`short-term-stay-pricing.ts`) | a private `intraMonthLeaseSpan` in `household-charges.ts` |
| Which room of the submission is this application on? | `resolveSubmissionRoom` (`listing-room-resolution.ts`) | inline chains in `household-charges.ts` and `build-lease-html.ts` |
| What is this room's rent line? | `submissionRoomRentLabel` (same module) | `findSubmissionRoomRent` / `submissionRoomRentFromChoice`, once in `generated-lease.ts` (daily-aware) and again in `build-lease-html.ts` (monthly-only) |

**`resolveSubmissionRoom` precedence**: room-choice ids in the order given → unique
`signedMonthlyRent` match → unit-label name match (exact, then partial) → the only room → the
only `daily_rate` room. The exact rent figure deliberately outranks the fuzzy label substring
match. Callers pass an ALREADY-NORMALIZED submission.

**Both consumers must pass the SAME inputs, including `unitLabel`.** One shared implementation
fed two different argument sets is still two answers: while the ledger passed no label and the
label outranked the signed rent, an application whose `roomChoice1` carried no `listingRoomId`
resolved to the label-matching room in the document and the rent-matching room in the ledger —
two rooms, two rates, the original bug. The ledger now passes its listing property's
`unitLabel`. Coverage: `stay-pricing-repro.test.ts` case 16.

Two knock-on notes in `build-lease-html.ts`: `wholeHome` is now derived from the LISTING
(`isEntireHomeListing` / no named rooms) rather than from "no room record resolved", because the
shared chain can match a single unnamed room on an entire-home listing; and the whole-home label
is checked before the room name so entire-home premises still read `Entire home`.

**Money-path behavior change from the span dedup:** the ledger used to split lease dates strictly
on `-`, so a non-ISO date (which `manualResidentDetails.moveInDate` / `moveOutDate` can
legitimately be, e.g. `3/10/2026`) silently fell out of the intra-month collapse and was billed a
first-month AND a last-month charge for the same days. Both sides now parse through
`parseFlexibleLocalDate`, so such a lease collapses to one charge. Coverage:
`stay-pricing-repro.test.ts` case 14.

**Money-path behavior change from the DST-safe night count:** `shortTermStayNightCount` is what
the ledger bills `stay_total` from, and it used to be
`Math.ceil((end - start) / 86_400_000) + 1` on raw local timestamps. A span crossing a
daylight-saving fall-back gains an hour, which pushed the `ceil` up a whole day and billed an
extra night. `calendarDaysBetween` now normalizes both ends to UTC midnight before dividing, so
a 2026-11-01 → 2026-11-10 stay at $80/night in US/Pacific bills **10 nights / $800** where it
previously billed 11 / $880. The new count is the correct one, but it reprices existing
fall-back-crossing stays on regeneration.

### Utilities on a stay follow the ledger's two branches

`rentBasis: "daily"` and `prorateMethod: "daily_rate"` are independent per-room fields that
AGENTS.md says coexist. The ledger prorates a stay's utilities as
`billableDays × dailyUtilitiesRate` when the room has `prorateMethod === "daily_rate"` and a
positive `dailyUtilitiesRate`, and as `monthlyEstimate × (billableDays / daysInMonth)` otherwise.
The short-term document's `Utilities estimate` row implements the same two branches, or its
`Total due` disagrees with the charges for any room carrying both fields.
Coverage: `stay-pricing-repro.test.ts` case 11.

### The lease states the deposit OBLIGATION, never the running balance

The approval charges bill `Math.max(0, securityDeposit - paidHoldingDepositCredit)`, which is a
different number from the deposit the lease agrees to. **Do not try to close that gap by
printing the net on the document.** An earlier pass did, by threading a
`LeaseGenerationContext.holdingDepositCreditUsd` read from the charge store, and that re-created
the exact mismatch class this whole change exists to remove: the credit was snapshotted at
document-generation time and again at charge-generation time, and the two orderings disagree.
Generate the lease before the holding deposit is paid and it permanently overstates the deposit
(`generateLeaseHtmlForRow` refuses to rebuild once the lease carries a signature); generate it
after and the reverse. Persisting a snapshot on the pipeline row does not fix it either — it
adds a persisted field, couples lease generation to the charge store, and keeps the ordering
window.

The document therefore quotes the **gross deposit**, which is fixed at signing, plus a standing
sentence (`HOLDING_DEPOSIT_CREDIT_NOTE` in `build-lease-html.ts`) stating that any holding
deposit already paid is credited against it on the resident's ledger. That sentence is true
whether or not a credit exists, so no ordering can falsify it. It renders on both branches,
beside the deposit table.

**The charge ledger and the Payments surface remain the sole authority for the net balance**, and
they were already correct. Coverage: `stay-pricing-repro.test.ts` cases 12 and 13 — 12 generates
the same lease before and after a holding-deposit payment and asserts the documents are
byte-identical while the ledger's `security_deposit` charge drops to the net.

### Executed short-term clauses added in this change (user-approved)

These are new contract terms a guest signs, not a pricing change, and they were approved
explicitly and separately from the stay-pricing work (Jul 2026):

- **8. Revocation of Permission** — permission-based occupancy, revocation for enumerated
  conduct, and law-enforcement removal after check-out.
- **9. Damages and Liability** — guest liability for damage beyond ordinary wear, and a
  limitation of the host's liability for the guest's belongings.
- Section 5 retitled **Purpose of Stay → Lodger Status**.

Every obligation and every liability limitation in those sections carries an explicit
"to the extent permitted by applicable law" qualifier plus a non-waiver sentence, so nothing
reads as an unqualified waiver of a resident's statutory rights. No statute is cited.
**Any future edit to executed-contract wording needs the same explicit approval.**

### Charge path change, and its live-data consequence

`household-charges.ts` now resolves the room **before** the short-term branch (it used to
resolve it after, so the branch was structurally unable to see the room) and prices the stay
through the resolver.

**Behavior change on a money path:** a listing carrying both a room `dailyRentPrice` and a
listing `shortTermDailyCost`, with an explicit short-term application, now bills the room's
rate where it previously billed the listing's. That is the intended correction (the room the
applicant selected is the authority for its own price), but a regeneration on such a row will
move the amount.

### A future-dated lease was billed twice for its move-in month (fixed)

Found by the document-vs-ledger invariant test, pre-existing and NOT specific to daily rooms.

`syncAllRecurringRentCharges` looked one month ahead (`monthsToGenerate.add(nextMonth)`) with
no floor. A recurring profile's `startMonth` is deliberately the month AFTER move-in
(`firstRecurringMonthAfterLeaseStart`) because the move-in month is already covered by the
upfront first-month/prorated charges. For any lease starting in a future month, `nextMonth`
was therefore EARLIER than `startMonth`, and the pass generated a second `rent` row for the
month the upfront charge had already billed. An 11-day $55/day stay came to $2,612.90 instead
of $1,847.58.

It only ever reproduced for a future-dated lease, which is why the existing suites missed it:
they all use past fixture dates, and past months are never generated. The guard is now
`if (nextMonth >= profileStartMonth)`. Coverage: `stay-pricing-repro.test.ts` cases 9 and 10,
both of which derive their dates from the clock so they stay future-dated forever.

## Legal guardrails

**Never author, infer, or paraphrase a statute citation.** A plausible-looking wrong citation
on an executed lease is the worst thing this module can produce.

- **There is no lodger statute anywhere in this repo.** `leases/disclosure-clause-rules.json`
  was checked: no `1946.5`, no `lodger`, for either CA or WA. The short-term document's
  **Lodger Status** section therefore renders `config.shortTermPurposeParagraph` unchanged, so
  Washington keeps its existing RCW 59.18.040 reference and California cites nothing.
  **Open gap for the next wave:** if a verified CA lodger citation (Cal. Civ. Code 1946.5 is
  the likely one) is added to `disclosure-clause-rules.json` with `cite_verified: true`, add an
  optional `shortTermLodgerStatuteRef` to `LeaseJurisdictionTemplateConfig` and render it in
  that section. No such field was added here, because it would have carried zero values.
- **`leases/disclosure-clause-rules.json` is reference material and is never parsed at
  runtime.** `leases/lease-generation-manifest.json` still lists wiring it into the section
  renderer as a TODO. `build-lease-html.ts` hardcodes its own disclosures.
- Two hardcoded Washington citations used to print on **every** California lease
  (`Landlord responsibilities (RCW 59.18.060)` and Addendum C's `(RCW 59.18.130)`). They sat
  outside the `config` mechanism. Both are now routed through config rather than deleted,
  because deleting them stripped a CORRECT citation from every Washington lease:
  - Addendum C uses the existing `residentMaintenanceStatuteRef` (already RCW 59.18.130 for
    WA, "California Civil Code" for CA). No new field.
  - The landlord-duty heading uses a new **optional** `landlordMaintenanceStatuteRef`, set to
    RCW 59.18.060 for Seattle and Washington and deliberately **unset** for California and San
    Francisco, where it renders with no citation. Nothing was authored: RCW 59.18.060 was
    already in the file. Populate the CA side only from a verified source.

## Jurisdiction resolution: city match first, then statewide

`resolveLeaseJurisdiction` (`src/lib/lease-jurisdiction.ts`) regex-matches the property address.
It resolves five values: `seattle`, `san_francisco`, `california`, `washington`, `unsupported`.

### Jurisdiction registry and disclosure bridge

The typed contract is `JurisdictionKey` (`{ state: string; city?: string }`), where state is a
two-letter USPS abbreviation and a city is a normalized registry key. New code calls
`resolveJurisdiction(ctx)`, `jurisdictionConfig(key)`, and `jurisdictionRuleScopes(key)`.
`resolveLeaseJurisdiction` remains only as a compatibility adapter for legacy string-union callers.

`LEASE_JURISDICTION_TEMPLATE_REGISTRY` in `src/lib/lease-templates/types.ts` is code-owned. A
state entry provides its verified config and rules-catalog state scope; city entries provide only
verified local config overlays. Adding a state therefore means adding one verified config entry
and its verified disclosure rules, without adding an HTML builder. Do not add a state without
verified sources for every populated config value.

`jurisdictionRuleScopes` reads city inheritance from
`leases/disclosure-clause-rules.json#jurisdiction_inheritance`. Its current mappings are:

| JurisdictionKey | Rule scopes |
| --- | --- |
| `{ state: "CA", city: "san_francisco" }` | `federal`, `california`, `san_francisco` |
| `{ state: "CA" }` | `federal`, `california` |
| `{ state: "WA", city: "seattle" }` | `federal`, `washington`, `seattle` |
| `{ state: "WA" }` | `federal`, `washington` |

Property records currently have joined `address`, `neighborhood`, and separate ZIP values, but
not separate property city/state columns. The resolver still accepts structured `city`, `state`,
and `postalCode` fields for a future record shape, and prefers them when present; joined-address
matching remains the fallback today.

There is still no lodger-statute config field. The CA and WA rules catalog contains no verified
lodger statute for this purpose, so none is inferred or cited.

#### Router integration status

The registry contract is independent of manager-template selection. The router migration must
wait for P6's `selectLeaseTemplateDoc(ctx, stayKind)` interface: it resolves stay pricing before
template selection, returns a typed unsupported-jurisdiction outcome instead of throwing, routes
standard documents through `jurisdictionConfig`, and updates these callers: lease pipeline
generation/gating, property lease preview, and lease amendment regeneration. It also writes the
generated standard document's `executedJurisdiction` as `US-CA`, `US-CA/san_francisco`, `US-WA`,
or `US-WA/seattle`; it never writes `documentSha256`. An uploaded template on an unsupported
state remains generatable, but no generated jurisdiction provenance is asserted for that manager
document.

The two statewide values were added because the state rules used to fall through to the CITY
templates, so a Fremont CA property generated a lease claiming "City and County of San
Francisco" and citing the SF Rent Ordinance. Explicit city names, the Ave NE street pattern,
the Oregon exclusion, and the 981xx / 941xx ZIP rules all still run first and are unchanged, so
Seattle and San Francisco resolve exactly as before.

`CALIFORNIA_LEASE_CONFIG` and `WASHINGTON_LEASE_CONFIG` live in their own modules
(`lease-templates/california.ts`, `washington.ts`) rather than in `types.ts`. Each is the
matching city config with every city-specific claim **removed**: no
`municipalComplianceParagraph`, a state-only `headerSubtitle`, and a governing-law paragraph
without the city-ordinance clause. Every statute reference carried over is already state level
(RCW chapter 59.18, California Civil Code), so no citation was authored.

## Jurisdiction-specific numeric terms

Three figures used to be hardcoded in the long-form body with Washington values, so every
California lease printed a WA notice period, a WA deposit-return window, and a WA minimum
heat temperature. They are now OPTIONAL config fields
(`monthToMonthTerminationNotice`, `depositReturnWindow`, `minimumHeatTemperature`),
populated for Washington and Seattle from the values that were already in the repo and
deliberately UNSET for California and San Francisco, where they fall back to language that
asserts no figure at all ("as required by applicable law").

That asymmetry is the same rule as the lodger statute: a wrong number on an executed lease is
worse than no number. Do not populate a jurisdiction's field without a source verified for
THAT jurisdiction.

**The Entry section has a Washington variant, selected by the CITATION string.**
`washingtonStyleEntry` is `config.landlordEntryStatuteRef?.includes("RCW")` — WA
and Seattle print "notice required under Washington law" rather than the generic
"at least 24 hours' advance written notice", because the fixed 24-hour figure is
a WA-specific number that was being asserted everywhere. Both variants state
emergency entry and that shared/common areas carry no exclusive possession. The
heading is "Entry", not "Landlord Entry", in both the long form and the
short-term document. Deriving the variant from a citation substring is
deliberate shorthand, not a general jurisdiction switch: a future config that
cites an RCW for some other reason would inherit the WA wording, so give the
variant its own config flag before adding one.

`SEATTLE_LEASE_CONFIG` now derives from `WASHINGTON_LEASE_CONFIG` and
`SAN_FRANCISCO_LEASE_CONFIG` from `CALIFORNIA_LEASE_CONFIG` (spread + override), so a
state-level statute or term is written once. Duplicating them meant a citation update had to
land in two places per state, and a missed one silently shipped a stale citation.

Coverage: `tests/unit/stay-pricing-repro.test.ts` asserts a California lease contains none of
the three WA figures and that a Washington lease still contains all of them.

## The document never asserts a credit the ledger will not apply

`HOLDING_DEPOSIT_CREDIT_NOTE` renders only when `rentalType !== "short_term"`. The ledger
credits a paid holding deposit on its STANDARD branch only; the explicit short-term branch
charges the full `shortTermDeposit` and returns before that code. Keyed on `rentalType`, not
on the resolved `stayKind`, for exactly the same reason the deposit amount is: the stay
document also backs a standard application, and in that case the credit IS applied.

## Partial months: BOTH boundaries, and the document names the month

A lease that starts mid-month and ends mid-month has two partial calendar months, and the
ledger has always billed both — `prorated_rent` / `prorated_utilities` at the start, and
`prorated_last_month_rent` / `prorated_last_month_utilities` created up front at approval but
DUE about a week before the term ends (`lastMonthChargeForLeaseEnd`'s `dueDateLabel`). The
document used to name only the first one, so a resident received a charge for an amount their
executed lease never stated.

- **One calculation, two consumers.** `proratedLastMonthAmount` and
  `computeProratedLastMonthTotals` (`lease-first-period-proration.ts`) hold the arithmetic;
  `lastMonthChargeForLeaseEnd` in `household-charges.ts` calls the first, the templates call
  the second. The two branches are the ledger's own: a daily-priced room bills its partial last
  month per day whatever `prorateMethod` says, an explicit `daily_rate` method does too when it
  carries a rate, everything else is monthly × day factor. Do not re-derive either side.
- **`endsInsideFirstMonth` is the double-bill guard.** A daily-priced term that begins and ends
  inside one calendar month is billed once as its first period, so the ledger creates no
  last-month charge — and the document must skip it on exactly that condition, which is why the
  flag is an input rather than something the helper infers.
- **Every partial-month line names its calendar month** (`prorationMonthLabel`, pinned to
  `en-US` because the string lands in an executed document): "Prorated Rent for September 2026",
  "Last Month's Rent for December 2027". A bare "prorated rent" is the line residents and
  managers misread most.
- **Last month's rent is NOT due at signing.** It appears on the payment schedule with its own
  due date and is deliberately absent from the due-at-signing list, because
  `computeLeasePaymentAtSigning` sums only what `paymentAtSigningIncludes` names and there is no
  option id for it. Folding it into the signing total would make the document disagree with the
  charge. A manager who wants it collected at signing needs a new
  `PAYMENT_AT_SIGNING_OPTIONS` entry wired through the ledger's due date too — not a template
  change.
- **Both generic templates are grouped the same way**: monthly charges, fees and deposit, then
  the initial payment. The short-term stay agreement gained the matching **Stay Summary** block,
  which sits ABOVE Section 1 and adds no row to the Section 4 payment table — that table remains
  the single place the "Total due" figure the ledger invariant is asserted against is stated
  (`stay-pricing-repro.test.ts` and `lease-e2e-artifacts.test.ts` both parse it by splitting on
  the Section 4 heading).
- **A residual ledger oddity, mirrored deliberately.** A MONTHLY-priced lease that starts and
  ends inside one calendar month gets both a first-period and a last-month charge, because
  `endsInsideFirstMonth` only guards the daily-priced case. The document now states whatever the
  ledger bills, so the two agree; fixing the overlap belongs on the ledger side.
- Coverage: `tests/unit/lease-prorated-schedule.test.ts` (the 4709A Room 2 lease: Sep 22 2026 →
  Dec 1 2027, monthly and `daily_rate` variants, long-form and compact),
  `lease-first-period-proration.test.ts`, `short-term-lease-html.test.ts`.

## One room lookup on the ledger side

`resolveRowSubmissionRoom` / `roomForRow` are the only way `household-charges.ts` picks a
room, and they call the shared `resolveSubmissionRoom`. `selectedRoomRentAmount`,
`selectedRoomUtilities`, `selectedRoom`, and `recordApprovedApplicationCharges` previously
resolved it three different ways, so one approval could bill rent off one room and utilities
off another while the lease quoted a third. The private `findRoomInSub` is deleted; do not
reintroduce a local lookup.

## Known gaps, not fixed here

- **Uploaded-template properties never reach the short-term agreement.**
  `buildAiGeneratedLeaseHtml` returns `buildManagerTemplateLeaseHtml` before the jurisdiction
  dispatch, so a nightly stay at such a property gets the monthly-worded Placement Summary. The
  rent LABEL there now follows the resolved basis, but the document shape does not.
- **`bundle.shortTermNightlyRent` is advertised but never billed.** Listing cards show it;
  neither the ledger nor the lease uses it. Both fall back to the listing default.
- **Drifted duplicate helpers.** `escapeHtml` and `dash` still exist in both
  `generated-lease.ts` and `build-lease-html.ts`. They are pure formatters that have not
  drifted, so they were left alone; the room-rent pair that HAD drifted is now the shared
  `listing-room-resolution.ts` (see "One rule, one implementation" above).
- **Short-term default check-in time is `"10:00 PM"`** (`build-lease-html.ts`), which reads like
  a typo for an afternoon check-in such as 3:00 PM.
- **`parseMoneyAmount` concatenates every digit run**: `"500 refundable + $100 cleaning"` parses
  to `500100`, and that figure is both charged by the ledger and now printed on the lease. The
  fix (take the first numeric run, as `parseAmount` in `build-lease-html.ts` does) belongs in
  `parse-money.ts` and would move existing charge amounts, so it was left alone here.
- **The document cannot see `manualResidentDetails`.** For a manually-added resident the ledger
  prefers `manualResidentDetails.securityDeposit` and suppresses listing defaults entirely
  (`allowListingDefaults = !row.manuallyAdded`); the builder only receives the application, so
  it still quotes the listing default. Pre-existing.
- **A "3-day pay-or-vacate / 10-day cure" framing is still hardcoded** in the Default &amp;
  Remedies section. It sits beside `defaultNoticeStatuteRef` but is not driven by it, so it
  reads as a nationwide rule. Same class as the three numeric terms fixed below; it needs its
  own optional config field and a verified figure per jurisdiction.
- **Dates render as raw ISO** (`2026-08-03`) on both documents rather than a written-out date.

## Per-stay-kind templates and Terms Rider (P6)

Lease configuration is already stored additively in `property_data` JSON through
`ManagerListingSubmissionV1.propertyLeaseTemplates[]`. Each row owns its own
`leaseConfigMode`, `leaseCustomKind`, `customLeaseTerms`, `leaseTemplateDocUrl`,
and `leaseTemplateDocName`. The legacy top-level fields remain the long-term
compatibility representation for listings saved before the template array
existed. No migration is needed.

**Templates are opt-in — a property starts with none, and nothing creates one on
a manager's behalf.** `syncPropertyLeaseTemplatesFromListing` only refreshes rows
that already exist and deliberately has no else-branch that creates one;
`readPropertyLeaseTemplates` returns `[]` for an empty list, keeping its
"Primary lease" fabrication only where it migrates a legacy property whose lease
config still sits in the pre-template top-level fields. Auto-creating every seed
on every sync is why every property showed the same rows and why Delete could
never stick — the next sync recreated whatever was removed. Adding is an explicit
manager act: the property's Lease tab authors a row through
`property-lease-form-modal.tsx` / `property-lease-upload-modal.tsx`, and
`availableLeaseTemplateSeeds()` / `addLeaseTemplateFromSeed()` are the API for
adding one of the DEFAULTS — the latter refuses a duplicate seed key, because two
templates matching one lease term would leave the applicant-term router
ambiguous. Those two defaults are long-term (`listingSeedKey: "primary"`) and
short-term (`listingSeedKey: "short-term"`); the two bundle seeds were retired,
since a bundle is a pricing arrangement rather than a lease format. A seed key the
catalog no longer offers is dropped on sync **unless the manager edited that
row** — custom terms, an uploaded document, or an HTML override — in which case
it is carried over rather than deleted with the seed. Its application-template
twin (`syncPropertyApplicationTemplatesFromListing`) follows the same rule, where
the only manager-owned content on a seeded row is its renamed label. Coverage:
`tests/unit/property-lease-template-opt-in.test.ts`,
`tests/unit/property-lease-template-sync.test.ts`.

Because a property may legitimately hold zero templates, the generate modal's
picker (`listLeaseTemplateGenerateChoices`) lists one row per template the
property actually has, best match first, and an empty list is not an error — the
modal says so and generation falls back to the property's own lease terms,
exactly as approval-time auto-generation already does.

`selectLeaseTemplateDoc(ctx, stayKind)` in `generated-lease.ts` is the only
uploaded-document selector for this path. Its behavior is intentional:

| Long-term template | Short-term template | Long stay | Short stay |
| --- | --- | --- | --- |
| configured | configured | long-term PDF | short-term PDF |
| configured | missing | long-term PDF | generated stay agreement |
| missing | configured | generated long-form lease | short-term PDF |
| missing | missing | generated long-form lease | generated stay agreement |
| legacy single top-level PDF | no per-stay rows | legacy PDF | generated stay agreement |

There is no long-term-to-short-term fallback. Serving a residential template to a
guest is less safe than using PropLane's generated short-stay agreement. The manager
lease modal states this rule and bulk editing applies only the selected agreement type,
leaving the other type unchanged.

For an uploaded PDF, PropLane does not rewrite, flatten, overlay, or otherwise edit
the manager's source document. `buildManagerTemplateLeaseHtml` shows a Terms Rider
instead of the old placement-summary table. The PDF path uses
`appendLeaseTermsRiderToPdf`: base PDF, then rider, then the existing electronic
signature certificate. The rider states the resident, property and room, stay dates,
rent basis and resolved rate, deposit, any charge-backed fees, and this precedence
clause: "If this Terms Rider conflicts with the base document, this Terms Rider
controls for that conflict." Rates and deposits are resolved with `resolveStayPricing`;
fees come only from the billing snapshot, so the rider does not invent a ledger value.

The combined base-PDF-plus-rider bytes are stored in
`managerUploadedPdf.originalDataUrl` before sending for signature. Therefore each
signature's `documentSha256` covers both the uploaded legal document and the binding
rider. The certificate stays outside that hash and is appended last because it is a
post-signature platform artifact. A signed row cannot replace `originalDataUrl`, so
the rider is never inserted after a party has signed. Manager-uploaded templates also
record `templateVersion` as `<template id>@1.0.0` (or
`legacy-manager-uploaded@1.0.0` for a pre-array listing). Generation freezes the
selected template URL, display name, and version on the unsigned lease row, so a
later listing-settings change cannot swap the reviewed PDF during send.

Not built: AcroForm filling. A future upgrade can inspect
`pdf.getForm().getFields().length`, set verified named text fields, and flatten the
form when fields exist. PDFs without fields still use the rider. DOCX template upload
remains out of scope.

## Coverage

| Test | What it pins |
| --- | --- |
| `tests/unit/stay-pricing.test.ts` | the resolver in isolation: all four precedence rules, both `stayKind` gates, both deposit branches, monthly no-ops |
| `tests/unit/stay-pricing-repro.test.ts` | document and ledger agree, end to end, on one fixture. This is the reproduction, flipped. Also the daily long form (8), stay utilities (11), the deposit obligation being unmoved by a holding-deposit payment (12, 13), the non-ISO span (14), daily long-form prorated utilities (15), and shared room resolution (16) |
| `tests/unit/daily-rent-charges.test.ts` | the monthly charge path is unmoved (`$851.61`, `Rent — April 2026`, no `/day`) |
| `tests/unit/lease-jurisdiction.test.ts` | address to jurisdiction, including the statewide fallbacks |
| `tests/unit/generated-lease.test.ts` | long-form document content |

## P9 long-term lease parity

### Measured reference and generated-document gap list

On 2026-08-02, the Seattle reference at
`/Users/akhilvemuri/Downloads/FILE_6215.pdf` was extracted with `pdftotext` and
read in full. The comparison target was a Seattle long-term room placement from
the generated builder, using the same room, rent, utilities, deposit, move-in
fee, and charge snapshot inputs used by the new unit coverage.

| Reference topic | Result in generated long form |
| --- | --- |
| Lease Summary | Already present for branded Seattle leases with billing data. P9 adds Landlord and reads rent, utilities, total monthly payment, and payment due at signing from the billing snapshot. First partial month is one combined ledger-derived amount. |
| Parties, premises, lease term, rent, deposits, returned payments, utilities, occupancy, shared spaces, rules, pets, maintenance, entry, assignment, insurance, default, early termination, payment order, notices, lead paint, governing law, attorney fees, application, schedule, signature, Addenda A-E | Already present, with stable tested order. |
| Delivery of possession | Added. It states delayed-possession rent abatement and defers remedies to applicable law. The reference's fourteen-day termination interval is deliberately not copied. |
| Early termination economics | Rendered when a break-lease fee or lease-up percentage resolves — from the listing, else from the jurisdiction default (see below). It itemizes the fee, the lease-up percentage, continuing liability until replacement possession or end of term, any re-rent shortfall, and actual re-renting costs. |
| Holdover | The fixed-term Lease Term section now states unconditionally that the lease terminates at the end of the term and does not convert to month-to-month, with a 12:00 PM vacate time. A per-day holdover charge is appended only when a daily rate resolves. A month-to-month lease instead prints `monthToMonthTerminationNotice`. |
| Deposit labor and reissue fees | The deduction categories were present. Labor and reissue amounts now render only from optional listing fields. |
| Move-in condition | Existing Addendum A supplies the area-by-area report. P9 removes the unrelated five-day default and makes a signed report supersede the baseline acknowledgement. |
| Utility usage, trash, cleaning access | Existing usage language is retained. Trash fee is listing-configured; cleaning and access responsibilities are now explicit. |
| Bathroom sharing, quiet hours, guest cap | Bathroom wording now derives from the room-to-bathroom listing assignment. Quiet hours and guest cap render only when configured. |
| Safety devices and fire safety | Maintenance now includes smoke alarms, CO alarms, egress, and water-heater controls. Citations are optional config fields and are unset pending verification. |
| Keys and access devices | Already present in the Entry section (titled "Landlord Entry" before the WA rewrite below). |
| Move-out and professional cleaning | Added only when the listing requires it. It requires a paid invoice and limits any deduction to a documented invoice and applicable law. |
| Venue | Renders only from the optional listing venue field. |

### New optional listing fields

All fields below live on `ManagerListingSubmissionV1`. Empty, invalid, or absent values
normalize to `undefined`. The builder omits the associated term rather than printing a
zero or a term borrowed from another listing — with one exception, the three termination
fields, which now fall back to a platform default (see below the table).

| Field | Renders when set | Unset behavior |
| --- | --- | --- |
| `longTermBreakLeaseFee` | fixed early-termination fee | **jurisdiction default** (WA `$900`), else absent |
| `longTermLeaseUpFeePercent` | percentage lease-up fee | **jurisdiction default** (WA `100%`), else absent |
| `longTermHoldoverDailyRate` | per-day holdover charge | **jurisdiction default** (WA `$45`), else absent — the no-conversion statement renders either way |
| `longTermReturnedPaymentFee` | returned-payment fee | fee sentence absent; general actual-cost language remains |
| `longTermDepositLaborRate` | manager labor rate in deposit deductions | generic documented-cost language |
| `longTermDepositReissueFee` | stop-payment or refund reissue fee | sentence absent |
| `longTermTrashViolationFee` | per-occurrence trash fee | fee sentence absent |
| `longTermQuietHours` | quiet-hours rule and Addendum E rule | quiet-hours rule absent |
| `longTermGuestCap` | gathering cap and Addendum E rule | cap rule absent |
| `longTermDisputeVenue` | venue sentence | sentence absent |
| `longTermProfessionalCleaningRequired` | professional-cleaning move-out section | whole move-out section absent |

**The three termination fields above are no longer omit-when-unset.** They now fall
back to platform defaults on two levels: `createDefaultListingSubmission` seeds a
new listing with `$900` / `100%` / `$45`, and
`WASHINGTON_LEASE_CONFIG` supplies the same figures as
`defaultLongTermBreakLeaseFeeUsd` / `defaultLongTermLeaseUpFeePercent` /
`defaultLongTermHoldoverDailyUsd` for any listing that carries none
(`resolveLongTermFeeAmount` in `build-lease-html.ts`). These are commercial
defaults for this operator, NOT statutory figures, and no other jurisdiction sets
them — a California lease still omits the terms entirely. An explicit listing
value always wins, and a listing value of `0`/blank is treated as "not set", so
it inherits the default rather than printing a zero. The fees also render as rows
in the Exhibit fee table. When you add a jurisdiction, do not copy these numbers
into it; they are one operator's terms, not a state rule.

`lateFeeAmount` and `lateFeeEnabled` already existed. The long form uses the listing's
configured late fee when supplied and omits the late-fee paragraph when it is disabled.
The existing `monthToMonthSurcharge` is not rendered because the billing snapshot and
household-charge ledger do not charge it.

### Citations added in the template config

P9 adds optional config slots only: `returnedPaymentStatuteRef`,
`earlyTerminationStatuteRef`, `smokeAlarmStatuteRef`, and
`carbonMonoxideAlarmStatuteRef`. No citation value is populated in any of them, for any
jurisdiction. The reference PDF is a source for this manager's commercial terms, not
verification for a state statute — and neither is `leases/seattle/sample-lease.md`, which
is a rendered sample carrying the same unverified citations. The regression test proves an
unset citation still renders the returned-payment clause without a Washington citation.

### Deliberately deferred clauses

- The reference's fourteen-day delayed-possession termination, its 14-day move-in report
  deadline, detailed liability cap and indemnity, crime, package, parking, bike-storage
  allocation, and the complete lettered maintenance list are not default platform terms.
  They need manager-controlled data and legal review before they can be emitted.
- The reference's Washington citations for late possession, early termination, smoke
  alarms, CO alarms, and cure procedures were not added or inferred. A verified official
  source is required before populating a jurisdiction config.
- The disclosure rules engine owns lead-paint disclosure content. P9 does not add a second
  disclosure or change its trigger.
- These optional fields have a normalization and generation path, but the manager listing
  form does not yet expose controls for them. They are therefore available to trusted listing
  imports and persisted submissions only. A manager-facing configuration surface is required
  before presenting these terms as self-serve product functionality.

### P9 coverage

`tests/unit/long-term-lease-parity.test.ts` pins the long-form heading order, configured
amount movement, absence of all new commercial clauses when unset, California output with
an unset citation, summary values sourced from the billing snapshot, and byte-identical
short-term output when only long-term fields change.

## Manager lease-body edits (P8)

The manager-side lease-pipeline editor is intentionally a small HTML-source editor with a
side-by-side preview. It is available only for a generated HTML lease in Manager Review,
while `leaseAllowsManagerDocumentEdits(row)` is true. Uploaded-template PDFs are excluded:
their base document plus P6 Terms Rider remains the manager's original agreement bytes.

### Stored HTML policy

`src/lib/lease-document-sanitizer.ts` is the sole allowlist. It permits document structure
and typography only: document, heading, text, list, table, and basic layout tags, plus a
small set of structural attributes. It removes scripts, unsafe styles, event handlers, links and
URL-bearing attributes, iframes, objects, images, forms, SVG, and external-resource tags.
Existing document CSS is preserved byte-for-byte only when it contains no CSS escapes,
URL-bearing syntax, external at-rules, or executable CSS constructs; unsafe styles are removed.
It runs in three places:

- `saveLeaseDocumentHtml` and section saves use it before a browser-store update.
- `getLeaseDocumentHtml` uses it before an unsigned stored value is rendered anywhere in
  the portal. After a signature, it renders the already-sanitized stored bytes unchanged,
  because those bytes are P4 execution evidence.
- `POST /api/portal-lease-pipeline` applies it before `row_data` is upserted, so a direct
  route request cannot persist executable manager HTML.

The preview iframe has an empty sandbox attribute. The sanitizer is still required because
the same stored document is rendered for residents and exported as lease HTML.

### Execution and regeneration

Every saved body edit increments both `versionNumber` and `pdfVersion`, stamps
`generatedAtIso`, and records `managerDocumentEditedAtIso`. The client persistence function
rejects a row once either party has signed. The route refuses direct body replacements after
the row leaves Manager Review, and its existing P4 `replacesSignedLeaseDocument` guard rejects
the signed case with 409. The P4 hash therefore covers the edited body that was actually signed.

Regeneration never silently replaces a manual edit. Both manager generate surfaces show a
confirmation that says the current application/listing terms will replace the manager's
saved body. Only the confirmed path passes `discardManagerEdits`. If application data changes
through the automatic resident-sync path, the row records
`managerDocumentRegenerationRequiredAtIso` and cannot be sent until the manager explicitly
regenerates. This keeps the edited version visible without silently sending stale terms.

### Verbatim disclosures

P7's disclosure engine has not landed in this checkout, so no runtime clause is currently
inserted from the catalog. P8 reserves immutable markers now:
`<!-- proplane-verbatim-disclosure:start:<id> -->` and matching `end` markers. If a generated
lease contains one, `sanitizeManagerLeaseDocumentEdit` restores the original marked block and
rejects a save that removes or reorders it. P7 must emit those markers around each
`verbatim_required` clause. P8 deliberately does not add or infer any statute text.

Deliberately left out: a rich-text editor, arbitrary images/links/embedded documents, and
editing of uploaded PDFs. The source textarea plus preview keeps the allowed document grammar
visible and gives the persistence layer one narrow attack surface.
