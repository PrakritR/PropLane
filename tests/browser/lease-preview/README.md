# Lease preview browser regression

Run `npm run test:lease-preview` (install Chromium and WebKit with
`npx playwright install chromium webkit` if needed).

These tests bundle the **real** `LeaseGenerateModal`, `Modal`,
`LeaseHtmlDirectEditor`, saved manager/resident preview components, and current
Tailwind CSS. Playwright serves the bundle through request interception; no dev
server, accounts, database writes, or AI calls are needed. Only data providers,
analytics, uploaded-PDF rendering, and the assistant are stubbed.

Chromium and WebKit cover desktop, phone, and short viewports, scrolling to the
last section, changed rent surviving HTML/Visual switching and saving, disclosure
locks, reopening, template changes, and visual edits after an external update and
unrelated parent render. This complements the jsdom tests, which cannot measure
layout. The assistant rail and authenticated success navigation also need a
sandbox smoke check on `/portal/leases`.
