# Prospect SMS local browser evidence

Date: 2026-09-12. Root Astra independent QA during correction cycle 1.

- Confirmed `.env` Supabase URL targets dev/test (`emstjswhotsnyksqhqyf`). No production database or live messaging used.
- `npm run sandbox:pin -- 3010`: exit 0. `npm run dev -- --port 3010` reached Ready. The prior implementation-manager server had already stopped; its reported URL initially returned connection refused.
- Used Playwright CLI with a fresh `prospect-sms-root` Chromium session. Default Chrome executable was absent; existing installed Chromium succeeded through an explicit browser config.
- Anonymous navigation to `/portal/communication/sms` redirected to sign-in as expected. Seeded manager credentials from `tests/fixtures/qa-accounts.mjs` signed in successfully. The SMS URL redirected toward `/portal/communication/active`, consistent with the default SMS UI flag. No compose/send action was performed.
- Portal browser snapshots timed out. Server logs showed cold compile/API responses taking 25-57 seconds. The portal was not accepted as fully exercised.
- A browser navigation to `/rent/tours-contact?propertyId=mgr-test-fir` timed out after 60 seconds. Independent bounded HTTP requests to that route and `/api/public/tour-slots?propertyId=mgr-test-fir` each timed out after 45 seconds (curl exit 28). No response is not evidence of correct tour behavior.
- The root browser session was closed and task-owned server stopped. Re-run a bounded browser check against the final corrected build before claiming successful browser QA.

## Graph tooling

`npx graphify hook-rebuild` failed in the implementation pass (npm could not resolve an executable). Root confirmed PATH resolves to the legacy Python `graphifyy` executable at `~/.local/bin/graphify`; its help has no `hook-rebuild` or `portable-check`. The repo expects a TypeScript runtime, which is absent from `.graphify/.graphify_runtime.json`. Root did not overwrite the existing graph with the incompatible legacy workflow or mutate tracked graph state. Refresh and portability validation remain incomplete.

## Read-only seeded-data tour service check

The actual `listOpenTourSlots` implementation was invoked with the service client pinned explicitly to dev/test, using Node's `react-server` condition and `tsx`. Both calls exited 0 and used real seeded data without writes or provider sends:

- `mgr-test-fir`: `ok: true`, `resolution: resolved`, 106 open slot keys.
- `sms-qa-deliberately-missing`: `ok: true`, `resolution: unavailable`, zero slot keys.

This verifies the real service's resolved/open versus unresolved distinction on dev/test. It does not establish the live Jain Home calendar or end-to-end model behavior. The proper HTTP availability route is `/api/public/property-tour-availability`; the earlier exploratory `/api/public/tour-slots` request was not the implemented API and is not counted as functional API QA.

The actual `list_live_listings` typed tool was then called with a server-derived owner context for the same dev/test property. Both `FirLofts` and `Fir Lofts` returned one exact match with canonical ID `mgr-test-fir` (command exit 0). This used real stored listing data and the real resolver, without model calls, writes, or SMS. It verifies joined/spaced matching beyond a mock fixture; the live Jain Home row was not queried.

## Final original-build browser QA, before release integration

On 2026-09-12 the original reviewed build was started on port 3010 with the dev/test database explicitly checked and pinned. The server used `VERCEL_ENV=preview` only for this narrow seeded-data read walkthrough, since a production runtime intentionally hides sandbox listings. This is not broad production-runtime acceptance.

- `/api/public/property-tour-availability?propertyId=mgr-test-fir`: HTTP 200, 102 open slot keys, command exit 0. Missing property: HTTP 200, zero keys, exit 0. These are the real route and real dev/test rows.
- Chromium navigated to `/rent/tours-contact?propertyId=mgr-test-fir`, continued as guest, selected Loft 3 and advanced to Date & time. September 14 was enabled/open; selecting it rendered time choices. No tour was submitted and no message was sent.
- The initial asynchronous page snapshot showed the manager-link gate before the listing load settled; later snapshots showed the correct Fir Lofts data. No console errors, existing warnings recorded by Playwright.
- Snapshots: `.playwright-cli/page-2026-09-12T18-41-00-805Z.yml`, `page-2026-09-12T18-42-03-548Z.yml`, `page-2026-09-12T18-42-24-165Z.yml`.

Production release was subsequently requested. Upstream is 289 commits ahead, so this original-build evidence does not replace fresh integrated-tree QA. Release plan: `docs/plans/prospect-sms-release.md`.

## Integrated release browser QA

The final pool5 build based on upstream `b6085cd66` passed `npm run build` with a 4 GB Node heap, exit 0. Pinned port 3012 before starting the built server. Its local environment remains dev/test; `VERCEL_ENV=preview` was used only for this seeded-data read walkthrough.

- Real Fir Lofts property: guest scheduling, Loft 3 selection, Date & time, September 14 selection rendered 14 available times from 9 am through 4:30 pm. No booking or SMS was submitted.
- At 390 by 844, document width was 390 with no horizontal overflow.
- An invalid property rendered the manager-link gate. Anonymous `/portal/communication/sms` redirected to `/auth/sign-in` with the original path retained in `next`.
- First exploratory CLI calls used an incorrect guest-button label and an unavailable `URL` global; corrected observed selectors and direct pathname evaluation verified the actual behavior. These tooling errors are not counted as successful checks.
- Public smoke initially exited 1 because inherited `.env.test` selected stale `admin@test.axis.local` credentials. Reran using the canonical `QA_ACCOUNTS` values from the current checkout, passed all admin/manager/resident login preflights, and passed all 10 smoke cases, exit 0. No credentials were printed. Command: `npm run test:e2e:smoke` with `PLAYWRIGHT_SKIP_WEBSERVER=1`, `PLAYWRIGHT_BASE_URL=http://localhost:3012`, `E2E_TESTS_ENABLED=1`, Node 22 and canonical account environment overrides. Log: `/tmp/prospect-sms-release-e2e-canonical.log`.
- `npm run sandbox:open -- '/rent/tours-contact?propertyId=mgr-test-fir'`: exit 0. Review URL: `http://localhost:3012/rent/tours-contact?propertyId=mgr-test-fir`.

This verifies integrated local behavior; QStash delivery, live Jain Home model behavior and actual SMS delivery still require configured staging QA.
