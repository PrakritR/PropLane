# Round 6 (plan p0-fixes-1116) — browser regression

Run `npm run test:round6` (install Chromium with `npx playwright install chromium` if needed).
`ROUND6_SHOT_DIR=<dir>` puts the screenshots somewhere else than `round6-1116/shots`.

The spec bundles the **real** components with the current Tailwind CSS and serves them through
Playwright's request interception — no dev server, account or database. Only routing, analytics,
the modal assistant strip, the work-assignment directory and the portal session are stubbed
(`stubs.tsx`); the inbox's own reads are answered as intercepted API responses.

- **Dashboard never draws a zero it has not read** — the real `KpiCard` row and `AttentionPanel`
  in each state: a skeleton while loading (no "0%" / "$0" / "0", no "Nothing is waiting"), "—"
  with "Unavailable · Retry" once a read failed, and the honest zero only once every source
  answered.
- **Tour confirm dialog names the guest** — the real `PortalNotificationPreviewModal` with the
  props `ManagerTours` now passes: Recipient is the guest's name, with Email and Phone listed
  beside it, where the raw address used to be the whole fact.
- **Manager Send is never silent** — the real `ManagerInbox` on a conversation that only ever
  texted the work number: a refused send puts the reason on screen and keeps the draft; a
  conversation with no email and no phone says exactly that instead of "choose a channel".
