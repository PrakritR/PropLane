# Move-in forms

Forms a manager sends a resident to complete before moving in: a checklist with
photos, a key receipt, a pet or parking agreement, or an uploaded PDF the
resident reads and signs. Plan: studio lane claude-3, `move-in-forms-1003`.

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
`POST :id/remind`, `POST :id/cancel`. Resident: everything under `mine`
(`mine`, `mine/:id`, `PATCH mine/:id`, `mine/:id/files` (POST uploads; `DELETE ?path=` removes an own upload while the form is open),
`mine/:id/submit`,
`mine/:id/pdf`, `mine/:id/file?path=`, `mine/:id/template-pdf`).

Server logic: `server.ts` (scope, send, dispatch, answers, files), `pdf.ts`
(filled form), `move-in-form-events.server.ts` (sent / reminder / submitted on
the action-event bus, domain `move_in_form`).

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
- **Resident access before a lease**: from the first sent form on — a submitted application is enough,
  approval is not required — My home opens for the Forms tab only
  (`RESIDENT_PRE_LEASE_MOVE_IN_TABS`; the path guard, server render gate and `STAGE_UNLOCKED_SECTIONS`
  agree). Placement, housemates, info and amenities stay locked until the lease is signed. The
  resident's email link goes to `/resident/move-in/forms`.
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
- **Move-in page (sidebar).** `/portal/move-in` has **one tab per form the manager has added**, not per kind.
  The tabs come from the stored forms of every property in the active workspace
  (`manager-forms.ts`: `storedMoveInFormNames`, same store the send popup reads) merged with the form names on the loaded copies
  (`moveInFormTabGroups`), grouped by name (trimmed, collapsed spaces, case-insensitive), alphabetical, tab id = a slug of the name
  (`inspections`, `waiting`, `submitted` are reserved and get a `-form` suffix). A form with no copies still has its tab
  ("Nothing sent yet"), and a deleted or renamed form's existing copies keep a tab under the name they were sent with. Each tab lists
  every resident's copy of that name, sent and submitted together (cancelled excluded), ordered late first, then waiting by due date, then
  submitted newest first (`filterMoveInForms({ formName })` / `sortMoveInFormsForTab`); the tab count is its row count. Filter is Property and
  Status (Waiting / Submitted). The bare `/portal/move-in`, and a slug that matches no form, show the first tab. With no form anywhere the
  page is one empty state, "No move-in forms yet", with an Add form button that goes to Properties. **There is no Inspections tab**:
  `/portal/inspections`, `/portal/move-in/inspections` and `/portal/move-in/inspections/{move-in|move-out}` redirect to `/portal/move-in`
  (`next.config.ts`). A single report (`.../inspections/{move-in|move-out}/{reportId}`) keeps its page; inspection data and
  `/api/inspections` are untouched. Resident side: the first My home tab is labelled "Move-in"
  (route `/resident/move-in/forms`, unchanged) and holds every form sent to them.
- **Resident record › Move-in** (every stage, potential included) is a hub with four sub-tabs under one toolbar
  (`ResidentRecordMoveInSection`): **Move-in info** (what the manager authored on the property — instructions, photos and video,
  access and Wi-Fi, amenities), **House rules**, **Roommates** (the other people placed at the property whose
  `residentDirectoryStage` is `current` — a tenancy starts at the executed lease, never at the approval) and
  **Forms**. There is no Inspections tab on the record: the embedded inspections list is a card under Forms, and
  `parseResidentDetailTab` aliases the retired `.../inspections` address to `move-in` with Forms open.
- **Resident record › Move-in › Forms** lists **every form of that resident's property** (its stored list) merged with the
  copies already sent (`residentMoveInFormRows`): one row per form, **Not sent** (row menu Send, which calls `sendMoveInForm` for that residency;
  disabled until the application is approved, as the server requires an approved residency with a property and an email), **Sent** with its
  due date (Remind / Preview form / Cancel request) or **Submitted** (Open / Download PDF / Send again). A waiting copy wins over an older submitted
  one; a copy of a since-deleted form still shows under its stored name. A property with no forms shows "No move-in forms for this property"
  with a button to its Forms. The toolbar carries Download all, Send a form and Add inspection — see
  [`inspections.md`](inspections.md) for the last one.

## Kinds, templates, triggers and links (Move-in hub, plan `move-in-hub-1003`)

- **A new property starts with a Move-in checklist for every lease type** (`submissionWithDefaultLeasingSetup`, `leasing-quick-add.ts`, alongside the applications and leases
  the property's stays admit — short-stay seeds only where the property offers a short stay, see [`lease-generation.md`](lease-generation.md) § Lease `defaultFor` and the stay tabs). It sends only once the manager has SAVED the property (the server ignores a move-in list that was never stored). Every other form is added by hand;
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
  `application_submitted_forms` (`hasMoveInForms` on the access state): My home opens for Forms only.
