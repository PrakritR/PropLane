# Move-in forms

Forms a manager sends a resident to complete before moving in: a checklist with
photos, a key receipt, a pet or parking agreement, or an uploaded PDF the
resident reads and signs. Plan: studio lane claude-3, `move-in-forms-1003`.

## Model

- **Definitions** live on the property: `listingSubmission.moveInFormTemplates`
  (and `moveInFormSettings`), beside `propertyApplicationTemplates`. Read them
  only through `src/lib/move-in-forms/templates.ts` (`readMoveInFormTemplates`
  returns the five starters when the key was never written: the checklist sends on lease
  signing, the other four are manual).
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
- **Resident access before a lease**: after approval My home opens for the Forms tab only
  (`RESIDENT_PRE_LEASE_MOVE_IN_TABS`; the path guard, server render gate and `STAGE_UNLOCKED_SECTIONS`
  agree). Placement, housemates, info and amenities stay locked until the lease is signed. The
  resident's email link goes to `/resident/move-in/forms`.
- **Uploads are not leaked.** A removed photo or redone signature is deleted (`DELETE mine/:id/files`),
  and a submit prunes stored objects the final answers do not reference. Autosave and file calls are
  "quiet": they do not clear the list cache or fire `MOVE_IN_FORMS_CHANGED`. The photo cap is the
  shared `limits.ts` constant.
- **Only the property owner uploads the original PDF** (403 for a co-manager, who can still build the form).
- **Dispatch is best-effort and idempotent.** It never throws into a lease or
  application save, and running it twice sends nothing new.
- **No on/off switch.** A form is a plain row, like an application template. Whether it
  sends itself is its own `trigger` ("Sends": when the lease is signed / when the application
  is approved / only when I send it, edited in the form editor); any form can be sent by hand.
  Stored forms that carried `enabled: false` are read as `trigger: "manual"`, so nothing that
  was sending stops and nothing that was off starts. Duplicates and copies to another property
  start as "only when I send it". A property that never saved its forms auto-sends nothing: the
  server reads unsaved built-in defaults as "manual", and the first save stores untouched starters
  as manual, so only a form the manager saved with a trigger messages residents.
- **The editor is the application editor's frame** (`AddWorkspace`: Form, Questions, live
  resident view, red Delete on the left in edit) and its Questions step draws each question
  through `BuilderQuestionCard`, the same row the application editor uses.
- The table is classified in `account-purge-manifest.ts`; clients hold no
  privileges on it (RLS on, no policies).
- **Move-in hub.** The manager's `/portal/move-in` is one page with tabs Waiting (default) | Submitted | Inspections. Waiting and Submitted filter by Property and Form kind (Intake, Move-in, Move-out, Other; `summary.kind`, an unstamped copy reads as Other). Inspections mounts `InspectionsPanel` (`/portal/move-in/inspections/{move-in|move-out}[/{reportId}]`; Move-in / Move-out is its Type filter) and takes the page's tab row as its own. `/portal/inspections/...` redirects there; `docs/agents/inspections.md` owns the reports.

## Kinds, default forms, triggers and links (Move-in hub, plan `move-in-hub-1003`)

- **Three default forms on every property**: `default-intake`, `default-move-in`, `default-move-out`
  (`templates.ts`: `defaultMoveInForm`, `withDefaultMoveInForms`). `readMoveInFormTemplates` and the
  listing normalizer always pin them first and re-add one a client dropped, so they cannot be deleted
  (the row menu offers "Reset to default questions" instead, `resetMoveInFormToDefault`). A template's
  `kind` (`intake | move-in | move-out | other`) is fixed by those ids; stored forms without a kind read
  as `other`. The kind rides on the sent copy's `snapshot.kind` and is what the Waiting/Submitted
  "Form" filter uses.
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
- **Nothing auto-sends without the manager's save**: a never-saved property, and a default form a saved
  list did not hold (restored as "Only when I send it"), send nothing on their own. The first save
  stores the defaults with their shown Sends.
- **Resident access**: a resident who submitted an application and holds a sent form gets nav stage
  `application_submitted_forms` (`hasMoveInForms` on the access state): My home opens for Forms only.
