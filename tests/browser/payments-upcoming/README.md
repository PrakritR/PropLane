# Payments "Upcoming" + resident visibility browser regression (PLAN-0920-2357)

Run `npm run test:payments-upcoming` (Chromium via `npx playwright install chromium`).

Bundles the **real** `ManagerPayments` page (list, Filter sheet, Payment settings
dialog, payment record page), the **real** `ResidentPaymentsPanel`, `Modal`,
`WorkspaceProvider` and current Tailwind CSS with esbuild and serves them through
Playwright request interception — no dev server, accounts, or database. Only the
portal session, app-UI provider, Next navigation / `next/link`, analytics and the
native-platform hook are stubbed (`stubs.tsx`); the router stub navigates
client-side (`history.pushState` + re-render), the way Next does, so a tab switch
never remounts the panel. Every `/api/**` call is answered by an in-memory server
in the spec that also records writes; charges and the resident's directory row
come from `seed.ts`, dated relative to today so the scenario never rots.

Covers:

- manager Pending renders due-now rows first, then the later-month charges **in
  the same flat list** (the "Upcoming" heading was dropped in 6afe5543e; unit
  guard: `tests/unit/manager-payments-upcoming.test.tsx`), desktop and phone;
- the Filter sheet's **Upcoming charges → Hide** drops those rows and the Pending
  count, PATCHes `showUpcomingCharges:false`, mirrors it to sessionStorage, and
  survives a reload;
- the Payment settings dialog renders the scope bar on its own row under the
  title and each payouts section once, and does **not** carry a second
  Show/Hide control for the same saved field (removed in 2858fde19) — flipping
  it back to Show in the Filter sheet restores the rows;
- the payment record page carries the C2-PAY header actions (Take payment, Mark
  paid offline, Send reminder, Edit, Download, Delete); **Mark paid offline** is
  server-confirmed (`recordOfflinePayment`, the fixture applies it and echoes the
  charge back); **Delete** removes it;
- the resident lands on **Due** when something is overdue, **Upcoming stays
  reachable** from there, and next month's rent (> 7 days out) is hidden while a
  charge due in 3 days and one the manager surfaced (`residentVisibleAt`) show.

Note on the seed: the manager ledger hides a charge whose resident has no
application row at all (`manager-payments-scope.ts`, the orphaned-resident
backstop), so `seed.ts` ships Maya's approved application row alongside the
charges. Without it the list renders empty.

Set `EVIDENCE_DIR=<dir>` to also write screenshots and the recorded writes there.
