# Application questions and linked forms

Owner document for two things: what a manager may change about the questions an
application asks, and the forms an answer can pull in behind it. Stay types,
`appliesTo` / `defaultFor` and pricing belong to
[`lease-generation.md`](lease-generation.md); the move-in form product itself
belongs to [`move-in-forms.md`](move-in-forms.md).

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
  Short-term: check-in, check-out, times, house rules. Stored values never change
  ("Long-term", "Short-Term Stay", "Custom", "Month-to-Month"), and `validate.ts` still refuses a term the property
  does not offer. Custom dates stores "Custom" only when the property offers it.
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
  submitted row with no name. **The co-signer form follows the same rule**: a
  signed-in filler's unasked name and email come from their account (refused
  when the account holds no such value), a signed-out co-signer is still asked for
  both, and phone is validated only when the form asks for it or the filler
  typed one.
- **Two structural limits, not locks.** A built-in whose choices the wizard
  compares by stored value (`BUILT_IN_ANSWER_VALUES`) can have each choice
  reworded but not added, removed or reordered — position *i* stores value *i*.
  The property section's choices (property, rooms, lease term) come from the
  listing, so they are never typed in.
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
  one request, and answers with `/f/open/<request id>`. That link is what lets
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
