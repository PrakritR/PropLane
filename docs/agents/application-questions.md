# Application questions and linked forms

Owner document for two things: what a manager may change about the questions an
application asks, and the forms an answer can pull in behind it. Stay types,
`appliesTo` / `defaultFor` and pricing belong to
[`lease-generation.md`](lease-generation.md); the move-in form product itself
belongs to [`move-in-forms.md`](move-in-forms.md).

Organizer-ID validation keys requests on the ID only; changing a parent callback must not repeat lookup and autosave (`group-leader-app-id-field.test.tsx`).

## The applicant sees seven steps

Your lease · About you · Where you live · Work and income · References · More details · Review, sign and pay
(`RENTAL_WIZARD_STEP_COUNT`, titles in `wizard-step-titles.ts`). A question's **section** decides its step
(`RENTAL_APPLICATION_SECTIONS[].wizardStep`): household and property share Your lease, current and previous address
share Where you live, consent and review share the last step. A step the template leaves with no question is skipped
(`activeApplicationWizardSteps`).

- **Your lease** asks the property, a Long-term / Short-term toggle (only when the property offers both), then the
  dates that type needs (`lease-choice.ts`). Long-term: Move-in, then the property's fixed lengths in a
  Length select with **Custom dates** and **Month-to-month** as indented checkboxes under it — each offered
  only when the property ticked it (`applicantLongTermChildren`, the same two children the manager's picker
  shows; [`lease-generation.md`](lease-generation.md) § The four lease types). The one exception:
  Long-term with no fixed lengths and no Custom dates asks for the move-out date directly
  (`longTermHasImplicitMoveOut`), because the stay still needs an end. When Long-term leaves exactly one
  choice it is preselected and no Length control is drawn at all.
  Short-term: check-in and check-out dates plus house rules. Arrival/departure times are the host’s standard clock, stamped server-side by `standardizeApplicantStayTimes` for drafts/new submissions; client-provided times never negotiate it and existing submitted clocks are preserved. Stored values never change
  ("Long-term", "Short-Term Stay", "Custom", "Month-to-Month"), and `validate.ts` still refuses a term the property
  does not offer. Custom dates stores "Custom" only when the property offers it.
- Household Yes/No picks use the shared dropdown; short stays do not ask for a co-signer. Stay receipts use chosen dates and `resolveStayPricing` through `applicantListingQuote`, with the same checkout-exclusive nights and weekly pricing as approval and lease generation. No dates means no amount; never substitute monthly rent. Signing selection still comes from `chargeKindDueAtSigning`; remaining stay charges are labeled Before check-in. Bundle shares await confirmed placement rather than guessing a single-room amount.
- **Where you live** asks the previous address only under two years at the current one (`previous-address.ts`).
- **Review, sign and pay** opens the card form only once the whole application would pass the submit gate.
- A draft saved by an older wizard carries `wizardStepSchema`; `normalizePersistedWizardStep` maps its step onto
  the current one (`wizard-step-schema.ts`).

## Everything is editable

The question editor is shared by the application and the move-in form
(`src/components/portal/question-editor/`, adapter
`application-question-sections.ts`). A question's words, type, Required,
choices, order and on/off are the manager's to change — built-in or custom, on
every variant. `canEditBuiltInApplicationField`
(`src/lib/application-editor-fields.ts`) is the one decision; the editor only
draws what it returns.

- **Nothing is locked** (captain, Oct 5 2026, superseding the Oct 4 identity
  floor): full legal name, email and phone are removable, optional and
  retypable like any other question; every section has a live switch and every
  question's ⋯ menu offers Edit · Duplicate · Delete. The server falls back to the
  signed-in account's name and email when those questions are removed — the
  account's email is authoritative whenever there is one, so an answered email
  that differs is never honoured (`applicant-identity.ts`). A signed-OUT
  applicant has no account to fall back to, so the wizard asks a guest for Full
  legal name and Email whatever the template says
  (`withGuestIdentityQuestionsAsked`) and the guest submit path refuses a
  submitted row with no name. **Co-signers must use their own resident account**: a
  filler's unasked name comes from their account, and account email is authoritative
  (refused when the account holds no such value). Phone is validated only when
  the form asks for it or the filler typed one.
- **Two structural limits, not locks.** A built-in whose choices the wizard
  compares by stored value (`BUILT_IN_ANSWER_VALUES`) can have each choice
  reworded but not added, removed or reordered — position *i* stores value *i*.
  The property section's choices (property, rooms, lease term) come from the
  listing, so they are never typed in.
- **A built-in's `standardKey` is slugged from its LABEL**, so rewording the
  catalog mints a new key while listings keep storing the old one — in
  `disabledStandardApplicationKeys`, in a saved override row (`standardKey` /
  `replacedStandardKey` / the `std-<key>` id) and in `questionDisplayOrder`.
  Renaming a catalog question therefore means adding an alias in
  `standard-application-key-aliases.ts`; every stored key and question id is
  read back through `canonicalStandardApplicationKey` /
  `canonicalApplicationQuestionId`, so the manager's off switch, relabel,
  required override and ordering survive the rename instead of reverting to
  catalog defaults. "Room choices (1st – 3rd)" → **Room** (captain, Oct 13,
  when the wizard dropped to one room choice —
  [`shared-room-capacity.md`](shared-room-capacity.md)) is the first alias.
  Coverage: `tests/unit/legacy-standard-application-keys.test.ts`.
- **Changing a built-in's type detaches it.** `convertBuiltInQuestion` retires
  the built-in and asks the manager's own question of the new type in its place,
  with a fresh custom key and `replacedStandardKey` pointing back, so the editor
  never lists both. Only NEW applications change; a submitted application keeps
  the answers it stored. When the system reads that built-in by key
  (`SYSTEM_READ_ANSWER_STANDARD_KEYS`) the editor confirms first (`systemRead`
  on the question) and the readers afterwards simply find no answer under that
  key.

## Linked forms: "when the answer is X, include form Y"

Any question can carry rules (`linkedForms` / `LinkedFormRule`,
`src/lib/application-linked-forms.ts`), stored beside `showIf` on the question's
own row — a custom question's `customApplicationFields` row, or a built-in's
override row. The form named may be another **application** template or a
**move-in** form (`LinkedFormRef.kind`); the editor's dropdown lists both with
each form's own fee as a plain fact (`application-linked-form-options.ts`). A
template's co-signer link is read as a derived rule on "Co-signer planned"
rather than stored twice: `cosignerTemplateIdOwedByApplication` resolves the template's own
"Co-signer form" link, else — on (Property default) — the property's default co-signer template, the
same one the co-signer's own link resolves to. Long term only.

On submit the server evaluates the **published** template's rules against the
answers and writes one `application_form_requests` row per matched form
(`createLinkedFormRequestsForSubmit`). It never throws into the submit: a form
that cannot be recorded must not fail the application.

## Owed requests

Schema: `supabase/migrations/20261004130000_linked_form_requests.sql` —
`application_form_requests` plus `resident_account_links`. Pure helpers in
`application-linked-form-requests.ts`, server half (tokens, writes) in
`application-linked-form-requests.server.ts`.

- Status is `owed | shared | done | not_needed`; `owed` and `shared` are the open
  ones (`isLinkedFormOpen`). Finishing and waiving are both compare-and-swaps on
  the open statuses, so two fills never both win and only the person who
  actually submitted is recorded.
- **`(application_id, form_kind, form_id)` is unique**: a re-submit never doubles
  the list.
- `needed_before_review` is the manager's "I need this before I review":
  `owedNeededBeforeReview` / `waitingOnFormsFact` put "Waiting on N forms" on
  the application and in the approve confirm, which asks once ("Approve anyway")
  and then approves. It is never a hard block.
- The applicant sees `moreFormsHeading` — "N more forms to finish" — on the
  finish screen (`linked-forms-finish-list.tsx`) and in the resident portal's
  Applications section, each row offering **Fill out now** or **Someone else
  will fill it in**.

## Share links and linked accounts

- **Copy only.** "Someone else will fill it in" mints a link for the applicant to
  copy. The resident side never sends it from a work number or work email.
- A link carries 32 random bytes as a **path** segment (`/f/<token>`,
  `linked-form-path.ts`), and **only its SHA-256 hash is stored**
  (`token_hash`). The token is shown once, to whoever minted it, which is why
  nothing may silently replace a link already out there: the surfaces say "Link
  shared" and offer an explicit `LINKED_FORM_NEW_LINK_LABEL` instead.
- One link covers exactly **one request** and expires after
  `LINKED_FORM_LINK_TTL_DAYS` = 30 days (the column default says the same). `expires_at` is the
  LINK's life, not the form's: it is the deadline `redeemLinkedFormToken` enforces when someone opens
  `/f/<token>`. An owed form never expires for the applicant, a helper who already redeemed a live
  link stays recognised, and a fresh link is minted on demand.
- **A helper needs their own resident account.** `/f/<token>` makes a visitor
  sign in or create one and comes straight back; redeeming
  (`POST /api/linked-form-requests/redeem`, body = the token and nothing else)
  writes the `resident_account_links` row joining applicant and helper for that
  one request, and answers with `/resident/applications/forms/<request id>`. Legacy `/f/open/<request id>` URLs redirect there. That link is what lets
  the helper read and fill **this** form — never the applicant's other forms.
- Every refusal reads the same ("This link can't be used."), so the page is never
  a way to learn whether an application, a token or a link exists. Rate-limited
  per IP and per user.

## Fees

A linked form that is itself an application **charges its own fee to whoever
fills it** (`src/lib/linked-form-fee.server.ts`). The amount is never read from a
request body: it is re-resolved from the stored listing — the template's own
`feeCentsOverride`, else the listing's application fee for the application's
term — the same chain the applicant's own fee uses. A move-in form never
charges.

- **`fee_cents` null on an application form means UNRESOLVED, never free.** A resolved "no fee"
  stores 0, so null only ever means the pricing lookup failed when the request was written
  (`linkedFormFeeUnresolved`). The submit gate re-resolves it from the stored listing
  (`resolveUnresolvedLinkedFormFee`) and **fails closed**: a fee that still cannot be read refuses
  the submit with 503 `FEE_UNRESOLVED` rather than letting the form through as free. The legacy
  co-signer completion hook (`completeOpenLinkedFormRequestByForm`) carries no signed-in payer, so it
  finishes an application form only when the fee is 0 or already paid — an unresolved or owed fee
  leaves the request owed for its own paid submit.
- **The payment is settled twice over, idempotently.** The checkout carries
  `LINKED_FORM_FEE_PURPOSE`, so the application-fee webhook and verify paths (which would mark the
  APPLICANT's fee paid) never see it; it has its own branch instead
  (`markLinkedFormFeePaidFromStripeSession`), bound to the metadata the server stamped (request,
  payer, manager) and re-checked against the stored request. Webhook and the payer's own verify share
  one writer (`recordLinkedFormFeePayment`), so a payer who closes the tab is still recorded: the
  request's paid flags are paid-sticky, and the money is booked write-through to the ledger as one
  `other_cost` "Form fee" charge keyed on the Checkout session id (`hc_linked_form_fee_<session>`),
  which keeps its first booking date so a replay never moves it between reporting periods. The
  `application_fee` kind stays reserved for the applicant's own fee.

## Invariants

- **The PostgREST surface is public.** Client roles get **SELECT only** on an
  explicit column list that leaves `token_hash` out; there is no write policy and
  no `for all`. Reads are scoped to the manager who owns the request and to the
  applicant, helper and filler.
- **Ids in a body are never authorization.** Every route re-derives the viewer's
  role from the application row and the stored request
  (`resolveLinkedFormViewerRole`); a foreign or missing id answers the same 404
  as one that does not exist. Writes go through a service-role client.
- **Routes:** `GET /api/linked-form-requests` (no query = the signed-in
  resident's own forms plus the ones they were linked into; `?applicationId=` =
  one application's, for its manager or applicant),
  `GET/POST /api/linked-form-requests/[id]` (`share`, `send_email` — manager
  only, `not_needed`, `fee_checkout`, `fee_verify`),
  `POST /api/linked-form-requests/redeem`. None of them ever returns a token or
  its hash. **Every POST changes state, so a manager acting on one needs the Applications/Residents
  module at EDIT**, not read (`resolveLinkedFormViewerRole(..., { level: "edit" })`); a read-only
  co-manager is not a manager for it and, unless they are also the applicant or helper, gets the same
  404 as for a request that does not exist. GET stays at read.
- **A guest applicant has no `applicant_user_id`** (it is nullable on purpose);
  the request is still written and reachable through its link. The bound id comes **only from the
  authenticated session** of a resident writing their own application — never from the submitted row,
  which is client-authored and would let a submitter attach someone else's account to the request.
  Redeem and the resident lists re-derive a guest's applicant from the verified email.
- A missed completion hook leaves the row owed, which the manager can mark done —
  it never blocks the form that was actually submitted.

## Quick apply (resident, saved answers)

`POST /api/portal/quick-apply` (`quick-apply.server.ts`) submits a **solo** application to one room from the answers
the signed-in resident's latest submitted application holds. It is not a second submit path: the row goes through
`prepareResidentSelfWrite` + `persistApplicationWrite` (`signed-in-application-write.server.ts`), the same pair the
signed-in branch of `POST /api/manager-applications` uses, so validation, the fee guard, the resident link, linked
forms, the manager notice, move-in forms and screening (`consentCredit`) are one implementation.

- **Saved answers** are `RESIDENT_APPLICATION_AUTOFILL_KEYS` plus the earlier `customFieldAnswers`. A custom
  question is answered only by an earlier answer with the same **key and type** (`carryCustomFieldAnswers`),
  `showIf` respected. Anything still unanswered, or refused by the shared validator, answers `needsWizard` with the
  keys; the wizard then opens prefilled (`?prefill=1`).
- **Solo, always.** `applyingAsGroup`, `groupRole`, `groupSize`, `groupId`, `groupLeaderAppId` and `bundleId` are
  never copied from a past application. Lease type and term come from the listing's offered terms
  (`defaultStoredTermForKind("long", …)`), never from the last application; a short-stay-only listing goes to the
  wizard. The template is pinned (`applicationTemplateId` / `Version`).
- **Re-collected every time:** the move-in date, the "I confirm my saved answers are current" box, the screening
  consent when the listing asks for it, the listing's **truthfulness certification in its own wording**
  (`wizardFormFieldLabel(config, "consentTruth")`) when it asks for one, and the typed signature. `consentTruth` is
  an attestation the manager reads as "Accuracy confirmed" and the PDF prints as acknowledged, so it is recorded
  only from the applicant's own tick of that sentence — never stamped server-side, and never at all for a listing
  that does not ask. A listing that requires it and a sheet that could not show it send the applicant to the full
  application instead. Every one of them gates Submit — a blank move-in
  would build an empty lease range. One sheet, one Submit (`QuickApplySheet`), and the fixed listing's rooms and
  screening question are handed down as its `submission` prop (the public route never loads the client catalog, so
  `getPropertyById` cannot answer for it there).
- **Long term only.** The sheet always builds `rentalType: "standard"`, so the resident Applications **+** keeps its
  own picker while the list is on Short term.
- **Fees are never skipped.** `authorizeApplicationFeeSubmission` runs on the built row; only its
  `reason: "unpaid"` refusal saves the row as a draft at the last step and answers `needsPayment`. An
  `"unverifiable"` refusal is an error — never an invoice for a fee that did not actually fail on payment.
  A draft is not a submission: `tryAutoOrderScreening` refuses a draft-shaped row outright, so an
  auto-on-submit manager is never billed for a background check on an application nobody has submitted.
- **One row per person and room.** `findResidentApplicationsForListing` is one read that answers both halves:
  a live SUBMITTED application for the room is the 409 ("You already applied to this room."), and a live DRAFT for
  it is the row Quick apply **resumes** — its id, not a fresh one. Minting a new id per attempt would stack
  "Incomplete" rows no duplicate guard can see (they all skip drafts by design) and orphan a fee claim, which is
  keyed on the application id. The full wizard holds the same line from the other side: "no in-progress
  application matches this target" is only believed when the read that says so SUCCEEDED, so its reconcile
  retries the applications read before it ever mints a fresh id, and a read that never answered leaves the draft
  alone (`rental-application-wizard.tsx`, `tests/unit/apply-reconcile-read-guard.test.ts`). A read that
  succeeded but SKIPPED rows is judged per skip, not as a whole: `applicationReadProvesTargetAbsent` /
  `skippedCatalogHidesApplicationTarget` (`src/lib/rental-application/in-progress-application.ts`) believe
  absence when every skip's `skippedRows` hint names another house, term or room, and refuse it for a skip
  with no hint, a skip that could be this target, or the saved axis id itself — so one unreadable row in
  another house no longer blocks the apply link, and a skip that might BE the draft still does
  (`tests/unit/skipped-application-target.test.ts`).
- **`dryRun: true`** writes nothing and says what the primary button should read: Quick apply (`ready`), Continue
  application (`needsWizard` / `needsPayment`) or View application (duplicate). It runs the SAME
  `validateResidentApplicationRowForPersistence` the submit runs, with the sheet's own fields (move-in, consent,
  signature) standing in as filled, so the button cannot promise a one-sheet apply the shared write then refuses;
  and with no room named it is judged on a room the resident has **not** already applied to
  (`findResidentApplicationsForListing`), never blindly on `rooms[0]`. The public listing asks once per listing and
  room (`useQuickApplyReadiness`), for a signed-in resident whose
  `GET /api/portal/resident-application-autofill?exists=1` answers `{ hasProfile: true }` — the existence-only
  form, because the full payload carries the SSN, the licence and the ID photos and has no business in a public
  bundle.
- Limits: signed-in residents only (401 otherwise), 10 submits and 30 dry runs a minute per account.
- Out of scope: group quick apply, any fee bypass, any change to the wizard's questions. The row carries
  `quickApplied: true` (a plain fact on the record, never a pill).


## Co-signer account and portal boundary (Oct 25, 2026)

Co-signers submit only through an authorized linked-form request from their own resident account. The old
`/rent/apply/cosigner?signerAppId=…` page resumes a uniquely matching request already linked to the signed-in
helper; otherwise it asks for a fresh invitation. An application id grants no write access,
and the public-named submission route rejects requests without `formRequestId`, an authenticated resident and
access to that stored request. The existing fee and compare-and-swap completion gates still apply. A co-signer request (its published variant or derived rule) refuses primary-applicant submission and checkout: the primary shares it, a different resident fills it. Generic supplemental forms remain fillable by the applicant. Before the
primary application is submitted, the wizard shows that the invitation will become available; it exposes no
unusable public link. A missing configured co-signer template is shown as needing manager setup.

The fill page lives in Applications at `/resident/applications/forms/<request id>` on both web and native.
The linked wizard starts with personal information, prefills the account email read-only and profile name,
shows the bound applicant as a fact, and skips unpublished sections. Consent is only required when the published
form requires it, and an unasked or unchecked consent is never stored as granted.
Submitted helper forms remain listed in that helper's portal. Their completed readout uses the submitted
published template version, omitting unasked fields and booleans; manager review retains its full view. GET on the request reveals the completed
submission only to its `filled_by_user_id` or an authorized manager, and looks up the exact
`completed_submission_ref` under the same parent application. The primary applicant sees completion status;
`/api/cosigner-submissions` gives them an allowlisted summary, never the co-signer's identity or financial
answers. Existing signed documents and submitted responses are not rewritten.

Coverage: `linked-form-requests-routes`, `cosigner-submission-visibility`, `cosigner-identity-from-account`,
`security/cosigner-identity-route`, and `linked-forms-ui`.

- Delete is explicit: a delete save carries `listingSubmission.removedApplicationTemplateIds`, and `preserveServerOwnedApplicationVersions` drops exactly those ids completely (no archive; submitted applications keep their own snapshots) and never stores the list. A save without the list still re-appends published/imported forms; the panel reads the stored list back and toasts a failure if the id survived.

- **Waive on send:** the Send application modal's "Waive application fee" box (single-home apply only) makes `POST /api/portal/send-lead-invite` resolve a single-use waiver code and put it in the link as `&code=` — copying the link carries the same code (`linkOnly`) — and the wizard auto-redeems it through the same `/api/public/application-fee-waiver` route as a typed code. Who may waive, how the code is scoped and when it is reused: [`resident-payments.md`](resident-payments.md) § Application fee: waive on send, and short stays.
- **Promo codes on a property are written under the property's OWNER, never the signed-in user** (`/api/manager/application-fee-waivers`, `resolveWaiverCodeScope` / `resolveWaiverPropertiesScope` in `src/lib/application-fee-waiver-scope.server.ts`, the same resolver Application settings uses): every covered property must belong to one owner, and a non-owner needs `applications` at `edit` on EVERY property the code covers to add, widen, edit or turn it off (a portfolio-wide code is the owner's alone). PropLane staff in a service workspace pass by their seat (`account_link_invites`, `is_service_seat`), the same grant as a co-manager, not by platform-admin role. Adding text the owner already has is idempotent (the property is appended, 200 with `extended: true` so the screen says added, not created); a turned-off, expired or used-up code is a 409, never revived, and so is a request that also asks for a cap, expiry or label the existing code does not carry ("Edit it from Settings"). Re-authorizing a code's STORED property list drops ids of deleted houses (`property_ids` has no foreign key), and its owner skips the check outright. A property-scoped GET returns only THIS property's redemptions (a redemption carries an applicant's email) and marks the owner's portfolio-wide codes `readOnly` for a teammate, since only the owner may write one. Coverage: `tests/unit/application-fee-waivers-route.test.ts`.
- **Promo codes entry:** the property Applications header carries a ticket `PortalIconAction` "Promo codes" that opens the house-scoped dialog (new codes default to this property); the per-form ⋯ entry stays.
