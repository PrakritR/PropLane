# Payments "Upcoming" + resident visibility browser regression (PLAN-0920-2357)

Run `npm run test:payments-upcoming` (Chromium via `npx playwright install chromium`).

Bundles the **real** `ManagerPayments` page (list, Filter sheet, Payment settings
dialog, payment record page), the **real** `ResidentPaymentsPanel`, `Modal`,
`WorkspaceProvider` and current Tailwind CSS with esbuild and serves them through
Playwright request interception — no dev server, accounts, or database. Only the
portal session, app-UI provider, Next navigation / `next/link`, analytics and the
native-platform hook are stubbed (`stubs.tsx`). Every `/api/**` call is answered
by an in-memory server in the spec that also records writes; charges come from
`seed.ts`, dated relative to today so the scenario never rots.

Covers:

- manager Pending renders due-now rows first, then an **Upcoming** group (later
  calendar month), desktop and phone;
- the Filter sheet's **Upcoming charges → Hide** drops the group and the Pending
  count, PATCHes `showUpcomingCharges:false`, mirrors it to sessionStorage, and
  survives a reload;
- the Payment settings dialog renders the scope bar on its own row under the
  title, exactly one **Upcoming charges in Payments** row (same saved value), the
  autopay rows once, and flipping it back to Show restores the group;
- the payment record page has no Edit pencil; **Record payment** marks the charge
  paid and returns to the list; **Delete** removes it;
- the resident Pending tab hides next month's rent (> 7 days out) while showing a
  charge due in 3 days and one the manager surfaced (`residentVisibleAt`).

Set `EVIDENCE_DIR=<dir>` to also write screenshots and the recorded writes there.
