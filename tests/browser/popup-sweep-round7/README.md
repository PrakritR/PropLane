# Round 7 pop-up sweep — browser regression

Run `npm run test:popup-sweep` (install Chromium with `npx playwright install chromium` if needed).
`SWEEP_SHOT_DIR=<dir>` puts the screenshots somewhere else than `popup-sweep-round7/shots`.

The spec bundles the **real** `ManagerTaskFormModal`, `SendMoveInFormPopup` and `ServiceEditPopup`
with the current Tailwind CSS and serves them through Playwright's request interception — no dev
server, account or database. Only data providers, routing, analytics and the assistant strip are
stubbed (`stubs.tsx`).

It covers what jsdom cannot see: the required mark beside the task's own words with the hint
paragraph and readiness caption gone, a one-step door with no rail and no Cancel and Send on the
right, and a phone step heading that no longer repeats the tab above it (desktop keeps it).
