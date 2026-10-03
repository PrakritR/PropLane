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
  unique index on `(application_id, form_id) where status <> 'cancelled'` is
  what makes dispatch idempotent.
- **Contract**: `src/lib/move-in-forms/types.ts`; browser half `client.ts`.
- Questions reuse `ManagerCustomApplicationField` plus a `signature` type.
  `showIf` follows `isCustomFieldHiddenByCondition`: a hidden question is never
  required and its answer is dropped.

## Routes

One catch-all, `/api/move-in-forms/[[...path]]?portal=manager|resident`, the
same shape as `/api/inspections`. Manager: `GET ""`, `GET/POST template-pdf`,
`POST send`, `POST send-existing`, `GET :id`, `GET :id/pdf`, `GET :id/file?path=`,
`POST :id/remind`, `POST :id/cancel`. Resident: everything under `mine`
(`mine`, `mine/:id`, `PATCH mine/:id`, `mine/:id/files`, `mine/:id/submit`,
`mine/:id/pdf`, `mine/:id/file?path=`, `mine/:id/template-pdf`).

Server logic: `server.ts` (scope, send, dispatch, answers, files), `pdf.ts`
(filled form), `move-in-form-events.server.ts` (sent / reminder / submitted on
the action-event bus, domain `move_in_form`).

## Dispatch

`dispatchMoveInFormsForResidency(applicationId, trigger)` sends every
template whose trigger matches and whose audience covers the residency's room.
Hooks: lease fully signed (`portal-lease-pipeline` save and `mark-signed`, via
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
- **Dispatch is best-effort and idempotent.** It never throws into a lease or
  application save, and running it twice sends nothing new.
- **No on/off switch.** A form is a plain row, like an application template. Whether it
  sends itself is its own `trigger` ("Sends": when the lease is signed / when the application
  is approved / only when I send it, edited in the form editor); any form can be sent by hand.
  Stored forms that carried `enabled: false` are read as `trigger: "manual"`, so nothing that
  was sending stops and nothing that was off starts. Duplicates and copies to another property
  start as "only when I send it".
- **The editor is the application editor's frame** (`AddWorkspace`: Form, Questions, live
  resident view, red Delete on the left in edit) and its Questions step draws each question
  through `BuilderQuestionCard`, the same row the application editor uses.
- The table is classified in `account-purge-manifest.ts`; clients hold no
  privileges on it (RLS on, no policies).
