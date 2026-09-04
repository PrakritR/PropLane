# Assigned Linear issues — priority digest

Generated September 4, 2026. There are 27 active assigned issues, all currently marked High in Linear. The priority tiers below are recommended execution order, not changes to Linear's stored priority.

## P0 — user harm, data integrity, and access

- [x] [PRP-202 — Rental applications lack server-side validation](https://linear.app/axishousing/issue/PRP-202/rental-applications-get-no-server-side-validation-the-api-accepts)
  Completed locally September 4, 2026. Applicant-owned submissions now run the shared wizard validator against the server-stored listing configuration before persistence, return field-level errors, validate required Review-step questions, and keep draft autosaves plus manager repair edits intact.

- [PRP-239 — Existing tenant locked out of Payments without signed PDF](https://linear.app/axishousing/issue/PRP-239/a-real-rent-paying-tenant-is-locked-out-of-payments-when-onboarded)
  Existing tenants without a signed-PDF lease are treated as prospects and lose access to Payments, Services, Lease, and Documents. Separate residency/access entitlement from the PDF-signature path.

- [PRP-184 — Website UI audit findings](https://linear.app/axishousing/issue/PRP-184/website-ui-audit-aug-2026-11-open-findings-incl-19-colour-contrast)
  The August UI audit contains 11 unresolved findings, including 19 contrast failures, nested interactive controls, and a soft 404. Break this parent audit into executable accessibility and task-completion fixes.

- [PRP-189 — Login error offers no recovery path](https://linear.app/axishousing/issue/PRP-189/andquotinvalid-login-credentialsandquot-is-the-only-feedback-when-an)
  Nonexistent accounts receive a generic provider error with no helpful recovery path. Replace it with product-language guidance and a clear signup or recovery route.

## P1 — text-first operations foundation

Three near-identical umbrella epics overlap: [PRP-260](https://linear.app/axishousing/issue/PRP-260/epic-sms-first-operations-text-a-work-order-number-the-system-does-the), [PRP-264](https://linear.app/axishousing/issue/PRP-264/epic-text-first-operations-work-order-number-drives-actions-for-all), and [PRP-284](https://linear.app/axishousing/issue/PRP-284/epic-text-first-ai-operations-work-order-number-as-universal-handle). Pick PRP-260 as the canonical epic and relate or close the duplicate planning tickets.

### Work-order identity and routing

- [PRP-261 — Work-order reference resolution](https://linear.app/axishousing/issue/PRP-261/work-order-reference-resolution-make-andquotwo-1234andquot-a)
  Create stable, human-typeable work-order references and resolve them from inbound text within the sender's permitted scope.

- [PRP-286 — WO number parser](https://linear.app/axishousing/issue/PRP-286/ai-wo-number-parser-smsinbound-text-resolves-to-portal-work-order)
  This is the implementation-sized version of PRP-261: parse a work-order number from SMS or inbound text and map it to the record. Treat it as PRP-261's child rather than a separate initiative.

- [PRP-297 — Reply with work-order number](https://linear.app/axishousing/issue/PRP-297/sms-reply-with-work-order-number-to-get-status-or-take-allowed-actions)
  Let authorized managers, residents, and vendors text a work-order number for status and only permitted actions. Unknown or cross-tenant references must reveal nothing.

### Canonical action-event bus

- [PRP-262 — Work-order event orchestration](https://linear.app/axishousing/issue/PRP-262/work-order-event-orchestration-one-state-change-everyone-correctly)
  Replace ad-hoc work-order notifications with one lifecycle event emitter that renders the correct message for each audience.

- [PRP-279 — Action event bus](https://linear.app/axishousing/issue/PRP-279/comm-action-event-bus-work-order-payment-lease-events-fan-out-to)
  Generalize the event bus beyond work orders to payments and leases, with idempotent thread, SMS, and email consumers.

- [PRP-294 — Unified action bus](https://linear.app/axishousing/issue/PRP-294/messaging-unified-action-bus-wo-events-notify-all-parties-in-app-sms)
  This overlaps heavily with PRP-262 and PRP-279, specifically emphasizing multi-channel fanout. Fold it into the canonical event-bus work.

### Role-specific SMS workflows

- [PRP-265 — Resident maintenance text creates work order](https://linear.app/axishousing/issue/PRP-265/sms-resident-texts-maintenance-issue-create-work-order-notify-manager)
  Convert a resident maintenance text into a real, deduplicated work order, notify the manager and vendor, and reply with the new reference.

- [PRP-288 — Text-only resident workflow](https://linear.app/axishousing/issue/PRP-288/sms-text-only-resident-workflow-maintenance-payment-reminders)
  Umbrella for resident maintenance texting and payment reminders. Make PRP-265 and PRP-266 its concrete children.

- [PRP-271 — Vendor SMS completion loop](https://linear.app/axishousing/issue/PRP-271/vendor-sms-completion-loop-accept-schedule-done-and-invoice-entirely)
  Enable vendors to accept, schedule, complete, and invoice jobs by text instead of the current answer-only SMS surface.

- [PRP-287 — Text-only vendor workflow](https://linear.app/axishousing/issue/PRP-287/sms-text-only-vendor-workflow-bidacceptstatus-without-portal-login)
  The shorter vendor-workflow version of PRP-271. Consolidate it under PRP-271.

### System-initiated reminders

- [PRP-263 — Proactive outbound engine](https://linear.app/axishousing/issue/PRP-263/proactive-outbound-engine-the-system-texts-first-rent-due-job-stalled)
  Build a general scheduled trigger-to-audience-to-message engine for rent, stalled jobs, invoices, and other attention-needed events.

- [PRP-266 — Automated rent payment reminders](https://linear.app/axishousing/issue/PRP-266/sms-automated-rent-payment-reminders-to-residents-with-pay-link)
  Deliver the first use case for that engine: configurable, opt-out-aware rent reminders with platform payment links and auditability.

- [PRP-267 — Manager attention digest](https://linear.app/axishousing/issue/PRP-267/sms-manager-digest-tasks-that-need-attention-payments-wos-applications)
  Send managers a daily or weekly SMS digest sourced from existing dashboard attention groups, without bypassing portal confirmation for destructive actions.

## P2 — pricing, controls, and economics

- [PRP-257 — Admin-configurable pricing, fees, and limits](https://linear.app/axishousing/issue/PRP-257/admin-internal-tools-make-pricing-fees-and-limits-configurable-per)
  Move pricing, tier limits, trial length, application defaults, and fee rules out of source constants into admin-configurable settings. This is the enabling control plane for the business-model work.

- [PRP-285 — Cost of absorbing all fees](https://linear.app/axishousing/issue/PRP-285/business-model-proplane-absorbs-all-fees-today-what-that-costs-and)
  Document the cost of PropLane absorbing payment fees and define a measurable threshold for revisiting that decision.

- [PRP-281 — Unit economics model](https://linear.app/axishousing/issue/PRP-281/growth-unit-economics-model-sms-ai-and-stripe-cost-per-active-manager)
  Produce a unit-economics model for SMS, AI, Stripe, and active-manager size bands using captain-reviewed assumptions.

- [PRP-282 — Pricing-tier entitlements](https://linear.app/axishousing/issue/PRP-282/growth-pricing-tiers-probusiness-entitlements-for-ai-turns-and-sms)
  Define future Pro and Business allowances, usage meters, and paywall copy. Instrument usage before enforcing limits.

- [PRP-278 — Manager profitability dashboard](https://linear.app/axishousing/issue/PRP-278/payments-manager-profitability-dashboard-gross-rent-fees-sms-and)
  Build a read-only profitability view backed by ledger and payout data, including accountant-friendly CSV export.

## P3 — platform expansion and internal operations

- [PRP-280 — SaaS webhooks API](https://linear.app/axishousing/issue/PRP-280/infra-saas-webhooks-api-subscribe-to-wo-payment-and-message-events)
  Offer manager-scoped, HMAC-signed, retried webhooks for work-order, payment, and message events. Reuse the canonical action-event bus once that exists.

- [PRP-192 — Supported account teardown](https://linear.app/axishousing/issue/PRP-192/no-supported-way-to-delete-an-account-and-its-data-every-teardown-is)
  Create a supported, carefully scoped account teardown process instead of manually deleting rows across roughly 40 tables. It is valuable for test and development operations, but lower urgency than production-user harm.

## Recommended immediate sequence

1. PRP-239
2. Consolidate the overlapping text-first epics and tickets
3. PRP-261 / PRP-286 / PRP-297
4. PRP-262 / PRP-279 / PRP-294
5. Role-specific workflows and reminders

## Completed work log

### September 4, 2026 — PRP-202

- Added a server-only validation boundary for guest and signed-in resident submissions before `manager_application_records` persistence.
- Reused the same submit validator in the browser and server, with the authoritative listing configuration loaded from Supabase for custom requirements and disabled fields.
- Added Review as a configurable application section and included step 10 in the shared submit-validation sequence.
- Preserved incomplete draft autosaves and existing manager/admin repair workflows; existing submitted applicant records are not retroactively blocked by newly introduced requirements.
- Verification: 947 unit-test files / 6,282 tests passed; focused ESLint passed with no errors; repository lint passed with no errors (pre-existing warnings remain); TypeScript passed; Next.js production build passed.
