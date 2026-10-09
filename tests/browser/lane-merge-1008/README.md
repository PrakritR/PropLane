# Lane merge 2026-10-08 — visual evidence

Run `npm run test:lane-merge` (install Chromium with `npx playwright install
chromium` if needed). Set `EVIDENCE_DIR=<dir>` to write the screenshots
somewhere a reviewer can read them.

These tests bundle the **real** `ReelStudio`, the **real** Remotion `Reel`
composition, the **real** `ManagerWorkOrdersPanel`, `InboxAvatar`,
`AdminPaymentsPanel`, `AdminSubscribersPanel` and `AdminFinancesPanel` together
with the current Tailwind build, and drive them in Chromium through request
interception — no dev server, accounts or database. Only the portal session,
`next/navigation` and analytics are stubbed, so what the screenshots show is the
surface an end user sees.

They cover the parts of the lane the jsdom tests can only assert as values:

- **Reel studio** — removing a scene re-flows `startMs`/`endMs` contiguously
  (0–3 / 3–8 / 8–10 s becomes 0–5 / 5–7 s, no hole) **and** every survivor keeps
  its own clip, because assets are keyed on the scene's stable `meta.sceneId`.
  Before the fix the renumbered survivor picked up the removed scene's video.
- **The rendered reel** — four frames of a 12.6 s reel over 6 s of scenes: the
  last scene is held at t = 8 s, and the end card owns only the final
  `endCardMs` (from 10.1 s). Before the fix the card started at 6 s and covered
  the narration.
- **The service record header** — Edit, one red trash and the next step, with no
  Message action.
- **Phone inbox tiles** — a contact known only by number gets the phone glyph,
  never initials made out of "+(".
- **New message on a phone** — the one composer at 390 px: every tool in its
  action row (attach, draft, **schedule for later**, In-app, Email, Text) measures
  44 x 44, and the chrome stays icon-only.
- **Admin Money** — Payments live from the platform Stripe account (tabs, stat
  strip, icon-only chrome, flat rows, no pills), Subscribers with a live trial
  and a complimentary account, and Finances drawing the P&L from
  `platform_expenses`.

The admin panes are driven against the real response contracts
(`AdminRevenuePage`, `SubscriberRow`, `PlatformPnl`, `PlatformExpense`), shaped
in the spec's `page.route` handler.
