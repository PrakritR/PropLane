# Preview pager browser regression

Run `npm run test:preview-pager` (Chromium: `npx playwright install chromium`).
Set `PAGER_SHOTS=<dir>` to also write the reviewer screenshots.

These tests bundle the **real** application questions editor, move-in form
editor, the shared `PreviewPager`, and the app's current Tailwind CSS.
Playwright serves the bundle through request interception; no dev server,
accounts, or database is needed. Only the assistant rail, PDF bytes, routing and
analytics are stubbed.

They cover the one contract both panes share: the "Step n of N · <form name>"
header, the ‹ › icon buttons (disabled at the ends), whole sections per step with
their titles, short consecutive sections combined, a section never split, and the
preview re-aiming when a section or a question is opened in the middle column.
The jsdom suites (`tests/unit/preview-pager.test.tsx`,
`tests/unit/application-preview-step-aim.test.ts`) own the packing maths.
