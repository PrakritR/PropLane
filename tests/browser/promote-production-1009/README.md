# Production promote 2026-10-09 — visual evidence

Two passes, in this order:

```bash
EVIDENCE_DIR=<dir> npx vitest run tests/unit/evidence-bookings-calendar-echo-1009.test.tsx \
  tests/unit/evidence-bookings-calendar.test.tsx tests/unit/evidence-listing-site-record-1009.test.tsx \
  tests/unit/evidence-mcp-bookings-1009.test.tsx tests/unit/evidence-team-chat-inbox-1009.test.tsx \
  tests/unit/evidence-second-pass-1009.test.tsx tests/unit/evidence-thread-cleanup-1009.test.ts \
  tests/unit/evidence-work-number-messaging-1009.test.ts tests/unit/evidence-room-availability-1009.test.ts
EVIDENCE_DIR=<dir> npx playwright test --config tests/browser/promote-production-1009.config.ts
```

The first pass renders the real screens in jsdom and dumps each one's markup
(plus three delivery transcripts). The second pass does two things:

- **`shots.spec.ts`** compiles the real Tailwind build from `src/app/globals.css`,
  drops it beside those dumps as the `app.css` each one already links, and
  screenshots all fifteen into `<dir>/png`. A dump that paints without its
  stylesheet fails the test rather than producing a picture of unstyled DOM.
- **`surfaces.spec.ts`** covers the three surfaces the jsdom harnesses do not
  dump, by bundling the **real** `WorkspaceProvider`, `PortalFilterSortSheet`,
  `GrowthEngageTab` and `VendorServicesPanel` with the same Tailwind build and
  driving them in Chromium through request interception — no dev server,
  accounts or database. Only session, navigation and analytics are stubbed.
  - **The phone Filter sheet** at 390 px on a coarse-pointer device, which is
    the only surface where Filter opens as a bottom sheet. `GET /api/workspaces`
    is held open, Filter is tapped inside the real ~1s window, and the answer
    is then released: the sheet has to still be there with its fields. That
    first answer used to re-key the whole portal subtree and throw it away.
  - **Growth Engage** drawing its rows, tallies and editable drafts.
  - **Vendor services** listing the outside marketplaces as plain links.
