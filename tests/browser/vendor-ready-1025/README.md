# Vendor-ready (claude-2/vendor-ready-1025) browser proof

```bash
npm run test:vendor-ready                       # pass/fail
EVIDENCE_DIR=<dir> npm run test:vendor-ready    # + reviewer screenshots and the recorded writes
```

Bundles the **real** `VendorWorkOrdersPanel`, `VendorTaskList`, `VendorCommunication` /
`VendorInboxPanel`, `ManagerOutgoingInvoicesPanel`, `VendorInvoiceManagerPaySheet` and
`ManagerWorkOrdersPanel` with the project's own Tailwind build (`src/app/globals.css`)
and drives them in Chromium through request interception — no dev server, accounts,
database or Stripe. Only the portal session, app-UI provider (toasts / confirm), Next
navigation / `next/link` / `next/image` and analytics are stubbed; every `/api/**` call is
answered by an in-memory server in the spec, which records writes so the spec can assert
exactly what was sent and what was **not**.

What it proves, end-user side:

- a directly **Assigned** job carries the vendor's own **Visit time** picker, and
  **Schedule visit** posts `/api/portal/work-orders/schedule-visit` with the picked time;
  the job then reads Scheduled and leaves the Assigned tab;
- the vendor's **Tasks** section is back (titled Tasks, not Services) and a row's own
  action marks the task completed, moving it to the Completed tab;
- **Complete** on a Scheduled job refuses without a photo, and a picked 2400×1600 PNG is
  downscaled on the client to a JPEG data URL under the server's 2 MB cap; the server
  (running the real `validateCompletionPhotos`) stores it in the private bucket and the
  row keeps a **path**, never the bytes;
- the manager's service record reads those photos back through the signed-URL route, and
  a legacy row whose photos are still inline base64 still renders;
- the pay sheet's **one line** warning when the vendor has no bank connected yet, with
  **Continue to payment** still enabled;
- a vendor's reply to their manager lands on the same conversation and reports
  **"Sent in PropLane."** — no work identity, no reply-binding address.

Two fixture notes:

- the page is served at the **route's own path**, never `/`: `isDemoModeActive()` reads
  `/` as the public demo sandbox, which sends every panel down its demo branch;
- `crypto.randomUUID` is polyfilled in an init script, because it exists only in a secure
  context and this fixture is plain http on a made-up host.

The server-side halves with no screen of their own (invite redemption, the send outcome,
the 90-day hold expiry) are written out as a transcript by
`tests/unit/evidence-vendor-ready-1025.test.ts`.
