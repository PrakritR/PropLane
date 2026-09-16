# Calendar availability edit-dialog browser regression

Run `npm run test:calendar-availability` (Chromium via `npx playwright install chromium`).

Bundles the **real** `PortalCalendarPanels`, `Modal`, `Button`, listbox `Select`
and current Tailwind CSS with esbuild and serves them through Playwright request
interception — no dev server, accounts, or database. Only the schedule-record
store's server write, the app-UI provider, Next navigation, the manager session
and the work-assignment directory are stubbed (`stubs.tsx`).

Covers PLAN-0916-0041 WS1+WS2: painted blocks read their category ("Tours"),
day headers read `N open [· N booked]`, no floating per-run ×, empty cells show a
hover-only `+`, and clicking a block opens the prefilled "Edit availability
block" form whose Save changes / Delete block rewrite the availability set —
desktop and phone. Set `EVIDENCE_DIR=<dir>` to also write screenshots.
