# Akhil authorized release - fresh Astra review

Date: 2026-09-10. Worktree: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2`. Keeper: `akhil/backlog-repeat-issues`.

## Snapshot and scope

Observed HEAD: `30ca5d43d978f049f51489b666a2a282d699b029`, with parents `cdfd2debe67a26d9ae0e01dc743c754d68ece2b6` and `2d1353af42c3a652be6cf8a69640468b453f4cea`. This review covers the ordinary merge's preservation of the approved PRP-473 implementation, seven uncommitted active routing documents, and untracked `tests/unit/akhil-release-routing-instructions.test.ts`.

The seven documents are `AGENTS.md`, `docs/agents/AGENTS-akhil.md`, `docs/agents/deployment-workflow.md`, `docs/agents/sandbox-open-review.md`, `docs/ship-gate.md`, `.cursor/rules/ship-and-review-gate.mdc`, and `.cursor/rules/sandbox-open-feature-review.mdc`. Their tracked diff is 92 additions / 57 deletions, SHA-256 `caad48dcec8389b4b5b262352c259a6a05034ec83597e23fab36531a48f7b0ee`. The routing test SHA-256 is `4ddc5c14c3b37aaa9ecd378d90c69417eee436afc9caaa0f3217c1acf6888d66`.

Read root and matching Akhil instructions, repository feature cycle and skill, release plan/handoff, schema evidence, readiness audit, ship gate, prior resumed PRP-473 lead/security/Bugbot reports, and the complete scoped routing diff. This fresh lead review did not implement the changes. Only this report was written by this reviewer. No source/test edit, original-checkout write, commit, push, merge, deployment, database/provider operation, credential change, or no-mistakes invocation occurred.

## Assessment

Disposition: approve the reviewed snapshot for keeper handoff and the normal fast-forward-safe keeper commit/push workflow. No correction cycle is required. This is not approval to promote protected release branches or remediate production data.

No actionable correctness, security, or scope defect was established in the reviewed changes. The Akhil exception requires his explicit ship request, applies to his keeper, excludes writing `prakrit`, and retains `main` -> `staging` -> `production`, review, QA, fast-forward promotion, production-data and locked-listing protections. Absent that request, Akhil's keeper and Review URL handoff remains. Prakrit's integration process is retained; `docs/agents/AGENTS-prakrit.md` has no task diff. No runtime authorization, schema, RLS, tool, notification, navigation, cache, rendering, or native behavior is changed by the documentation/test delta.

The verified live Vercel project is consistently documented as `proplane`. The explicit ban on the currently mis-pinned manual deployment wrappers and requirement for staging branch-scoped Preview variables follow the root's read-only configuration evidence. This review does not certify those wrappers or turn their unused state into a release pass.

The routing contract is appropriate for instruction text and passes. It is a guard for selected active wording, not a substitute for manually reading all seven documents and checking the preserved shared constraints.

The mandatory bounded security and Bugbot refreshes each found no actionable finding. Their dated reports are retained at `docs/security/2026-09-10-akhil-release-security-review.md` and `docs/security/2026-09-10-akhil-release-bugbot.md`. This lead independently read their reports and conclusions. Agent slot limits required reusing the prior independent Astra source reviewer for security and the Luna read-only audit delegate for Bugbot; neither implemented the routing changes. The fresh Astra lead phase remained separate. Both delegates independently passed the four-case routing test and diff checks. The security reviewer also independently confirmed the 13-source identity comparison. No unavailable review is represented as completed.

## Independent source and mirror verification

The complete 13 PRP-473 source files are byte-identical to `cdfd2debe67a26d9ae0e01dc743c754d68ece2b6`. Independently ran:

```sh
git diff --quiet cdfd2debe67a26d9ae0e01dc743c754d68ece2b6 HEAD -- src/components/portal/pro-tours.tsx src/lib/agent/leasing-sms-agent.server.ts src/lib/sms/owner-sms-dispatcher.server.ts src/lib/sms/tour-sms-eligibility.server.ts src/lib/tools/context.ts src/lib/tools/domains/tours.ts src/lib/tour-inquiry-confirm.server.ts src/lib/tour-inquiry-create.server.ts src/lib/tour-inquiry.server.ts src/lib/tour-notification-delivery.server.ts src/lib/tour-notifications.ts src/lib/tour-planned-change.server.ts src/lib/tour-reschedule-sms-reply.server.ts
```

Exit 0. `git log -1 --format='%H%n%P'` independently confirmed the exact merge parents. SHA-256 checks of the reply module, reply tests, eligibility resolver, eligibility tests, and lifecycle tests all match the fingerprints retained in the resumed review. The prior source security/Bugbot reviews remain attributable evidence for this unchanged source; they are not approval of production or a new independent audit of every incoming-main feature.

Read-only mirror inspection found five files identical between this keeper and `/Users/akhilvemuri/coding/AXIS-2`. The expected differences in root `AGENTS.md` and `AGENTS-akhil.md` retain the original checkout's pool-worktree instructions and feature-cycle text, and its different preexisting captain-default paragraph. The requested Akhil routing corrections are present in both. Original user-owned dirty scripts and other documents remain present. `git diff --no-index` on those two intentionally differing documents returned 1, as expected. No reviewer pre-edit snapshot exists to independently certify every earlier user hunk; the stronger complete-preservation claim is attributed to the execution handoff.

## Independent validation

```sh
env PATH=/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin:$PATH NODE_OPTIONS=--max-old-space-size=4096 SMS_RUNTIME_ENABLED=0 SMS_OUTBOX_SCHEDULER_READY=0 npx vitest run tests/unit/akhil-release-routing-instructions.test.ts tests/unit/tour-lifecycle-sms-provenance.test.ts tests/unit/tour-reschedule-sms-reply.test.ts tests/unit/prp-473-tour-sms-eligibility.test.ts tests/unit/manager-comms-eligibility.test.ts tests/unit/co-manager-own-messaging-identity.test.ts --maxWorkers=1
```

Exit 0: 6 files, 93 tests, 2.98 seconds. `git diff --check` exited 0 independently in both keeper and original checkout. No broad compiler/build suite was duplicated by this reviewer.

Execution-attributed integrated results in the handoff are full unit 9,591 tests; integration 270 passed / 20 skipped; focused communication/tour dependencies 243 tests; TypeScript, lint, and build exit 0. Lint retains 726 existing warnings. These broad results were not rerun by this reviewer. `ship:preflight` remains reported exit 1 because remote staging is absent. Graph refresh remains reported exit 1 due to unavailable executable; this reviewer independently confirmed no current or legacy graph exists in the pooled tree and made no graph artifact.

Independently viewed `output/playwright/akhil-release-mobile-current-tour.png` and `output/playwright/akhil-release-resident-inbox.png`. The mobile tour shows the changed local-time window with visible reschedule control; the recipient conversation shows the new Pacific-time window and reply composer. Sol's fresh browser mutation/no-op and root's independent exact dev-row read establish the connected positive path, a single notification generation/message, and duplicate rejection. This reviewer did not repeat a browser or database mutation or claim direct provider delivery. The persisted window is September 17, 17:00Z to 18:00Z, generation `e4b60534-703a-4812-a8d5-c396558399e1`, as recorded in the handoff.

## Release holds

This review cannot approve production. Root's authenticated read-only catalog evidence confirms genuine production omissions for the webhook migration and eleven account-recovery/preservation migrations, while representative relations resolve on staging. This finding goes beyond migration timestamp mismatch. The SQL affects triggers, financial constraints, storage and backfill behavior, so the existing no-production-write rule requires a reviewed, explicitly authorized database-remediation scope. Do not bulk replay the apparent 44 version gaps or repair the ledger by assumption.

Full local E2E, recreation and verification of remote staging, staging QA, real provider/handset acceptance, passing release preflight, and eventual exact-commit Vercel/TestFlight distribution checks remain outstanding. No nine-case smoke or keeper review substitutes for them. There is no remaining captain-permission condition for Akhil's authorized release; the hold concerns database safety and unfinished release gates.

Review URL: `http://localhost:3008/portal/tours/upcoming`.
