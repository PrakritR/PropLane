# Move-in forms

Forms a manager sends a resident to complete before moving in: a checklist with
photos, a key receipt, a pet or parking agreement, or an uploaded PDF the
resident reads and signs. Plan: studio lane claude-3, `move-in-forms-1003`; the Forms
section, Blocks and edit-a-pending-form (below) are lane claude-1, `resident-forms-section-1005`.

## Model

- **Definitions** live on the property: `listingSubmission.moveInFormTemplates`
  (and `moveInFormSettings`), beside `propertyApplicationTemplates`. Read them
  only through `src/lib/move-in-forms/templates.ts` (`readMoveInFormTemplates` returns exactly
  the stored list: **nothing is added for the manager**, so a property that never added a form
  has none). The eight templates (`MOVE_IN_FORM_STARTERS`: Intake form, Move-in form, Move-out
  form, Move-in checklist, Key receipt, Vehicle and parking, Pet agreement, Emergency contacts)
  are only offered under "Start from a template"; picking one makes an ordinary form with a
  fresh `mif-` id, the template's questions and its own Sends.
- **Instances** are rows of `public.resident_move_in_forms`
  (`supabase/migrations/20261003120000_resident_move_in_forms.sql`), one per
  (residency, form): `status` is `sent | submitted | cancelled`. A partial
  unique index on `(application_id, form_id) where status = 'sent'`
  (`20261003190000_move_in_forms_resend.sql`) allows one waiting copy; a submitted copy stays as
  history and "Send again" creates a fresh one. Automatic dispatch checks for ANY non-cancelled copy
  itself (`liveFormIds`), so it never re-sends a form a resident finished. `reminders_sent` (jsonb)
  records which automatic reminders (`before`, `due`) went out.
- **Contract**: `src/lib/move-in-forms/types.ts`; browser half `client.ts`.
- Questions reuse `ManagerCustomApplicationField` plus a `signature` type.
  `showIf` follows `isCustomFieldHiddenByCondition`: a hidden question is never
  required and its answer is dropped.

## Routes

One catch-all, `/api/move-in-forms/[[...path]]?portal=manager|resident`, the
same shape as `/api/inspections`. Manager: `GET ""`, `GET/POST template-pdf`,
`POST send`, `POST send-existing`, `GET :id`, `GET :id/pdf`, `GET :id/file?path=`,
`PATCH :id` (edit a pending form), `POST :id/remind`, `POST :id/cancel`. Resident: everything under `mine`
(`mine`, `mine/:id`, `PATCH mine/:id`, `mine/:id/files` (POST uploads; `DELETE ?path=` removes an own upload while the form is open),
`mine/:id/submit`,
`mine/:id/pdf`, `mine/:id/file?path=`, `mine/:id/template-pdf`).

Server logic: `server.ts` (scope, send, dispatch, answers, files), `pdf.ts`
(filled form), `move-in-form-events.server.ts` (sent / reminder / submitted on
the action-event bus, domain `move_in_form`).

## Forms section, Blocks and editing a pending form (plan `resident-forms-section-1005`)

- **Blocks** (`MoveInFormTemplate.blocks`, copied to `snapshot.blocks` on send): what an UNSUBMITTED copy holds back.
  `nothing | move_in_details | lease_signing | approval`; absent = the kind's default (`defaultMoveInFormBlocks`: intake blocks
  Move-in details, every other kind nothing), so every intake form sent before this existed keeps blocking Move-in details.
  Read it only through `resolveMoveInFormBlocks`. A sent copy keeps what it was sent with: editing the template later never
  changes it. Only a `sent` copy blocks; submitted and cancelled never do.
- **`blocking.ts` is the one place the rule lives** (`blockingFormsFromRows`, `loadResidentBlockingForms`,
  `loadApplicationBlockingForms`). A read that fails blocks (fail closed); a missing table blocks nothing. It is enforced on the server:
  - Move-in details: `loadResidentPortalAccessState` returns `blockingFormsPending { moveInDetails, leaseSigning, approval, formIds }`;
    `renderPortalSection` builds My home with `formsLock` and runs `redactMoveInDetails` over the loaded house, so no door code, Wi-Fi,
    rule, photo or amenity reaches the browser. The tab shows the lock (`ResidentFormsLock`) with a button to the form.
  - Lease signing: `POST /api/portal-lease-pipeline` answers 409 `FORMS_BLOCK_LEASE_SIGNING` to a resident's NEW signature (or signed
    PDF return) while a lease-signing form for this resident (and this lease's property) is unsubmitted. The lease page shows
    "Finish your forms first" linking to the form (`useResidentFormsBlock`, display only).
  - Approval: `POST /api/manager-applications` (single-row upsert and batch `replace`), `PATCH /api/portal/resident-approval` and the
    agent's `update_application_bucket` refuse the transition INTO approved with 409 (`blocked: "forms"`) while an approval-blocking
    form for that application is unsubmitted; an already-approved row stays editable. The Approve popup disables its button and
    names the waiting form (`useApprovalFormsBlock`, display only).
- **Editing a pending form**: `PATCH /api/move-in-forms/:id` (manager) edits `dueAt`, `blocks` and `questions` on a `sent` copy only.
  It re-derives the manager's edit scope from the session (a body id is never trusted; a foreign or resident caller gets 404), writes
  with a compare-and-swap on `status = 'sent'` and answers 409 once the copy is submitted or cancelled. A draft answer to a question
  that was removed is dropped. UI: `EditPendingMoveInFormPopup`, the standard popup (Details · Questions, live resident view on the right).
- **Manager Forms page** `/portal/forms` (TENANCY, after Residents; `forms-list.tsx`): Pending (`sent`) and Completed (`submitted`) tabs
  carried by the URL (`/portal/forms`, `/portal/forms/completed`), counts, search, a Filter popover (Kind, Property, Resident, Blocks,
  multi-selects, no chips), the round + (send a form) and per-row ⋯ (Edit, Remind, Cancel request / View, Download PDF). A row is
  tile · form name · "resident · property · room" · "Blocks …" · due or submitted date, no pill. The Move-in sidebar row and hub
  are gone: `/portal/move-in` and any old form slug redirect to Forms; `/portal/move-in/inspections/{kind}/{reportId}` keeps its page.
  The resident record's **Forms** rail item (HOME, right after Lease; `/forms[/completed]`) is the same component scoped to that
  resident (no Resident or Property filter). Its **Move in** tab is Placement · Move-in details · Roommates · Inspections;
  `/move-in/forms` redirects to the record's Forms.
- **Resident Forms section** `/resident/forms` (Pending · Completed, `/resident/forms/<formId>` fills or reads one form): the nav row
  unlocks with an approved application (`STAGE_UNLOCKED_SECTIONS`; booking and signed stages too). A resident who submitted but is
  not approved and holds a sent form (stage `application_submitted_forms`) keeps the row locked but can open Forms by its direct link
  (`isResidentPathAllowedForAccess`), which is how an approval-blocking form sent before approval gets filled. Emails link to
  `/resident/forms/<id>`. `/resident/move-in/forms` redirects to `/resident/forms`. My home no longer has a Forms tab and is locked
  until the lease is signed.

## Dispatch

`dispatchMoveInFormsForResidency(applicationId, trigger)` sends every
template whose trigger matches and whose audience covers the residency's room.
The hooks run after the response (`after()` via `dispatch...AfterResponse`), never inside the save. Hooks: lease fully signed (`portal-lease-pipeline` save and `mark-signed`, via
`dispatchMoveInFormsForSignedLease`) and application approved
(`manager-applications` POST). Due date comes from the move-in date
(`moveInFormDueAt`, end of the due day in Pacific).

## Invariants

- **A sent form snapshots its questions** (and its PDF fingerprint). Editing the
  template later never changes what a resident was asked or answered.
- **A submitted form is locked.** Save, upload, resubmit, remind and cancel all
  answer 409; the submit itself is a compare-and-swap on `status = 'sent'`.
- **Ids in a body are never trusted.** Every read and write re-derives scope
  (manager: owned or co-managed property, active workspace; resident: their own
  email and login). A foreign or missing id is a 404, never a 403.
- **Files only through signed URLs.** Photos and signatures live in the private
  `move-in-form-files` bucket at `<recordId>/<questionKey>/<uuid>.<jpg|png>`;
  answers may only reference paths under their own record, and each must exist at
  submit. A template PDF lives in `lease-templates` under
  `<ownerId>/move-in-forms/<formId>/`, and that prefix is re-checked whenever it
  is read, because the template JSON is client-writable.
- **Upload forms sign exact bytes.** Submit hashes the stored PDF and refuses if
  it no longer matches the snapshot; the hash is stored as `signed_document_sha256`.
- **Reminders follow the property's "Remind residents" setting.** `sweepMoveInFormReminders`
  (`reminders/subjects/move-in-forms.server.ts`, on the 5-minute `dispatch-reminders` tick): 2 days
  before the due date and on it (Pacific), on it only, or never. The reminder is claimed on the row
  first (`reminders_sent.<kind>`), so a re-run never double-sends; a submitted/cancelled form or one
  sent the same day is skipped. It sends the same `reminder` event as the manager's Remind.
- **"Tell me when a resident submits"**: none; an Assistant notice (the event is sent as the manager,
  which the bus delivers as an Assistant notice with no email); or that plus an email to the manager's
  profile address from the shared sender (`emailManagerOfMoveInFormSubmission`).
- **Resident access before a lease**: Forms is its own resident section (see "Forms section" above), unlocked from approval, and
  reachable by direct link from the first sent form once the application is submitted. My home (placement, details, roommates,
  inspections) stays locked until the lease is signed. The resident's email link goes to `/resident/forms/<id>`.
- **Uploads are not leaked.** A removed photo or redone signature is deleted (`DELETE mine/:id/files`),
  and a submit prunes stored objects the final answers do not reference. Autosave and file calls are
  "quiet": they do not clear the list cache or fire `MOVE_IN_FORMS_CHANGED`. The photo cap is the
  shared `limits.ts` constant.
- **Only the property owner uploads the original PDF** (403 for a co-manager, who can still build the form).
- **Original PDFs are served inline: a deliberate exception.** Every other file answers as an attachment, but the
  uploaded original is read in place (the resident reads, then signs, the real document), so `originalPdf` in the route
  answers `inline`. The safeguards that make this acceptable: `Content-Security-Policy: sandbox` (no script, forms,
  or same-origin access if the file is ever opened as a page), `X-Content-Type-Options: nosniff`, `Content-Type:
  application/pdf` fixed (never taken from the upload), `Cache-Control: private, no-store`, a sanitized filename, and
  an upload that must be a PDF within the 8 MB cap, read back and fingerprinted by the server. Do not add a second
  inline response.
- **Dispatch is best-effort and idempotent.** It never throws into a lease or
  application save, and running it twice sends nothing new.
- **No on/off switch.** A form is a plain row, like an application template. Whether it
  sends itself is its own `trigger` ("Sends": when the lease is signed / when the application
  is approved / only when I send it, edited in the form editor); any form can be sent by hand.
  Stored forms that carried `enabled: false` are read as `trigger: "manual"`, so nothing that
  was sending stops and nothing that was off starts. Duplicates and copies to another property
  start as "only when I send it". Dispatch uses the stored forms and nothing else, so a property
  that never added a form sends nothing on its own.
- **The editor is the application editor's frame** (`AddWorkspace`: Form, Questions, Who & when;
  red Delete on the left in edit) and its Questions step draws each question
  through `BuilderQuestionCard`, the same row the application editor uses. The right-hand
  "Resident sees" pane is the application editor's card ("Step n of N · form name"), not a phone
  frame. Its footer is the shared `AddWorkspace` shell both editors read, not one of its own
  (`editor-footer-state.ts`; the shape is [`ui-page-structure.md`](ui-page-structure.md) § 4b).
- **Forms sit under Long-term forms / Short-term forms tabs** (Move-in: Whole house · Rooms · Long-term
  forms · Short-term forms). A form's stay is its "Applies to" (`src/lib/move-in-forms/stays.ts`):
  All (`leaseType` absent/`all`) shows in BOTH tabs as the same record; Long-term / Short-term residents
  in that tab only; Specific leases take the stay their leases share (else both). The Short-term tab is
  hidden when the property does not allow short stays, unless a short-term-only form still exists
  (`moveInFormStayTabs`; a both-stay form never holds a disallowed tab open). Quick add and the round +
  create for the open tab (the new form's `leaseType` is that stay).
- The table is classified in `account-purge-manifest.ts`; clients hold no
  privileges on it (RLS on, no policies).
- **Delete resident erases the forms too.** `resident_move_in_forms` is a target of
  `purge-manager-resident.ts` (matched by login, email and application id, scoped on `manager_user_id`) and is in the
  `purge_manager_resident_rows_v2` allowlist (`20261003220000_purge_v2_move_in_forms.sql`, rebuilt from the
  `20261003150000` body, deposits still included). After the transaction commits, each deleted form's folder in
  `move-in-form-files` is removed. Account deletion (`purge-portal-account-data.ts`) does the same for a resident's
  copies and a manager's, and a manager's `lease-templates/<ownerId>/` walk takes the original PDFs under
  `move-in-forms/`. The same migration forces the bucket private (`on conflict (id) do update`).
- **The lease-signed seam never trusts the ids in the lease JSON.** A lease's `axisId` and
  `jointLeaseMembers[].applicationId` are client-writable, so `dispatchMoveInFormsForSignedLease(lease, { managerUserId,
  propertyId })` takes the manager and property from the lease ROW's own columns and skips any residency whose
  `manager_user_id`, property owner or `property_id` differs. The daily move-out sweep applies the same pairing
  (`options.expect`). No manager on the lease row means nothing is sent.
- **Plan gate.** Move-in is a Pro and Business module. The page paywalls it (`subscriptionGated`), and so does the API:
  `/api/move-in-forms` answers every manager call from a Free manager with 402 (`assertMoveInPlanForActor`, the same
  `getManagerPortalNavSubscriptionTier` + `managerSectionAllowedForTier("move-in")` rule as the sidebar), and automatic
  dispatch sends nothing for a Free owner. Residents are never gated: they answer a form already sent to them.
  Inspections has no server-side tier gate of its own; this one does not copy it.
- **Request size.** The route counts bytes as they stream in (`read-body.ts`), never trusting `content-length`: JSON
  bodies stop at 800 KB, resident image uploads at 4.5 MB (Vercel's body cap), an original PDF at 11 MB. The browser
  shrinks a photo over 4 MB to JPEG before upload (`fit-image.ts`) or refuses it with a plain message.
- **A resident's API record has no `managerUserId`** (`toRecord` omits it for the resident viewer).
- **The Intake notice needs a confirmed login.** The Intake form is created when an application is submitted, possibly
  as a guest whose address is only typed. The in-portal form is always created, but the "form waiting" notice is sent
  only when a login with a confirmed email owns that address, and goes to that login. Every other trigger follows a
  manager's decision about a known resident and notifies as before.
- **Forms page (sidebar).** Replaced the Move-in page (one tab per form name): see "Forms section" above. Inspections have no list page;
  `/portal/inspections`, `/portal/move-in/inspections` and `/portal/move-in/inspections/{move-in|move-out}` redirect to `/portal/move-in`,
  which redirects to `/portal/forms` (`next.config.ts`, `renderPortalSection`). A single report
  (`.../inspections/{move-in|move-out}/{reportId}`) keeps its page so the resident record's Inspections tab still opens it; inspection data
  and `/api/inspections` are untouched.
- **Resident record › Forms** lists only the forms already SENT to that resident (Pending, Completed); a form goes out from the round +
  (the send popup pointed at that resident, which the server allows only for an approved residency with a property and an email).
  A property's unsent forms are not rows any more. Move in (Placement · Move-in details · Roommates · Inspections) holds no forms.

## Kinds, templates, triggers and links (Move-in hub, plan `move-in-hub-1003`)

- **A new property starts with a Move-in checklist for every lease type** (`submissionWithDefaultLeasingSetup`, `leasing-quick-add.ts`, with its Long-term/Short-term/Co-signer
  applications and leases). It sends only once the manager has SAVED the property (the server ignores a move-in list that was never stored). Every other form is added by hand;
  the list's bottom "Quick add" row re-adds any starter the property lacks (as a form that sends only when the manager sends it).
- **Applies to** (the editor's label for Lease type; stored shape unchanged, `MoveInFormTemplate.leaseType`: absent/`all`, `long-term`, `short-term`; a specific lease is `linkedLeaseTemplateIds`, picked under "Specific leases…"): dispatch on a signed lease sends only the forms
  whose Applies to admits the signed lease's kind (the lease template's `kind`, else the application's rental type; an unknown kind never matches a restricted form).
- **Nothing else is added automatically.** The Intake, Move-in and Move-out forms are templates (`starterKey` `intake-form`, `move-in-form`,
  `move-out-form`, with `kind` `intake | move-in | move-out`), offered beside the five older ones under "Start from a template". A form the
  manager adds is an ordinary form: editable and deletable (confirm dialog), with no pinned rows and no "Reset to default questions".
  A property that already stored the old injected `default-intake` / `default-move-in` / `default-move-out` forms keeps them as ordinary
  forms (the id still fixes their kind: `moveInFormDefaultKindOfId`, `defaultMoveInForm`). `kind` rides on the sent copy's `snapshot.kind`;
  the manager's tabs follow the form's name, not its kind.
- **Sends**: `application-submitted | application-approved | lease-signed | before-move-out | manual`.
  `before-move-out` + `moveOutDaysBefore` (7/14/30) is sent by the daily `sweepMoveOutForms` (8 o'clock
  Pacific hour of the `dispatch-reminders` tick) for fully signed, not voided leases ending within 30
  days; a form goes once the lease is within its window. Intake is dispatched where an application
  first becomes submitted (`manager-applications` POST x2, `promote-incomplete-application-after-fee`).
  Due rules are anchored on move-in, on the day sent, or on the lease end (`moveInFormDueFor`).
- **Links**: `linkedApplicationTemplateIds` / `linkedLeaseTemplateIds` (empty = all). A residency's
  application template is `row_data.application.applicationTemplateId`; its lease template is the lease
  row's `leaseGenerationTemplateId || leaseTemplateId`, else the lease its application template maps to.
  Dispatch and "Send to current residents" skip a non-matching residency; an unknown id never matches a
  non-empty link list. A manual Send ignores links.
- **Nothing auto-sends unless the manager added the form**: a property that never added one sends nothing on its own, and
  a deleted form is gone (it is never restored).
- **A question rule is the second way a form becomes owed.** Besides the sends above, an
  application question can carry a linked-form rule ("when the answer is X, include form Y") naming a
  move-in form, and a matched rule writes an `application_form_requests` row instead of a sent copy.
  That whole contract — the rules, the owed requests, the share link and its account linking, the fees —
  is owned by [`application-questions.md`](application-questions.md).
- **Resident access**: a resident who submitted an application and holds a sent form gets nav stage
  `application_submitted_forms` (`hasMoveInForms` on the access state): the nav stays locked, Forms opens by its direct link.
