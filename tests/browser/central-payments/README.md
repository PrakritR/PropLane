# Central payments browser proof

Run `npm run test:central-payments` (Chromium via `npx playwright install chromium`).

Bundles the **real** `ResidentPaymentsPanel`, `PortalPayoutsSettingsPage`,
`PayoutWithdrawSheet`, `ApplicationPaymentReceiptCard`, `Modal` and current
Tailwind CSS with esbuild and serves them through Playwright request
interception — no dev server, accounts, database or Stripe. Only the portal
session, app-UI provider, Next navigation / `next/link`, analytics and the
native-platform hook are stubbed; those stubs are shared with
`tests/browser/payments-upcoming`. Every `/api/**` call is answered by an
in-memory server in the spec, which also records writes so the spec can assert
what was **not** called.

Covers the resident-facing and manager-facing halves of central source
arbitration:

- the resident pay surface offers **both** slots — the whole-cart **Pay all** in
  the list header and the per-charge **Pay $X** on the charge's record page;
- the pay modal's first step is a method pick — **Card** vs in-app **Bank
  (ACH)** — and nothing is claimed server-side until the explicit
  **Continue with …**: no `POST /api/stripe/household-charge-checkout` before
  that click, exactly one after it, carrying the chosen method and the exact
  charge ids (whole-cart claims every payable line in one call);
- the manager's **Balance & payouts** page keeps the two legs of the rail apart:
  **Held pending bank** (captured on the PropLane platform and classified to
  this owner) vs **Available to withdraw** (already transferred to the owner's
  Connect account), with per-source movement history naming each leg;
- the **Withdraw** sheet opens prefilled with the *withdrawable* figure only —
  the money still held on the platform is never offered;
- the application-fee receipt the central rail can state exactly reads
  **Paid / Amount received / Paid on**, while an ambiguous legacy row reads
  **Payment needs review / Amount recorded** and carries no paid-on date. Both
  receipts in that test come from the real `applicationPaymentReceipt`
  resolver, not a hand-picked status.

Note on the balance stub: `isPortalPayoutBalance` rejects a snapshot missing any
of `withdrawableCents`, `heldCents`, `releasePendingCents`,
`recoveryOutstandingCents`, `recoveryReservedCents`, and payout destinations are
read from the live `connect/bank-accounts` list rather than the balance's
display-only bank summary. A fixture that answers either loosely renders
"Could not load payouts." instead of the page.

Set `EVIDENCE_DIR=<dir>` to also write screenshots and the recorded writes there.
