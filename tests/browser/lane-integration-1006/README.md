# Lane integration 2026-10-06 — visual regression

Run `npm run test:lane-integration` (install Chromium with
`npx playwright install chromium` if needed). Set `EVIDENCE_DIR=<dir>` to write
the screenshots somewhere a reviewer can read them.

These tests bundle the **real** `FormsList`, `SendNewLeaseModal`,
`RecordCommunicationSection`, `ResidentFormsSection`, `ResidentFormsLock` and the
current Tailwind build, and drive them in Chromium through request interception —
no dev server, accounts or database. Only the move-in-forms client, the portal
session, navigation and analytics are stubbed, so what the screenshots show is
the surface an end user sees.

They cover the UI promises that the jsdom tests can only assert as text:
the Forms page header band (Pending · Completed with counts, search, the Filter
popover's four fields, the round blue + and no standalone Upload icon), rows with
their Blocks glyph fact and no pills, no dashed "+ Add" footer row, the phone
layout keeping the + on the card, "Send new lease" in the standard pop-up
(Lease · Terms · Review & send) opening on the shared "Start from a file" card
with terms prefilled from the current lease, a record Communication section that
fills the page and offers Schedule for later, and the resident-side forms lock in
both its blocked and its fail-closed states.

They also cover `/demo`'s own half of the scheduled-sends gating: on the `/demo`
pathname a thread's reminders are the sandbox's local projection, no Send now button is offered, Cancel is applied locally, and
the whole flow asks the scheduled-messages API for nothing.

The server half of the same work has no screen; its transcript comes from the
forms-gate evidence test under `tests/unit/` (grep `forms-gate-1006`).
