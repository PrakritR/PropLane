# Round 7 pop-up sweep — browser regression

Run `npm run test:popup-sweep` (install Chromium with `npx playwright install chromium` if needed).
It runs every `*.spec.ts` in this folder. `SWEEP_SHOT_DIR=<dir>` puts the screenshots somewhere else
than `popup-sweep-round7/shots`.

Both specs bundle the **real** components with the current Tailwind CSS and serve them through
Playwright's request interception — no dev server, account or database. Only data providers,
routing, analytics and the assistant strip are stubbed (`stubs.tsx`).

- `sweep.spec.ts` (`fixture.tsx`: `ManagerTaskFormModal`, `SendMoveInFormPopup`, `ServiceEditPopup`)
  covers the shell: the required mark beside the task's own words with the hint paragraph and
  readiness caption gone, a one-step door with no rail and no Cancel and Send on the right, and a
  phone step heading that no longer repeats the tab above it (desktop keeps it).
- `hints.spec.ts` (`hints-fixture.tsx`: `PromotionForm`, `HousePrintablesCard`,
  `ManagerTaskFormModal` in tour mode) covers the rest of the round: no description sentence under
  the flyer template tiles, no `(optional)` suffix on the welcome sheet's Resident label, and no
  "Saving schedules the tour" hint.

It is what jsdom cannot see: real layout, real breakpoints, real `max-lg:hidden`.
