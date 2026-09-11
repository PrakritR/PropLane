# Akhil Authorized Release Handoff

Date: 2026-09-10

Status: keeper-ready for fresh Astra review. No protected branch was pushed or promoted. Production remains blocked by confirmed production schema omissions.

## Objective and ownership

This execution follows `docs/plans/2026-09-10-akhil-authorized-release-plan.md` and Akhil's explicit request to let agents working for him carry his own keeper through `main`, `staging`, and `production` after an explicit ship request, while preserving Prakrit's captain process. Root owns the fresh Astra review and any later release action. This Sol manager owned the ordinary `origin/main` integration, instruction corrections, validation, and local browser acceptance.

- Worktree: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2`
- Branch: `akhil/backlog-repeat-issues`
- Starting keeper: `cdfd2debe67a26d9ae0e01dc743c754d68ece2b6`
- Observed `origin/main` and `origin/production`: `2d1353af42c3a652be6cf8a69640468b453f4cea`
- Observed `origin/staging`: absent
- Integrated HEAD: `30ca5d43d978f049f51489b666a2a282d699b029`
- Merge parents: `cdfd2debe67a26d9ae0e01dc743c754d68ece2b6` and `2d1353af42c3a652be6cf8a69640468b453f4cea`

The integration was an ordinary clean `--no-ff` merge of `origin/main`. No conflict resolution or source adaptation was required. Remote drift was rechecked before integration. No protected branch was written.

## Instruction scope

The keeper has narrow uncommitted edits to these active routing documents:

- `.cursor/rules/sandbox-open-feature-review.mdc`
- `.cursor/rules/ship-and-review-gate.mdc`
- `AGENTS.md`
- `docs/agents/AGENTS-akhil.md`
- `docs/agents/deployment-workflow.md`
- `docs/agents/sandbox-open-review.md`
- `docs/ship-gate.md`

It also adds `tests/unit/akhil-release-routing-instructions.test.ts` as a durable routing contract.

The resulting contract is explicit:

- Agents working for Akhil may carry Akhil's own keeper through `main`, `staging`, and `production` only when he explicitly asks to ship.
- They do not write `prakrit`, integrate another developer's keeper, skip staging, force-push, bypass review or QA, or weaken production-data and locked-listing protections.
- Without an explicit ship request, the normal Akhil handoff remains a keeper plus Review URL, followed by a stop for his review.
- With Akhil's explicit ship request, no separate captain or human handoff is required after the normal review and QA gates pass.
- Prakrit's keeper-to-`prakrit` captain ladder and no-mistakes process remain unchanged.
- The operational docs name the actual Vercel project, `proplane` (`prj_rupckw3T2v0oXVg2nTLVCYePKDUc`), preserve `production` as the production branch, and reject a generic Preview deployment because its defaults are shared with production. Staging must use branch-scoped variables.
- The active workflow forbids the current manual deployment wrappers because they are pinned to the retired `axis-2` project. Release actions must use the protected Git workflow. No Vercel relink was performed.

The same seven narrow instruction corrections were mirrored into the original checkout at `/Users/akhilvemuri/coding/AXIS-2`. The original checkout was already dirty and behind; no user-owned hunk was staged, committed, reset, or overwritten. Its pool-worktree section and feature-cycle text were preserved. Mirror `git diff --check` passed.

## Source integrity

The approved PRP-473 implementation remained byte-identical to the starting keeper after the merge. This manager reran `git diff --quiet cdfd2debe67a26d9ae0e01dc743c754d68ece2b6 HEAD -- <13 PRP-473 source files>` and received exit 0 for the complete source set:

- `src/components/portal/pro-tours.tsx`
- `src/lib/agent/leasing-sms-agent.server.ts`
- `src/lib/sms/owner-sms-dispatcher.server.ts`
- `src/lib/sms/tour-sms-eligibility.server.ts`
- `src/lib/tools/context.ts`
- `src/lib/tools/domains/tours.ts`
- `src/lib/tour-inquiry-confirm.server.ts`
- `src/lib/tour-inquiry-create.server.ts`
- `src/lib/tour-inquiry.server.ts`
- `src/lib/tour-notification-delivery.server.ts`
- `src/lib/tour-notifications.ts`
- `src/lib/tour-planned-change.server.ts`
- `src/lib/tour-reschedule-sms-reply.server.ts`

Root independently verified the same complete 13-source set against `cdfd2debe67a26d9ae0e01dc743c754d68ece2b6` with the same unchanged result.

## Validation results

All commands used Node 22 and disabled SMS runtime and the SMS outbox scheduler where applicable. No output was piped through `tail`.

| Gate | Result |
| --- | --- |
| Focused integrated PRP-473 and communication dependencies | exit 0, 15 files, 243 tests, 20.13s |
| Akhil routing contract | exit 0, 1 file, 4 tests; final rerun 205ms |
| Full unit suite | exit 0, 1,376 files, 9,591 tests, 304.47s |
| Integration suite | exit 0, 51 passed and 2 skipped files; 270 passed and 20 skipped tests, 16.95s |
| TypeScript, `npx tsc --noEmit --pretty false --incremental false` | exit 0 |
| Lint, `npm run lint` | exit 0, 0 errors and 726 existing warnings |
| Production build, `npm run build` | exit 0, Next 16.3.4, 385/385 pages; existing middleware deprecation warning only |
| Keeper and original-checkout `git diff --check` | exit 0 |
| `npm run ship:preflight` | exit 1 because remote `staging` is absent |
| `npx graphify hook-rebuild` | exit 1 because no executable was available; no graph artifact was changed |

Exact executed suite commands, with no credentials:

```sh
env PATH=/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin:$PATH NODE_OPTIONS=--max-old-space-size=4096 SMS_RUNTIME_ENABLED=0 SMS_OUTBOX_SCHEDULER_READY=0 npx vitest run tests/unit/tour-lifecycle-sms-provenance.test.ts tests/unit/tour-reschedule-sms-reply.test.ts tests/unit/tour-guest-sms-consent.test.ts tests/unit/prp-473-tour-sms-eligibility.test.ts tests/unit/sms-conversation-log-dispatch.test.ts tests/unit/tour-notifications.test.ts tests/unit/tools/tours.test.ts tests/unit/inbound-email-reply.test.ts tests/unit/email-reply-address.test.ts tests/unit/inbound-email-webhook.test.ts tests/unit/manager-comms-eligibility.test.ts tests/unit/manager-work-email-exposure.test.ts tests/unit/work-contact-announce.test.ts tests/unit/co-manager-own-messaging-identity.test.ts tests/unit/manager-assistant-email-route.test.ts --maxWorkers=1

env PATH=/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin:$PATH NODE_OPTIONS=--max-old-space-size=4096 SMS_RUNTIME_ENABLED=0 SMS_OUTBOX_SCHEDULER_READY=0 npm run test:unit -- --maxWorkers=2

env PATH=/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin:$PATH NODE_OPTIONS=--max-old-space-size=4096 SMS_RUNTIME_ENABLED=0 SMS_OUTBOX_SCHEDULER_READY=0 npm run test:integration -- --maxWorkers=1
```

The preflight's dirty-worktree, absent local shell-variable, parity, and Langfuse lines are warnings, not independent readiness proof or additional hard failures. The missing remote `staging` branch is the actual preflight failure.

The full E2E suite was not run. The nine-case branch smoke is not full E2E, and neither was substituted for it. Staging deployment QA, external provider delivery, and real handset acceptance also remain unrun. These gates are intentionally deferred because production promotion is already blocked and this handoff is keeper-only.

## Integrated browser acceptance

The Playwright browser pass used the canonical dev/test manager and resident accounts, the real portal, and the exact seeded task-owned fixture. No demo data, live listing, production auth, or production data was used.

- Review URL: `http://localhost:3008/portal/tours/upcoming`
- Current dev server: operating-system process chain rooted at npm PID `40153`, Next listener PID `40211`, pinned to port 3008
- Runtime flags: `SMS_RUNTIME_ENABLED=0`, `SMS_OUTBOX_SCHEDULER_READY=0`
- Fixture/event: `80eb0801-755d-4cf8-be15-bff69eafb61c`
- External calendar isolation: manager Google Calendar status returned `connected:false`, `configured:false`, `schemaReady:true`; the event's `googleCalendarEventId` was null
- Notification selection: PropLane inbox only; SMS disabled and email deselected
- Successful mutation: start changed from `2026-09-17T16:00:00.000Z` to `2026-09-17T17:00:00.000Z`; end is `2026-09-17T18:00:00.000Z`
- Persisted notification generation: `e4b60534-703a-4812-a8d5-c396558399e1`
- Resident thread id: `msg_inbox_1788671403204_8yxw`
- Message id: `tour:80eb0801-755d-4cf8-be15-bff69eafb61c:rescheduled:e4b60534-703a-4812-a8d5-c396558399e1`
- Resident browser rendered the complete new-window message; the read-only API check reported `bodyHasNewWindow:true`
- An immediate repeat to the same time returned HTTP 400 with `That is the time this tour is already booked for.` and did not create another generation or message
- Desktop manager, 390 x 844 manager, and resident inbox views were exercised

Root independently verified the persisted dev rows after this pass: the event has the expected owner, 17:00Z to 18:00Z window, and generation; the resident thread has the correct resident owner/scope and exactly one message with the expected id. Root also independently viewed the fresh mobile and resident-inbox captures.

Fresh artifacts:

- `output/playwright/akhil-release-current-preview.png`
- `output/playwright/akhil-release-reschedule-success.png`
- `output/playwright/akhil-release-duplicate-noop.png`
- `output/playwright/akhil-release-mobile-current-tour.png`
- `output/playwright/akhil-release-resident-inbox.png`

The refreshed private dev/test browser states were saved outside Git to `/Users/akhilvemuri/.local/share/proplane-codex/dev-test/`. The directory is mode 700 and both role-state files are mode 600. No credential was printed or committed.

## Production hold

No production deployment or migration was attempted. Root's authenticated read-only readiness work is recorded in `docs/plans/2026-09-10-akhil-release-schema-evidence.md`.

- The actual Vercel `proplane` project has production branch `production` and the expected staging branch-scoped Supabase URL.
- Staging has the representative webhook and account-recovery relations.
- Exact production catalog probes return null for the representative webhook and account-recovery relations.
- Production genuinely lacks the webhook migration plus 11 account-recovery/account-preservation migrations, including their relations and functions. Older version-ledger differences are largely known bundled or renamed history and are not the basis of this hold.

This is a hard production-readiness blocker that requires Akhil's direction and separately authorized protected database remediation. It is not a captain-permission blocker. Do not apply migrations, repair ledgers, promote protected branches, or claim the fix is deployed from this artifact.

## Fresh reviewer handoff

The required fresh Astra reviewer should read the authorized release plan, this handoff, the schema evidence, and the entire final diff. In particular, verify:

1. The seven active routing documents make Akhil's explicit-ship exception unambiguous without changing Prakrit's process or weakening shared safety gates.
2. The new routing contract covers the intended active surfaces.
3. The approved 13 PRP-473 source files remain unchanged from `cdfd2debe67a26d9ae0e01dc743c754d68ece2b6`.
4. The validation and browser evidence support a keeper-ready result only, not production approval.
5. The confirmed production schema omission remains a hard hold.

After fresh approval, root may prepare and push the keeper through the normal fast-forward-safe keeper workflow. Production must remain held until the protected schema-remediation scope is explicitly authorized, performed safely, reconciled, and revalidated through all remaining release gates.
