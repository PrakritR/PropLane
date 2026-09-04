# Assigned Linear issues — priority digest

Generated September 4, 2026. There are 27 active assigned issues, all currently marked High in Linear. The priority tiers below are recommended execution order, not changes to Linear's stored priority.

Progress: 8 completed locally (7 + PRP-192, already shipped and only just discovered to be stale in this doc), 19 remaining. **Linear re-triage, September 4 2026 (Prakrit Ramachandran):** PRP-260, PRP-261, PRP-262, PRP-284, PRP-286, PRP-287, PRP-288, PRP-294 were all closed Canceled as duplicates/superseded — verified each one via its Linear comment: none is a scope cut, every capability is tracked (and, where already built, credited) under a surviving canonical ticket (PRP-264, PRP-265, PRP-271, PRP-279, PRP-297). Linear now also shows PRP-297 and PRP-279 as Done to match the local work below, and their acceptance checklists are checked off. Nothing needed to be reverted from this repo. Of the 19 remaining issues, 6 need no separate work (closed as duplicates/superseded above), 12 are actionable (including the PRP-264 epic itself and PRP-184, which still needs breaking into fixes), and PRP-239 is a separate, unresolved gap (Linear says Done, but the fix lives only on another session's unmerged `claude-1` branch) — see its P0 entry below.

## P0 — user harm, data integrity, and access

- [x] [PRP-202 — Rental applications lack server-side validation](https://linear.app/axishousing/issue/PRP-202/rental-applications-get-no-server-side-validation-the-api-accepts)
  Completed locally September 4, 2026. Applicant-owned submissions now run the shared wizard validator against the server-stored listing configuration before persistence, return field-level errors, validate required Review-step questions, and keep draft autosaves plus manager repair edits intact.

- [PRP-239 — Existing tenant locked out of Payments without signed PDF](https://linear.app/axishousing/issue/PRP-239/a-real-rent-paying-tenant-is-locked-out-of-payments-when-onboarded)
  Existing tenants without a signed-PDF lease are treated as prospects and lose access to Payments, Services, Lease, and Documents. **Status, checked September 4 2026: Linear shows this Done, but the fix is NOT on this repo's `main`.** Per Linear's comment, it was built on a different session's `claude-1` branch (commit `ac3b4189`, its own 6,937-test suite green) — `git fetch origin` here shows `origin/claude-1` is ahead of the commit `main` branched from, and that commit hash doesn't exist locally. The fix itself (per the comment): `managerAttestedTenancyAt` stamped on the no-PDF onboarding branch, read alongside the signed-lease check so `leaseAccessUnlocked` reflects tenancy rather than document upload, deliberately without fabricating `externallySignedLease`/signature evidence for a document that doesn't exist. **Action needed: merge or cherry-pick `claude-1`'s PRP-239 commit onto `main` before treating this as shipped here** — do not re-implement it from scratch.

- [PRP-184 — Website UI audit findings](https://linear.app/axishousing/issue/PRP-184/website-ui-audit-aug-2026-11-open-findings-incl-19-colour-contrast)
  The August UI audit contains 11 unresolved findings, including 19 contrast failures, nested interactive controls, and a soft 404. Break this parent audit into executable accessibility and task-completion fixes.

- [x] [PRP-189 — Login error offers no recovery path](https://linear.app/axishousing/issue/PRP-189/andquotinvalid-login-credentialsandquot-is-the-only-feedback-when-an)
  Completed locally September 4, 2026. Credential mismatches now use privacy-preserving PropLane copy and place both password reset and account creation directly in the error state while retaining the original signup destination.

## P1 — text-first operations foundation

Three near-identical umbrella epics overlapped: [PRP-260](https://linear.app/axishousing/issue/PRP-260/epic-sms-first-operations-text-a-work-order-number-the-system-does-the), [PRP-264](https://linear.app/axishousing/issue/PRP-264/epic-text-first-operations-work-order-number-drives-actions-for-all), and [PRP-284](https://linear.app/axishousing/issue/PRP-284/epic-text-first-ai-operations-work-order-number-as-universal-handle). **Already resolved in Linear on September 4 2026** — the captain picked PRP-264 as canonical (not PRP-260 as this doc originally recommended) and closed PRP-260 and PRP-284 as duplicates of it. No action needed here.

### Work-order identity and routing

- [x] [PRP-261 — Work-order reference resolution](https://linear.app/axishousing/issue/PRP-261/work-order-reference-resolution-make-andquotwo-1234andquot-a) — **Linear: closed Canceled as superseded by PRP-297.**
  Completed locally September 4, 2026. Work orders now receive stable per-manager `WO-####` handles without changing their primary keys; manager, resident, and vendor lookup paths resolve only from their existing authorized row sets, handle ambiguity explicitly, and show the handle in each portal. The code is real and shipped; only the tracking ticket was closed as a duplicate.

- [x] [PRP-286 — WO number parser](https://linear.app/axishousing/issue/PRP-286/ai-wo-number-parser-smsinbound-text-resolves-to-portal-work-order) — **Linear: closed Canceled as an empty-stub duplicate of PRP-297.**
  Completed locally September 4, 2026. A pure, client-safe parser now extracts and normalizes human work-order references from inbound text, rejects common numeric false positives, deduplicates candidates, and bounds hostile input. Scoped record lookup remains in PRP-261.

- [x] [PRP-297 — Reply with work-order number](https://linear.app/axishousing/issue/PRP-297/sms-reply-with-work-order-number-to-get-status-or-take-allowed-actions) — **Linear: marked Done September 4, 2026, acceptance checklist checked off.**
  Completed locally September 4, 2026. Manager, resident, and vendor SMS paths now resolve a texted work-order handle inside their existing authorization scope before intent handling; status/action context uses the opaque id internally, while unknown and cross-tenant handles share one generic response.

### Canonical action-event bus

- [x] [PRP-262 — Work-order event orchestration](https://linear.app/axishousing/issue/PRP-262/work-order-event-orchestration-one-state-change-everyone-correctly) — **Linear: closed Canceled as superseded by PRP-279.**
  Replace ad-hoc work-order notifications with one lifecycle event emitter that renders the correct message for each audience.

  Completed locally September 4, 2026. Added the idempotent `workOrderEvent` lifecycle emitter, privacy-scoped audience renderers, durable retry/defer delivery records, notification-preference fanout, quiet-hours suppression, rapid-change digesting, and initial offer/accept/invoice/pay producers. The code is real and shipped; only the tracking ticket was closed as a duplicate.

- [x] [PRP-279 — Action event bus](https://linear.app/axishousing/issue/PRP-279/comm-action-event-bus-work-order-payment-lease-events-fan-out-to) — **Linear: marked Done September 4, 2026, acceptance checklist checked off.**
  Generalize the event bus beyond work orders to payments and leases, with idempotent thread, SMS, and email consumers.

  Completed locally September 4, 2026. Generalized the work-order outbox in place into one action-event bus, documented the work-order/payment/lease catalog, wired confirmed charge and lease transitions, made inbox appends replay-safe with deterministic message ids, and added atomically claimed scheduled retries for failed/deferred deliveries.

- [PRP-294 — Unified action bus](https://linear.app/axishousing/issue/PRP-294/messaging-unified-action-bus-wo-events-notify-all-parties-in-app-sms) — **Linear: closed Canceled as an empty-stub duplicate of PRP-279.**
  This overlaps heavily with PRP-262 and PRP-279, specifically emphasizing multi-channel fanout. Fold it into the canonical event-bus work.

  Folded into the PRP-262/PRP-279 canonical bus implementation; no parallel bus should be built for this ticket.

### Role-specific SMS workflows

- [PRP-265 — Resident maintenance text creates work order](https://linear.app/axishousing/issue/PRP-265/sms-resident-texts-maintenance-issue-create-work-order-notify-manager)
  Convert a resident maintenance text into a real, deduplicated work order, notify the manager and vendor, and reply with the new reference.

- [PRP-288 — Text-only resident workflow](https://linear.app/axishousing/issue/PRP-288/sms-text-only-resident-workflow-maintenance-payment-reminders) — **Linear: closed Canceled as an empty-stub duplicate of PRP-265.**
  Umbrella for resident maintenance texting and payment reminders. PRP-265 remains unbuilt and actionable; this row is now just a pointer to it.

- [PRP-271 — Vendor SMS completion loop](https://linear.app/axishousing/issue/PRP-271/vendor-sms-completion-loop-accept-schedule-done-and-invoice-entirely)
  Enable vendors to accept, schedule, complete, and invoice jobs by text instead of the current answer-only SMS surface. Still Backlog in Linear, unbuilt — actionable.

- [PRP-287 — Text-only vendor workflow](https://linear.app/axishousing/issue/PRP-287/sms-text-only-vendor-workflow-bidacceptstatus-without-portal-login) — **Linear: closed Canceled as an empty-stub duplicate of PRP-271.**
  The shorter vendor-workflow version of PRP-271. PRP-271 remains unbuilt and actionable; this row is now just a pointer to it.

### System-initiated reminders

- [PRP-263 — Proactive outbound engine](https://linear.app/axishousing/issue/PRP-263/proactive-outbound-engine-the-system-texts-first-rent-due-job-stalled) — **Linear: closed Canceled as superseded by PRP-266 + PRP-267.**
  Build a general scheduled trigger-to-audience-to-message engine for rent, stalled jobs, invoices, and other attention-needed events. Neither successor is built yet — both remain actionable.

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

- [x] [PRP-192 — Supported account teardown](https://linear.app/axishousing/issue/PRP-192/no-supported-way-to-delete-an-account-and-its-data-every-teardown-is) — **Already done, predates this digest.** `POST /api/auth/delete-my-account` + `deleteOwnPortalAccount` (`src/lib/auth/delete-portal-account.ts`) already ship self-service account deletion on `main` (commit `a95cb112`, well before this session). Linear marked it Done September 4, 2026. This digest's original "not started" note was stale.

## Recommended immediate sequence

1. Merge or cherry-pick `claude-1`'s PRP-239 fix (commit `ac3b4189`) onto `main` — do not re-implement
2. Break PRP-184 into executable accessibility fixes and land each as its own commit
3. ~~Consolidate the overlapping text-first epics and tickets~~ — done in Linear September 4, 2026
4. ~~PRP-261 / PRP-286 / PRP-297~~ — done
5. ~~PRP-262 / PRP-279 / PRP-294~~ — done
6. Role-specific workflows and reminders: PRP-265, PRP-271, PRP-266, PRP-267 (still unbuilt)

## Completed work log

### September 4, 2026 — Linear reconciliation

- Synced Linear against this repo's actual state. Marked PRP-297 and PRP-279 Done with a commit-referenced summary comment on each and checked off their acceptance boxes, matching work already on `main`.
- Investigated every issue Linear showed Canceled that this doc listed as built or actionable (PRP-260, 261, 262, 263, 271's duplicate PRP-287, 284, 286, 288, 294). Read each cancellation comment: every one is a duplicate/superseded-by note pointing at a surviving canonical ticket (PRP-264, 265, 266, 267, 271, 279, 297), authored by Prakrit Ramachandran at 19:16-19:34 UTC. None is a scope cut — no code needed to be reverted from this repo.
- Found PRP-192 (account teardown) already shipped on `main` (`a95cb112`, predates this session) and marked Done in Linear — this doc's P3 listing was simply stale.
- Found a real gap: PRP-239 shows Done in Linear (comment cites commit `ac3b4189` on a `claude-1` branch, 6,937 tests), but `git fetch origin` shows that commit is not on `origin/main` or this repo's `main` — it exists only on `origin/claude-1`, an unmerged sibling worktree branch from the multi-agent setup in `AGENTS.md`. Flagged rather than re-implemented; needs a merge/cherry-pick decision from the captain, not fresh code.

### September 4, 2026 — PRP-262 / PRP-279

- Generalized the work-order-only lifecycle emitter into one canonical `action_events` / `action_event_deliveries` bus (`src/lib/action-events.server.ts`), migrating the existing tables in place (`20260904140000_action_event_bus.sql`) rather than standing up a parallel store.
- Added payment and lease transition producers (`src/lib/domain-action-events.server.ts`) with privacy-scoped resident/manager renderers, and wired them into the charge-status write paths (`household-charges.server.ts`, the household-charges route, both Stripe webhook/session handlers) and the lease-pipeline route; replaced the old ad-hoc FCM "payment received" push with the same durable inbox/email/SMS fanout every other event gets.
- Made inbox appends replay-safe with deterministic per-recipient message ids and added an idempotent `ON CONFLICT DO NOTHING` delivery upsert so a re-delivered event can't double-send.
- Added `/api/cron/action-event-deliveries` (every 10 minutes) to retry due failed/deferred deliveries via an atomic compare-and-swap claim, so a crashed worker's claim naturally expires back to due.
- Documented the domain/event catalog in `docs/action-event-catalog.md`. PRP-294 is folded into this work; no parallel bus was built for it.
- Fixed a pre-existing bug in the vendor-tool test fixture (`tests/unit/tools/vendor-scope-isolation.test.ts`): its fake Postgrest client never executed a mutation queued behind `.select().maybeSingle()` and didn't model `ignoreDuplicates`/`.gte()`, so any idempotent upsert-then-select call (used by both the old and new event bus) silently no-opted. Fixed the fixture to actually run pending writes and return the affected rows, which also fixed `mark_job_done`'s manager-notification assertion.
- Verification: full suite (954 unit-test files / 6,339 tests) passed; focused ESLint on every touched/added file passed with no errors; TypeScript passed with no errors.

### September 4, 2026 — PRP-297

- Narrowed manager and resident SMS turns with the PRP-261 scoped resolvers before model intent handling; resolved handles provide the internal id and current status while existing tool confirmation rules remain unchanged.
- Changed vendor inbound routing so a referenced work order selects its own authorized job session instead of always using the newest session; the vendor catalog remains job-bound and answer-only except for `escalate_to_manager`.
- Added deterministic miss and ambiguity replies before the model call, with the exact same message for an unknown handle and a real handle outside scope.
- Documented the parser/auth matrix and allowed-action boundary in `docs/agents/sms-system.md`.
- Verification: 9 affected SMS test files / 95 tests passed; focused ESLint, TypeScript, and diff checks passed.

### September 4, 2026 — PRP-261

- Added an atomic per-manager sequence allocator and deterministic backfill that stamps `WO-####` into each work order's JSON projection while preserving the existing opaque primary key.
- Added one authorization-neutral matcher plus manager, resident, and vendor adapters that reuse the existing delegated-property, resident-email/active-manager, and assigned/live-offer scopes.
- Made out-of-scope and unknown references share the same non-oracular response; multiple visible matches produce a concrete clarification question.
- Added the reference to all three agent tool projections and to manager, resident, and vendor portal work-order surfaces.
- Verification: 5 focused test files / 84 tests passed; focused ESLint passed with no errors (pre-existing warnings remain); TypeScript and diff checks passed.

### September 4, 2026 — PRP-286

- Added `resolveWorkOrderReference` for `WO-1042`, `wo 1042`, `work order #1042`, `#1042`, `status 1042`, and standalone-number messages.
- Normalized every candidate to the canonical `WO-<sequence>` display form while leaving database ids untouched.
- Kept the parser authorization-neutral with an explicit scoped-lookup invariant for PRP-261; arbitrary numbers in prose do not become job claims.
- Added table-driven coverage for real formats, multiple/deduplicated references, numeric false positives, invalid sequences, and bounded hostile input.
- Verification: all 949 unit-test files / 6,312 unique tests passed (one unrelated import hook that timed out under full-suite parallel load passed all 8 cases in isolation); focused ESLint passed with no errors; TypeScript and diff checks passed.

### September 4, 2026 — PRP-189

- Replaced Supabase's raw invalid-credential string with product-language guidance that remains intentionally opaque about whether an email is registered.
- Added password-reset and context-preserving account-creation actions inside the first credential-mismatch error.
- Added an announced alert state and associated both credential fields with the visible error for assistive technology.
- Added focused regression coverage for copy, privacy posture, recovery links, preserved signup destination, and network-error language.
- Verification: all 948 unit-test files / 6,286 unique tests passed (two localhost-dependent suites were rerun outside the sandbox after its loopback restriction caused timeouts); focused ESLint passed with no errors; TypeScript passed; Next.js production build passed; browser checks passed at 375×812 and 1280×900 with no horizontal overflow.

### September 4, 2026 — PRP-202

- Added a server-only validation boundary for guest and signed-in resident submissions before `manager_application_records` persistence.
- Reused the same submit validator in the browser and server, with the authoritative listing configuration loaded from Supabase for custom requirements and disabled fields.
- Added Review as a configurable application section and included step 10 in the shared submit-validation sequence.
- Preserved incomplete draft autosaves and existing manager/admin repair workflows; existing submitted applicant records are not retroactively blocked by newly introduced requirements.
- Verification: 947 unit-test files / 6,282 tests passed; focused ESLint passed with no errors; repository lint passed with no errors (pre-existing warnings remain); TypeScript passed; Next.js production build passed.

### September 4, 2026 — PRP-239 ready-to-build plan

- Linear carries a hard approval gate, so no product behavior was changed without the requested captain review. The referenced Lavish plan lives under another user's `/Users/prakrit/...` path and is not available in this workspace.
- Confirmed failure chain: the no-PDF branch in `existing-resident-onboarding.server.ts` creates a `bucket: "manager"` lease without execution evidence; `loadResidentLeaseSignedStatus` therefore returns false; resident nav resolves to the prospect/pre-approval surface.
- Proposed implementation after approval: make existing-resident onboarding explicitly attest an already-executed off-platform tenancy, persist server-authored execution evidence independently of whether a PDF was uploaded, and keep a missing document visible as a document-completeness concern rather than an access entitlement.
- Required regression coverage: no-PDF onboarding creates coherent executed-tenancy state; `loadResidentLeaseSignedStatus` recognizes it; `resolveResidentPortalNavStage` unlocks the current-resident sections; Payments is present in the web/native resident nav; uploaded-PDF onboarding remains unchanged.
